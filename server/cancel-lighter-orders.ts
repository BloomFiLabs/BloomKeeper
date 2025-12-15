/**
 * Cancel all open orders on Lighter for a specific market
 * Run: npx ts-node cancel-lighter-orders.ts [market_index]
 * Example: npx ts-node cancel-lighter-orders.ts 70
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { SignerClient } from '@reservoir0x/lighter-ts-sdk';

const LIGHTER_API_BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_API_KEY = process.env.LIGHTER_API_KEY || '';
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '1');

async function main() {
  const marketIndex = process.argv[2] ? parseInt(process.argv[2]) : undefined;
  
  console.log('='.repeat(60));
  console.log('Cancel Lighter Open Orders');
  console.log('='.repeat(60));
  console.log(`Account Index: ${ACCOUNT_INDEX}`);
  console.log(`Market Index: ${marketIndex ?? 'ALL'}`);
  console.log('');

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
  console.log('✓ Signer client initialized\n');

  // Cancel all orders
  console.log('Cancelling all orders...');
  try {
    // timeInForce: 0 = GTC, 1 = GTT, 2 = FOK, 3 = IOC
    // time: current timestamp in seconds
    const time = Math.floor(Date.now() / 1000);
    
    // Cancel all GTC orders
    console.log('  Cancelling GTC orders (timeInForce=0)...');
    await signerClient.cancelAllOrders(0, time);
    
    // Cancel all GTT orders  
    console.log('  Cancelling GTT orders (timeInForce=1)...');
    await signerClient.cancelAllOrders(1, time);
    
    console.log('\n✅ Cancel all orders request sent!');
    console.log('   Note: Orders may take a few seconds to be removed from the order book.');
    console.log('   Run test-lighter-open-orders3.ts to verify.\n');
  } catch (error: any) {
    console.error('Failed to cancel orders:', error.message);
    if (error.response?.data) {
      console.error('Response:', error.response.data);
    }
  }
}

main().catch(console.error);

