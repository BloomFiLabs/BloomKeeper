/**
 * Test script to verify Lighter open orders detection
 * Run: npx ts-node test-lighter-open-orders.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { SignerClient, ApiClient } from '@reservoir0x/lighter-ts-sdk';

const LIGHTER_API_BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_API_KEY = process.env.LIGHTER_API_KEY || '';
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '1');

async function main() {
  console.log('='.repeat(60));
  console.log('Testing Lighter Open Orders Detection');
  console.log('='.repeat(60));
  console.log(`Account Index: ${ACCOUNT_INDEX}`);
  console.log(`API Key Index: ${API_KEY_INDEX}`);
  console.log(`Base URL: ${LIGHTER_API_BASE_URL}`);
  console.log('');

  // Step 1: Get account info to find markets with open orders
  console.log('Step 1: Fetching account info...');
  try {
    const accountResponse = await axios.get(`${LIGHTER_API_BASE_URL}/api/v1/account`, {
      params: {
        by: 'index',
        value: String(ACCOUNT_INDEX),
      },
      timeout: 10000,
    });

    if (accountResponse.data.code !== 200) {
      console.error('Account API error:', accountResponse.data);
      return;
    }

    const account = accountResponse.data.accounts?.[0];
    if (!account) {
      console.error('No account found');
      return;
    }

    console.log(`Account status: ${account.status === 1 ? 'active' : 'inactive'}`);
    console.log(`Available balance: $${account.available_balance}`);
    console.log(`Total orders: ${account.total_order_count}`);
    console.log(`Pending orders: ${account.pending_order_count}`);
    console.log('');

    // Find markets with open orders
    const positions = account.positions || [];
    const marketsWithOrders = positions.filter(
      (p: any) => (p.open_order_count || 0) > 0 || (p.pending_order_count || 0) > 0
    );

    console.log('Step 2: Markets with open orders:');
    if (marketsWithOrders.length === 0) {
      console.log('  (none)');
    } else {
      for (const p of marketsWithOrders) {
        console.log(`  Market ${p.market_id} (${p.symbol}): ${p.open_order_count} open, ${p.pending_order_count} pending`);
      }
    }
    console.log('');

    // Step 3: Initialize signer client for auth
    console.log('Step 3: Initializing signer client for authenticated requests...');
    let normalizedKey = LIGHTER_API_KEY;
    if (normalizedKey.startsWith('0x')) {
      normalizedKey = normalizedKey.slice(2);
    }

    const signerClient = new SignerClient({
      url: LIGHTER_API_BASE_URL,
      privateKey: normalizedKey,
      accountIndex: ACCOUNT_INDEX,
      apiKeyIndex: API_KEY_INDEX,
    });

    await signerClient.initialize();
    await signerClient.ensureWasmClient();
    console.log('  Signer client initialized');
    console.log('');

    // Step 4: Get auth token
    const authToken = await signerClient.createAuthTokenWithExpiry(600);
    console.log('Step 4: Auth token created');
    console.log('');

    // Step 5: Query each market with open orders
    console.log('Step 5: Fetching open orders for each market...');
    for (const p of marketsWithOrders) {
      try {
        const response = await axios.get(`${LIGHTER_API_BASE_URL}/api/v1/accountActiveOrders`, {
          params: {
            auth: authToken,
            market_id: p.market_id,
          },
          timeout: 10000,
        });

        console.log(`\n  Market ${p.market_id} (${p.symbol}):`);
        console.log(`    Response code: ${response.data.code}`);
        
        if (response.data.code === 200) {
          const orders = response.data.orders || [];
          console.log(`    Orders count: ${orders.length}`);
          
          for (const order of orders) {
            const side = order.is_ask ? 'SELL' : 'BUY';
            const price = order.price;
            const size = order.size || order.remaining_size;
            const createdTime = order.created_time ? new Date(order.created_time * 1000).toISOString() : 'unknown';
            console.log(`    - ${side} ${size} @ ${price} (created: ${createdTime})`);
          }
        } else {
          console.log(`    Error: ${response.data.message}`);
        }
      } catch (e: any) {
        console.log(`    Failed: ${e.message}`);
      }
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('Test complete!');
    console.log('='.repeat(60));

  } catch (error: any) {
    console.error('Error:', error.message);
    if (error.response?.data) {
      console.error('Response:', error.response.data);
    }
  }
}

main().catch(console.error);

