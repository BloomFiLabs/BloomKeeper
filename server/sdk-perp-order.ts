/**
 * HyperLiquid PERP Order Script - Using SDK
 * 
 * This script places a perp order using the @nktkas/hyperliquid SDK
 * with hardcoded values matching raw-frontend-api-order.ts
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file
 *   2. Run: npx tsx sdk-perp-order.ts
 */

import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter } from '@nktkas/hyperliquid/utils';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// HARDCODED VALUES (matching raw-frontend-api-order.ts)
// ═══════════════════════════════════════════════════════════

const HARDCODED_ORDER = {
  // Asset ID 159 = HYPE perp
  coin: 'HYPE', // SDK uses coin name, not asset ID
  isBuy: true, // SELL/SHORT
  size: '0.4', // Exact size as string
  limitPrice: '34.618', // Exact price as string
  reduceOnly: false, // Set to true if you want to close existing position instead of opening opposite
  timeInForce: 'Gtc' as const, // Immediate or Cancel (requires less margin than GTC)
};

// If you have an existing LONG position and want to SELL, set this to true
// This will close part of your LONG position instead of opening a SHORT
const AUTO_SET_REDUCE_ONLY_IF_OPPOSITE = true;

// ═══════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      HYPERLIQUID PERP ORDER (SDK)                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Check for private key
  const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    console.error('❌ ERROR: PRIVATE_KEY not found in .env file');
    process.exit(1);
  }

  // Get wallet address
  const wallet = new ethers.Wallet(privateKey);
  const walletAddress = wallet.address;

  console.log(`Wallet Address: ${walletAddress}\n`);

  // Initialize SDK
  console.log('📡 Initializing HyperLiquid SDK...');
  const transport = new HttpTransport({ isTestnet: false });
  const exchangeClient = new ExchangeClient({ wallet: privateKey, transport });
  const infoClient = new InfoClient({ transport });
  const symbolConverter = await SymbolConverter.create({ transport });
  console.log('✅ SDK initialized\n');

  // Verify asset ID matches (159 = HYPE perp)
  const assetId = symbolConverter.getAssetId(HARDCODED_ORDER.coin);
  console.log(`🔍 Asset Verification:`);
  console.log(`   Coin: ${HARDCODED_ORDER.coin}`);
  console.log(`   Asset ID: ${assetId}`);
  if (assetId !== 159) {
    console.log(`   ⚠️  WARNING: Asset ID is ${assetId}, expected 159 for HYPE perp`);
  } else {
    console.log(`   ✅ Asset ID matches (159)`);
  }
  console.log('');

  // Check account state
  console.log('💰 Checking Account State...');
  console.log('─'.repeat(60));
  try {
    const clearinghouseState = await infoClient.clearinghouseState({ user: walletAddress });
    const marginSummary = clearinghouseState.marginSummary;
    
    const accountValue = parseFloat(marginSummary.accountValue || '0');
    const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
    const freeCollateral = accountValue - totalMarginUsed;
    
    console.log(`   Account Value: $${accountValue.toFixed(2)}`);
    console.log(`   Margin Used: $${totalMarginUsed.toFixed(2)}`);
    console.log(`   Free Collateral: $${freeCollateral.toFixed(2)}`);
    
    // Check existing positions
    let existingHypePosition: any = null;
    if (clearinghouseState.assetPositions && clearinghouseState.assetPositions.length > 0) {
      console.log(`\n   Existing Positions:`);
      clearinghouseState.assetPositions.forEach((pos: any) => {
        const size = parseFloat(pos.position.szi || '0');
        if (size !== 0) {
          const coin = pos.position.coin;
          const marginUsed = parseFloat(pos.position.marginUsed || '0');
          const unrealizedPnl = parseFloat(pos.position.unrealizedPnl || '0');
          console.log(`     Asset ${coin}: ${size > 0 ? 'LONG' : 'SHORT'} ${Math.abs(size)}`);
          console.log(`       Margin Used: $${marginUsed.toFixed(2)}`);
          console.log(`       Unrealized PnL: $${unrealizedPnl.toFixed(2)}`);
          
          // Check if this is the same asset we're trading
          // Position coin can be asset ID (number) or coin name (string)
          if (coin === assetId || coin === 'HYPE' || coin === 159 || String(coin) === String(assetId)) {
            existingHypePosition = { size, coin, marginUsed, unrealizedPnl };
            console.log(`     Found matching position: coin=${coin} (type: ${typeof coin}), assetId=${assetId}`);
          }
        }
      });
      
      // Check if order direction conflicts with existing position
      if (existingHypePosition) {
        const existingSize = existingHypePosition.size; // Can be positive (LONG) or negative (SHORT)
        const existingIsLong = existingSize > 0;
        const orderIsBuy = HARDCODED_ORDER.isBuy;
        
        console.log(`\n   ⚠️  POSITION ANALYSIS:`);
        console.log(`     Existing Position: ${existingIsLong ? 'LONG' : 'SHORT'} ${Math.abs(existingSize)} HYPE (raw: ${existingSize})`);
        console.log(`     New Order: ${orderIsBuy ? 'BUY (LONG)' : 'SELL (SHORT)'} ${HARDCODED_ORDER.size} HYPE`);
        console.log(`     Reduce Only: ${HARDCODED_ORDER.reduceOnly}`);
        
        // For reduce-only orders: order direction must be OPPOSITE to position direction
        // LONG position (positive) -> SELL (isBuy=false) to reduce
        // SHORT position (negative) -> BUY (isBuy=true) to reduce
        if (HARDCODED_ORDER.reduceOnly) {
          const correctDirection = existingIsLong ? false : true; // LONG needs SELL, SHORT needs BUY
          if (orderIsBuy !== correctDirection) {
            console.log(`     ❌ ERROR: Reduce-only order direction is wrong!`);
            console.log(`     💡 For ${existingIsLong ? 'LONG' : 'SHORT'} position, need ${correctDirection ? 'BUY' : 'SELL'} to reduce`);
            console.log(`     💡 Auto-correcting order direction...`);
            HARDCODED_ORDER.isBuy = correctDirection;
            console.log(`     ✅ Changed to: ${HARDCODED_ORDER.isBuy ? 'BUY' : 'SELL'}`);
          } else {
            console.log(`     ✅ Order direction is correct for reducing ${existingIsLong ? 'LONG' : 'SHORT'} position`);
          }
          
          // Verify the order will actually reduce the position
          const orderSize = parseFloat(HARDCODED_ORDER.size);
          const existingSizeAbs = Math.abs(existingSize);
          
          if (orderSize > existingSizeAbs) {
            console.log(`     ❌ ERROR: Order size (${orderSize}) > existing position (${existingSizeAbs})`);
            console.log(`     💡 Reduce-only orders cannot be larger than existing position`);
            console.log(`     💡 Reducing order size to ${existingSizeAbs}...`);
            HARDCODED_ORDER.size = existingSizeAbs.toFixed(4);
          } else {
            console.log(`     ✅ Order size (${orderSize}) <= existing position (${existingSizeAbs}) - OK`);
          }
        } else {
          // Not reduce-only: check for conflicts
          if ((existingIsLong && !orderIsBuy) || (!existingIsLong && orderIsBuy)) {
            console.log(`     ❌ This would create OPPOSITE positions (hedge)`);
            console.log(`     💡 Solution: Set reduceOnly: true to close existing position`);
            console.log(`     💡 Or: Close existing position first, then open new one`);
            
            // Auto-set reduceOnly if enabled
            if (AUTO_SET_REDUCE_ONLY_IF_OPPOSITE) {
              console.log(`\n     ⚠️  AUTO-SETTING reduceOnly: true (to close existing position)`);
              HARDCODED_ORDER.reduceOnly = true;
              // Also fix the direction
              HARDCODED_ORDER.isBuy = existingIsLong ? false : true;
              console.log(`     ✅ Auto-set direction to: ${HARDCODED_ORDER.isBuy ? 'BUY' : 'SELL'}`);
            }
          } else {
            console.log(`     ✅ Same direction - will increase position size`);
          }
        }
      }
    }
    
    // Calculate required margin - try different leverage assumptions
    const orderNotional = parseFloat(HARDCODED_ORDER.size) * parseFloat(HARDCODED_ORDER.limitPrice);
    console.log(`\n   Order Requirements:`);
    console.log(`     Notional Value: $${orderNotional.toFixed(2)}`);
    
    // Try different leverage scenarios
    for (const leverage of [10, 5, 3, 2, 1.5]) {
      const requiredMargin = orderNotional / leverage;
      console.log(`     At ${leverage}x leverage: $${requiredMargin.toFixed(2)} margin needed`);
    }
    
    // GTC orders might require more conservative margin
    const conservativeLeverage = 5; // Use 5x instead of 10x for safety
    const requiredMargin = orderNotional / conservativeLeverage;
    const safetyBuffer = requiredMargin * 0.3; // 30% buffer for GTC orders
    const totalMarginNeeded = requiredMargin + safetyBuffer;
    
    console.log(`\n   Estimated Margin Needed (5x leverage + 30% buffer): $${totalMarginNeeded.toFixed(2)}`);
    
    if (totalMarginNeeded > freeCollateral) {
      console.log(`   ❌ INSUFFICIENT MARGIN: Need $${totalMarginNeeded.toFixed(2)}, have $${freeCollateral.toFixed(2)}`);
      console.log(`   Shortfall: $${(totalMarginNeeded - freeCollateral).toFixed(2)}`);
    } else {
      console.log(`   ✅ Margin calculation shows sufficient, but HyperLiquid may require more`);
      console.log(`   ⚠️  Try reducing order size or using IOC instead of GTC`);
    }
    console.log('');
  } catch (error: any) {
    console.log(`   ⚠️  Could not check balances: ${error.message}\n`);
  }

  // Display order details
  console.log('📋 Order Details:');
  console.log('─'.repeat(60));
  console.log(`   Coin: ${HARDCODED_ORDER.coin} (Asset ID: ${assetId})`);
  console.log(`   Side: ${HARDCODED_ORDER.isBuy ? 'BUY' : 'SELL'}`);
  console.log(`   Size: ${HARDCODED_ORDER.size}`);
  console.log(`   Price: $${HARDCODED_ORDER.limitPrice}`);
  console.log(`   Time in Force: ${HARDCODED_ORDER.timeInForce}`);
  console.log(`   Reduce Only: ${HARDCODED_ORDER.reduceOnly}`);
  console.log('');

  // Place order using SDK
  console.log('📤 Placing Order via SDK...');
  console.log('─'.repeat(60));
  console.log('');

  try {
    const result = await exchangeClient.order({
      orders: [{
        a: assetId!,
        b: HARDCODED_ORDER.isBuy,
        p: HARDCODED_ORDER.limitPrice,
        r: HARDCODED_ORDER.reduceOnly,
        s: HARDCODED_ORDER.size,
        t: { limit: { tif: HARDCODED_ORDER.timeInForce } },
      }],
      grouping: 'na',
    });

    console.log('📥 Order Response:');
    console.log('─'.repeat(60));
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    // Check order status
    if (result.status === 'ok' && result.response?.type === 'order') {
      const status = result.response.data.statuses[0];
      
      if ('filled' in status && status.filled) {
        console.log('✅ ORDER FILLED!');
        console.log(`   Filled Size: ${status.filled.totalSz}`);
        console.log(`   Average Price: $${status.filled.avgPx}`);
        console.log(`   Order ID: ${status.filled.oid}`);
      } else if ('resting' in status && status.resting) {
        console.log('⏳ ORDER RESTING (waiting to be filled)');
        console.log(`   Order ID: ${status.resting.oid}`);
      } else if ('error' in status && status.error) {
        console.log('❌ ORDER ERROR:');
        const errorMsg = typeof status.error === 'string' ? status.error : JSON.stringify(status.error);
        console.log(`   ${errorMsg}`);
      }
    } else {
      console.log('⚠️  Unexpected response format');
      console.log(JSON.stringify(result, null, 2));
    }

  } catch (error: any) {
    console.error('\n❌ ORDER FAILED:');
    console.error(`   ${error.message}`);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }

  console.log('\n✅ Script completed!');
}

// Run the script
main().catch((error) => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});

