/**
 * Cancel individual orders on Lighter
 */

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
  console.log('Cancel Lighter Orders Individually');
  console.log('='.repeat(60));

  let normalizedKey = LIGHTER_API_KEY;
  if (normalizedKey.startsWith('0x')) normalizedKey = normalizedKey.slice(2);

  const signerClient = new SignerClient({
    url: LIGHTER_API_BASE_URL,
    privateKey: normalizedKey,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX,
  });

  await signerClient.initialize();
  await signerClient.ensureWasmClient();
  const authToken = await signerClient.createAuthTokenWithExpiry(600);
  console.log('✓ Authenticated\n');

  // Get all open orders
  const response = await axios.get(`${LIGHTER_API_BASE_URL}/api/v1/accountActiveOrders`, {
    params: {
      auth: authToken,
      market_id: 70,
      account_index: ACCOUNT_INDEX,
    },
    timeout: 10000,
  });

  if (response.data.code !== 200) {
    console.error('Failed to get orders:', response.data);
    return;
  }

  const orders = response.data.orders || [];
  console.log(`Found ${orders.length} orders to cancel\n`);

  // Cancel each order individually
  for (const order of orders) {
    const orderId = order.order_index || order.order_id;
    const price = order.price;
    const size = order.remaining_base_amount;
    const side = order.is_ask ? 'SELL' : 'BUY';
    
    console.log(`Cancelling: ${side} ${size} @ ${price} (ID: ${orderId})`);
    
    try {
      // Use cancelOrder method from SDK
      const result = await (signerClient as any).cancelOrder({
        marketIndex: 70,
        orderIndex: parseInt(orderId),
      });
      console.log(`  ✓ Cancel submitted: ${JSON.stringify(result).substring(0, 100)}`);
    } catch (e: any) {
      console.log(`  ✗ Failed: ${e.message}`);
    }
    
    // Wait a bit between cancellations
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n✅ Done! Verify with test-lighter-open-orders3.ts');
}

main().catch(console.error);

