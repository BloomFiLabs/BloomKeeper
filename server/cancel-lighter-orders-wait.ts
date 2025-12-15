/**
 * Cancel individual orders on Lighter with transaction wait
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
  console.log('Cancel Lighter Orders With Wait');
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

  if (orders.length === 0) {
    console.log('No orders to cancel!');
    return;
  }

  // Cancel each order individually with transaction wait
  for (const order of orders) {
    const orderId = order.order_index || order.order_id;
    const price = order.price;
    const size = order.remaining_base_amount;
    const side = order.is_ask ? 'SELL' : 'BUY';
    
    console.log(`Cancelling: ${side} ${size} @ ${price} (ID: ${orderId})`);
    
    try {
      // Cancel and get transaction hash
      const result = await (signerClient as any).cancelOrder({
        marketIndex: 70,
        orderIndex: parseInt(orderId),
      });
      
      // Extract transaction hash from result
      let txHash: string | null = null;
      if (Array.isArray(result) && result.length > 0) {
        txHash = result[0]?.TxHash || result[0]?.txHash;
      } else if (typeof result === 'string') {
        txHash = result;
      }
      
      console.log(`  Transaction: ${txHash || JSON.stringify(result).substring(0, 80)}`);
      
      // Wait for transaction to be confirmed
      if (txHash) {
        try {
          console.log('  Waiting for confirmation...');
          await signerClient.waitForTransaction(txHash, 30000, 2000);
          console.log('  ✓ Confirmed');
        } catch (waitError: any) {
          console.log(`  ⚠️ Wait failed: ${waitError.message}`);
        }
      }
    } catch (e: any) {
      console.log(`  ✗ Failed: ${e.message}`);
    }
    
    // Wait between cancellations
    await new Promise(r => setTimeout(r, 1000));
  }

  // Verify
  console.log('\n📊 Verifying...');
  await new Promise(r => setTimeout(r, 3000));
  
  const verifyResponse = await axios.get(`${LIGHTER_API_BASE_URL}/api/v1/account`, {
    params: { by: 'index', value: String(ACCOUNT_INDEX) },
    timeout: 10000,
  });
  
  const account = verifyResponse.data.accounts?.[0];
  const positions = account?.positions || [];
  const yzyPosition = positions.find((p: any) => p.market_id === 70);
  
  console.log(`YZY open orders: ${yzyPosition?.open_order_count || 0}`);
  console.log('\n✅ Done!');
}

main().catch(console.error);

