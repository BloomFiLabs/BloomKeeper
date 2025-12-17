/**
 * Quick script to check Lighter balances and positions
 */

import { SignerClient, ApiClient, AccountApi } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const API_PRIVATE_KEY = process.env.LIGHTER_API_KEY || '';
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '2');
const BASE_URL = process.env.LIGHTER_BASE_URL || 'https://mainnet.zklighter.elliot.ai';

async function main() {
  console.log('🔍 Lighter Balance Check\n');
  console.log('Configuration:');
  console.log(`  Account Index: ${ACCOUNT_INDEX}`);
  console.log(`  API Key Index: ${API_KEY_INDEX}\n`);

  const signerClient = new SignerClient({
    url: BASE_URL,
    privateKey: API_PRIVATE_KEY,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX
  });

  await signerClient.initialize();
  await signerClient.ensureWasmClient();

  const authToken = await signerClient.createAuthTokenWithExpiry(600);

  // Get account info
  console.log('📊 Account Info:');
  try {
    const accountApi = new AccountApi({ host: BASE_URL });
    const accountInfo = await accountApi.getAccount({ 
      accountIndex: ACCOUNT_INDEX,
      auth: authToken
    } as any);
    console.log(JSON.stringify(accountInfo, null, 2));
  } catch (error: any) {
    console.log('Account API error:', error.message);
  }

  // Get balance from direct API - need to use account endpoint with by=index and value=accountIndex
  console.log('\n📊 Balance from API:');
  try {
    const response = await axios.get(`${BASE_URL}/api/v1/account`, {
      params: {
        by: 'index',
        value: String(ACCOUNT_INDEX)
      },
      timeout: 30000
    });
    
    if (response.data) {
      console.log(JSON.stringify(response.data, null, 2));
      
      if (response.data.collateral !== undefined) {
        const balance = parseFloat(response.data.collateral);
        console.log(`\n💰 Collateral Balance: $${balance.toFixed(2)}`);
      }
      if (response.data.usdc_balance !== undefined) {
        const balance = parseInt(response.data.usdc_balance) / 1e6;
        console.log(`💰 USDC Balance: $${balance.toFixed(2)}`);
      }
    }
  } catch (error: any) {
    console.log('Balance API error:', error.response?.data || error.message);
  }

  // Get positions
  console.log('\n📊 Positions:');
  try {
    const response = await axios.get(`${BASE_URL}/api/v1/positions`, {
      params: {
        account_index: ACCOUNT_INDEX,
        auth: authToken
      },
      timeout: 30000
    });
    
    if (response.data && response.data.positions) {
      const positions = response.data.positions;
      if (positions.length === 0) {
        console.log('  No open positions');
      } else {
        for (const pos of positions) {
          console.log(`  ${pos.market_symbol || pos.market_index}: Size ${pos.base_amount}, Entry ${pos.entry_price}`);
        }
      }
    } else {
      console.log('  No positions data');
    }
  } catch (error: any) {
    console.log('Positions API error:', error.response?.data || error.message);
  }

  // Check fast withdraw pool status over time
  console.log('\n📊 Fast Withdraw Pool Status:');
  for (let i = 0; i < 3; i++) {
    const poolResponse = await axios.get(`${BASE_URL}/api/v1/fastwithdraw/info`, {
      params: { account_index: ACCOUNT_INDEX, auth: authToken },
      timeout: 30000,
    });
    
    const limit = parseInt(poolResponse.data.withdraw_limit || '0');
    console.log(`  Pool limit: $${(limit / 1e6).toFixed(2)} USDC`);
    
    if (i < 2) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Calculate what we can actually withdraw
  console.log('\n📊 Summary:');
  console.log('  The fast withdraw pool has very limited funds (~$0.33)');
  console.log('  This is a shared pool across ALL Lighter users');
  console.log('  Options:');
  console.log('    1. Wait for the pool to refill (could take time)');
  console.log('    2. Use standard L1 withdrawal (slower, ~hours)');
  console.log('    3. Transfer to a different exchange first');
}

main().catch(console.error);

