import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { SignerClient } from '@reservoir0x/lighter-ts-sdk';

const LIGHTER_API_BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_API_KEY = process.env.LIGHTER_API_KEY || '';
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '1');

async function main() {
  console.log('='.repeat(60));
  console.log('Testing Complete Open Orders Flow');
  console.log('='.repeat(60));

  let normalizedKey = LIGHTER_API_KEY;
  if (normalizedKey.startsWith('0x')) normalizedKey = normalizedKey.slice(2);

  // Step 1: Get account info
  console.log('\n1. Fetching account info...');
  const accountResponse = await axios.get(`${LIGHTER_API_BASE_URL}/api/v1/account`, {
    params: { by: 'index', value: String(ACCOUNT_INDEX) },
    timeout: 10000,
  });

  const account = accountResponse.data.accounts?.[0];
  const positions = account?.positions || [];
  const marketsWithOrders = positions
    .filter((p: any) => (p.open_order_count || 0) > 0)
    .map((p: any) => ({ market_id: p.market_id, symbol: p.symbol, count: p.open_order_count }));

  console.log(`   Found ${marketsWithOrders.length} market(s) with open orders`);
  for (const m of marketsWithOrders) {
    console.log(`   - Market ${m.market_id} (${m.symbol}): ${m.count} orders`);
  }

  if (marketsWithOrders.length === 0) {
    console.log('\n   No open orders found!');
    return;
  }

  // Step 2: Initialize auth
  console.log('\n2. Initializing authentication...');
  const signerClient = new SignerClient({
    url: LIGHTER_API_BASE_URL,
    privateKey: normalizedKey,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX,
  });
  await signerClient.initialize();
  await signerClient.ensureWasmClient();
  const authToken = await signerClient.createAuthTokenWithExpiry(600);
  console.log('   Auth token created');

  // Step 3: Fetch orders
  console.log('\n3. Fetching order details...');
  const allOrders: Array<{orderId: string; symbol: string; side: string; price: number; size: number; filled: number; ageMinutes: number}> = [];

  for (const m of marketsWithOrders) {
    const response = await axios.get(`${LIGHTER_API_BASE_URL}/api/v1/accountActiveOrders`, {
      params: {
        auth: authToken,
        market_id: m.market_id,
        account_index: ACCOUNT_INDEX,
      },
      timeout: 10000,
    });

    if (response.data.code === 200) {
      const orders = response.data.orders || [];
      for (const o of orders) {
        const side = o.is_ask ? 'SELL' : 'BUY';
        const price = parseFloat(o.price);
        const size = parseFloat(o.remaining_base_amount || o.initial_base_amount);
        const filled = parseFloat(o.filled_base_amount || '0');
        
        let timestamp = new Date();
        const clientOrderId = o.client_order_id || o.client_order_index;
        if (clientOrderId && clientOrderId > 1700000000000 && clientOrderId < 2000000000000) {
          timestamp = new Date(clientOrderId);
        }
        
        allOrders.push({
          orderId: o.order_id,
          symbol: m.symbol,
          side,
          price,
          size,
          filled,
          ageMinutes: Math.round((Date.now() - timestamp.getTime()) / 60000),
        });
      }
    }
  }

  console.log(`\n   Total orders: ${allOrders.length}`);
  console.log('\n4. Order details:');
  console.log('-'.repeat(80));
  for (const o of allOrders) {
    console.log(`   ${o.symbol} ${o.side} ${o.size} @ ${o.price} | Filled: ${o.filled} | Age: ~${o.ageMinutes} min`);
  }
  console.log('-'.repeat(80));

  // Step 5: Check for duplicates
  console.log('\n5. Duplicate check:');
  const grouped: Record<string, typeof allOrders> = {};
  for (const o of allOrders) {
    const key = `${o.symbol}-${o.side}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(o);
  }

  for (const [key, orders] of Object.entries(grouped)) {
    if (orders.length > 1) {
      console.log(`   ⚠️ DUPLICATE: ${key} has ${orders.length} orders!`);
      for (const o of orders) {
        console.log(`      - ${o.size} @ ${o.price} (~${o.ageMinutes} min old)`);
      }
    } else {
      console.log(`   ✓ ${key}: 1 order`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

main().catch(console.error);
