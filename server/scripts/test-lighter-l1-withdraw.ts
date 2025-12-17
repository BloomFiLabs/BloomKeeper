/**
 * Test script for Lighter L1 (slow) withdrawal
 * This uses the standard withdrawal mechanism that doesn't depend on the fast pool
 */

import { SignerClient } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const API_PRIVATE_KEY = process.env.LIGHTER_API_KEY || '';
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '2');
const BASE_URL = process.env.LIGHTER_BASE_URL || 'https://mainnet.zklighter.elliot.ai';

async function main() {
  console.log('🔍 Lighter L1 Withdrawal Test\n');
  
  const WITHDRAW_AMOUNT = 5; // Test with 5 USDC
  
  console.log(`Testing L1 withdrawal of $${WITHDRAW_AMOUNT} USDC`);
  console.log('Note: L1 withdrawals take longer but dont use the fast pool\n');

  const signerClient = new SignerClient({
    url: BASE_URL,
    privateKey: API_PRIVATE_KEY,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX
  });

  await signerClient.initialize();
  await signerClient.ensureWasmClient();
  console.log('✅ Signer client initialized\n');

  // Check available balance first
  const authToken = await signerClient.createAuthTokenWithExpiry(600);
  
  const accountResp = await axios.get(`${BASE_URL}/api/v1/account`, {
    params: { by: 'index', value: String(ACCOUNT_INDEX) },
    timeout: 30000
  });
  
  const availableBalance = parseFloat(accountResp.data.accounts?.[0]?.available_balance || '0');
  console.log(`Available balance: $${availableBalance.toFixed(2)}`);
  
  if (availableBalance < WITHDRAW_AMOUNT) {
    console.log(`❌ Insufficient available balance for withdrawal`);
    console.log(`   Need: $${WITHDRAW_AMOUNT}, Have: $${availableBalance.toFixed(2)}`);
    return;
  }

  console.log('\n📤 Attempting L1 withdrawal...');
  
  try {
    // The SDK's withdraw method handles L1 withdrawals
    const [tx, txHash, error] = await (signerClient as any).withdraw({
      usdcAmount: WITHDRAW_AMOUNT,
      nonce: -1 // Auto-fetch nonce
    });

    if (error) {
      console.log(`❌ Withdrawal error: ${error}`);
      return;
    }

    console.log(`✅ Withdrawal submitted!`);
    console.log(`   TX Hash: ${txHash}`);
    console.log(`   Amount: $${WITHDRAW_AMOUNT} USDC`);
    console.log('\n⏳ Waiting for confirmation (up to 2 minutes)...');
    
    try {
      await signerClient.waitForTransaction(txHash, 120000, 5000);
      console.log('✅ Withdrawal confirmed!');
      console.log('   Note: Funds will arrive on L1 (Arbitrum) in a few hours');
    } catch (waitError: any) {
      console.log(`⚠️ Confirmation wait timed out: ${waitError.message}`);
      console.log('   The transaction may still be processing...');
    }

  } catch (error: any) {
    console.error('❌ Withdrawal exception:', error.message);
    
    // Check if the error is about the WASM signer
    if (error.message.includes('undefined') || error.message.includes('panic')) {
      console.log('\n⚠️ WASM signer issue detected.');
      console.log('   The SDK withdraw method may not be properly implemented.');
      console.log('   Consider using manual API call instead.');
    }
  }
}

main().catch(console.error);

