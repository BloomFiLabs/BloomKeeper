/**
 * HyperLiquid Order Script - Full SDK (TypeScript)
 * 
 * This script uses the @nktkas/hyperliquid SDK's ExchangeClient
 * which handles ALL the complexity: signing, request formatting, etc.
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file
 *   2. Modify the order parameters below
 *   3. Run: npx tsx sdk-order-simple.ts
 */

import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter } from '@nktkas/hyperliquid/utils';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// ORDER CONFIGURATION - Modify these values
// ═══════════════════════════════════════════════════════════

const ORDER_CONFIG = {
  coin: 'HYPE', // Asset name
  isBuy: true, // true = BUY/LONG, false = SELL/SHORT
  size: 0.4, // Order size
  limitPrice: 35.084, // Limit price
  reduceOnly: false, // true = only close positions
  // Order types available:
  // - 'Ioc' - Immediate or Cancel (executes immediately or cancels)
  // - 'Gtc' - Good Till Cancel (stays on order book)
  // - 'Alo' - Add Liquidity Only / Post Only (maker order, gets rebate)
  timeInForce: 'Ioc' as const, // 'Ioc' | 'Gtc' | 'Alo'
  vaultAddress: null as string | null, // Sub-account address (null for main account)
};

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   HYPERLIQUID ORDER (FULL SDK - TYPESCRIPT)            ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY not found in .env file');
  }

  const wallet = new ethers.Wallet(privateKey);
  const walletAddress = wallet.address;

  console.log(`✅ Wallet address: ${walletAddress}`);
  console.log('');

  // Note: We pass privateKey directly to ExchangeClient, not the wallet object
  // The SDK handles wallet creation internally

  // Initialize SDK clients - let the SDK do ALL the work
  console.log('📡 Initializing HyperLiquid SDK...');
  const transport = new HttpTransport({ isTestnet: false });
  const infoClient = new InfoClient({ transport });
  const exchangeClient = new ExchangeClient({ 
    wallet: privateKey, 
    transport,
    vaultAddress: ORDER_CONFIG.vaultAddress || undefined,
  });
  const symbolConverter = await SymbolConverter.create({ transport });
  console.log('✅ SDK initialized');
  console.log('');

  // Check account state
  console.log('💰 Checking Account State...');
  try {
    const clearinghouseState = await infoClient.clearinghouseState({ user: walletAddress });
    const marginSummary = clearinghouseState.marginSummary;
    const accountValue = parseFloat(marginSummary.accountValue || '0');
    const marginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
    const freeCollateral = accountValue - marginUsed;

    console.log(`   Account Value: $${accountValue.toFixed(2)}`);
    console.log(`   Margin Used: $${marginUsed.toFixed(2)}`);
    console.log(`   Free Collateral: $${freeCollateral.toFixed(2)}`);

    // Check if using cross margin
    const crossMargin = clearinghouseState.crossMarginSummary;
    if (crossMargin) {
      console.log(`   Margin Mode: CROSS MARGIN`);
      console.log(`   Cross Margin Value: $${parseFloat(crossMargin.accountValue || '0').toFixed(2)}`);
    } else {
      console.log(`   Margin Mode: ISOLATED MARGIN (or no positions)`);
    }
    console.log('');
  } catch (error: any) {
    console.log(`   ⚠️  Could not check account state: ${error.message}`);
    console.log('');
  }

  // Get asset ID
  console.log('🔍 Getting Asset ID...');
  const assetId = symbolConverter.getAssetId(ORDER_CONFIG.coin);
  console.log(`   Asset: ${ORDER_CONFIG.coin} (Asset ID: ${assetId})`);
  console.log('');

  // Show order type info
  console.log('📋 Order Details:');
  console.log(`   Coin: ${ORDER_CONFIG.coin}`);
  console.log(`   Side: ${ORDER_CONFIG.isBuy ? 'BUY' : 'SELL'}`);
  console.log(`   Size: ${ORDER_CONFIG.size}`);
  console.log(`   Price: $${ORDER_CONFIG.limitPrice}`);
  console.log(`   Time in Force: ${ORDER_CONFIG.timeInForce}`);
  console.log(`   Reduce Only: ${ORDER_CONFIG.reduceOnly}`);
  
  if (ORDER_CONFIG.timeInForce === 'Ioc') {
    console.log(`   → IOC: Executes immediately or cancels (requires less margin)`);
  } else if (ORDER_CONFIG.timeInForce === 'Gtc') {
    console.log(`   → GTC: Stays on order book until filled or canceled (requires more margin)`);
  } else if (ORDER_CONFIG.timeInForce === 'Alo') {
    console.log(`   → ALO: Post Only - adds liquidity, gets maker rebate (requires less margin)`);
  }
  console.log('');

  // Let the SDK handle everything - it will sign and format the request correctly
  console.log('🔐 SDK is handling signing and request formatting...');
  console.log('   (The SDK handles: msgpack encoding, EIP-712 signing, field ordering, etc.)');
  console.log('');

  // Use the SDK's order method - it does EVERYTHING
  // This internally calls sign_l1_action with the correct parameters
  const result = await exchangeClient.order({
    orders: [{
      a: assetId,
      b: ORDER_CONFIG.isBuy,
      p: ORDER_CONFIG.limitPrice.toString(),
      s: ORDER_CONFIG.size.toString(),
      r: ORDER_CONFIG.reduceOnly,
      t: { limit: { tif: ORDER_CONFIG.timeInForce } },
    }],
    grouping: 'na',
  });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('📤 SDK RESPONSE:');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(JSON.stringify(result, null, 2));
  console.log('');

  if (result.status === 'ok') {
    console.log('✅ ORDER PLACED SUCCESSFULLY!');
    if (result.response?.data?.statuses) {
      result.response.data.statuses.forEach((status: any, index: number) => {
        if (status.resting) {
          console.log(`   Order ${index}: Resting (Order ID: ${status.resting.oid || 'N/A'})`);
        } else if (status.filled) {
          console.log(`   Order ${index}: Filled!`);
          console.log(`      Size: ${status.filled.totalSz}`);
          console.log(`      Avg Price: $${status.filled.avgPx || 'N/A'}`);
          console.log(`      Order ID: ${status.filled.oid || 'N/A'}`);
        } else if (status.error) {
          console.log(`   Order ${index}: Error - ${status.error}`);
        }
      });
    }
  } else {
    console.log('❌ ORDER FAILED');
    console.log(`   Response: ${JSON.stringify(result.response || 'Unknown error', null, 2)}`);
  }

  console.log('');
  console.log('💡 Note: The SDK handled all the complexity automatically!');
  console.log('   No manual signature generation needed.');
}

main().catch(console.error);

