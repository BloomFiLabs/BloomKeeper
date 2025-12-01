/**
 * Simple HyperLiquid Order Script
 * 
 * This is a minimal, standalone script to place a single order on HyperLiquid.
 * Uses @nktkas/hyperliquid SDK
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file
 *   2. Modify the order parameters below (coin, side, size, price)
 *   3. Run: npx tsx simple-hyperliquid-order.ts
 */

import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter, formatSize, formatPrice } from '@nktkas/hyperliquid/utils';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION - Modify these values
// ═══════════════════════════════════════════════════════════

const ORDER_CONFIG = {
  // Asset to trade (e.g., 'ETH', 'BTC', 'HYPE')
  // For perps: 'ETH', 'BTC', etc.
  coin: 'ETH',
  
  // Order side: true = buy/long, false = sell/short
  isBuy: true,
  
  // Order size (in base asset units, e.g., 0.1 ETH)
  size: 0.01,
  
  // Limit price (in USD, e.g., 3000.50)
  limitPrice: 3000,
  
  // Order type: 'Ioc' (Immediate or Cancel), 'Gtc' (Good Till Cancel), or 'FrontendMarket' (market order via frontend)
  timeInForce: 'Gtc' as 'Ioc' | 'Gtc' | 'FrontendMarket',
  
  // Reduce only: true = only close positions, false = can open new positions
  reduceOnly: false,
};

// ═══════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         SIMPLE HYPERLIQUID ORDER SCRIPT                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Check for private key
  const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    console.error('❌ ERROR: PRIVATE_KEY not found in .env file');
    console.error('   Please set PRIVATE_KEY in your .env file');
    process.exit(1);
  }

  // Get wallet address
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(privateKey);
  const walletAddress = wallet.address;

  console.log(`Wallet Address: ${walletAddress}\n`);

  // Initialize transport
  console.log('📡 Initializing HyperLiquid SDK...');
  const transport = new HttpTransport({ isTestnet: false });
  
  // Initialize clients
  const exchangeClient = new ExchangeClient({ wallet: privateKey, transport });
  const infoClient = new InfoClient({ transport });
  
  // Initialize SymbolConverter for proper formatting
  console.log('📐 Initializing SymbolConverter...');
  const symbolConverter = await SymbolConverter.create({ transport });
  console.log('✅ SDK initialized\n');

  // Determine if this is a perp or spot order
  const isPerp = !ORDER_CONFIG.coin.includes('-SPOT');
  const side = ORDER_CONFIG.isBuy ? 'BUY' : 'SELL';
  const positionType = isPerp ? 'PERP' : 'SPOT';

  // Get current market price (optional)
  try {
    console.log('📊 Fetching market data...');
    const allMidsData = await infoClient.allMids();
    const markPrice = parseFloat(allMidsData[ORDER_CONFIG.coin] || '0');
    if (markPrice > 0) {
      console.log(`   ${ORDER_CONFIG.coin} Mark Price: $${markPrice.toFixed(2)}`);
      console.log(`   Your limit price: $${ORDER_CONFIG.limitPrice}`);
      if (ORDER_CONFIG.isBuy && ORDER_CONFIG.limitPrice > markPrice * 1.1) {
        console.log(`   ⚠️  Warning: Buy limit price is >10% above market`);
      } else if (!ORDER_CONFIG.isBuy && ORDER_CONFIG.limitPrice < markPrice * 0.9) {
        console.log(`   ⚠️  Warning: Sell limit price is >10% below market`);
      }
    }
    console.log('');
  } catch (error: any) {
    console.log(`   ℹ️  Market data unavailable (this is OK)\n`);
  }

  // Check balances and positions (for perp orders)
  let freeCollateral = 0;
  if (isPerp) {
    console.log('💰 Checking account balances and positions...');
    console.log('─'.repeat(60));
    
    try {
      const clearinghouseState = await infoClient.clearinghouseState({ user: walletAddress });
      const marginSummary = clearinghouseState.marginSummary;
      
      const accountValue = parseFloat(marginSummary.accountValue || '0');
      const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
      freeCollateral = accountValue - totalMarginUsed;
      
      console.log(`   Account Value: $${accountValue.toFixed(2)}`);
      console.log(`   Margin Used: $${totalMarginUsed.toFixed(2)}`);
      console.log(`   Free Collateral: $${freeCollateral.toFixed(2)}`);
      
      // Check existing positions
      if (clearinghouseState.assetPositions && clearinghouseState.assetPositions.length > 0) {
        console.log(`\n   Existing Positions:`);
        clearinghouseState.assetPositions.forEach((pos: any) => {
          const size = parseFloat(pos.position.szi || '0');
          if (size !== 0) {
            console.log(`     Asset ${pos.position.coin}: ${size > 0 ? 'LONG' : 'SHORT'} ${Math.abs(size)} (Margin: $${parseFloat(pos.position.marginUsed || '0').toFixed(2)})`);
          }
        });
      }
      console.log('');
    } catch (error: any) {
      console.log(`   ⚠️  Could not check balances: ${error.message}\n`);
    }
  }

  // Get asset ID and format size/price using SymbolConverter
  const assetId = symbolConverter.getAssetId(ORDER_CONFIG.coin);
  if (assetId === undefined) {
    throw new Error(`Could not find asset ID for "${ORDER_CONFIG.coin}"`);
  }

  const szDecimals = symbolConverter.getSzDecimals(ORDER_CONFIG.coin);
  if (szDecimals === undefined) {
    throw new Error(`Could not find szDecimals for "${ORDER_CONFIG.coin}"`);
  }

  // Get detailed asset metadata for asset=1 (or the asset we're trading)
  if (isPerp) {
    console.log(`🔍 Detailed Asset Analysis (Asset ID: ${assetId})...`);
    console.log('─'.repeat(60));
    
    try {
      const meta = await infoClient.meta();
      const assetMeta = meta.universe?.find((a: any) => a.name === ORDER_CONFIG.coin);
      
      if (assetMeta) {
        console.log(`   Asset Name: ${assetMeta.name}`);
        console.log(`   Max Leverage: ${assetMeta.maxLeverage}x`);
        console.log(`   Sz Decimals: ${szDecimals}`);
        
        // Calculate margin requirements
        const orderNotional = ORDER_CONFIG.size * ORDER_CONFIG.limitPrice;
        const maxLeverage = typeof assetMeta.maxLeverage === 'string' 
          ? parseFloat(assetMeta.maxLeverage) 
          : assetMeta.maxLeverage;
        const conservativeLeverage = Math.min(maxLeverage / 4, 5); // Use 1/4 of max or 5x, whichever is lower
        const estimatedMargin = orderNotional / conservativeLeverage;
        const safetyBuffer = estimatedMargin * 0.2; // 20% buffer for GTC orders
        const totalMarginNeeded = estimatedMargin + safetyBuffer;
        
        console.log(`\n   Order Details:`);
        console.log(`     Size: ${ORDER_CONFIG.size} ${ORDER_CONFIG.coin}`);
        console.log(`     Price: $${ORDER_CONFIG.limitPrice}`);
        console.log(`     Notional Value: $${orderNotional.toFixed(2)}`);
        console.log(`     Max Leverage: ${maxLeverage}x`);
        console.log(`     Conservative Leverage: ${conservativeLeverage}x`);
        console.log(`     Estimated Margin Needed: $${totalMarginNeeded.toFixed(2)}`);
        console.log(`     Current Free Collateral: $${freeCollateral.toFixed(2)}`);
        
        if (totalMarginNeeded > freeCollateral) {
          console.log(`\n   ⚠️  WARNING: Need $${totalMarginNeeded.toFixed(2)} but only have $${freeCollateral.toFixed(2)}`);
          console.log(`   Shortfall: $${(totalMarginNeeded - freeCollateral).toFixed(2)}`);
        } else {
          console.log(`\n   ✅ Margin appears sufficient`);
        }
      }
      
      // Check existing positions for this specific asset
      const clearinghouseState = await infoClient.clearinghouseState({ user: walletAddress });
      if (clearinghouseState.assetPositions) {
        const assetPosition = clearinghouseState.assetPositions.find((pos: any) => pos.position.coin === assetId);
        if (assetPosition) {
          const size = parseFloat(assetPosition.position.szi || '0');
          if (size !== 0) {
            console.log(`\n   Existing Position in Asset ${assetId}:`);
            console.log(`     Size: ${size > 0 ? 'LONG' : 'SHORT'} ${Math.abs(size)}`);
            console.log(`     Entry Price: $${parseFloat(assetPosition.position.entryPx || '0').toFixed(2)}`);
            console.log(`     Margin Used: $${parseFloat(assetPosition.position.marginUsed || '0').toFixed(2)}`);
            console.log(`     Unrealized PnL: $${parseFloat(assetPosition.position.unrealizedPnl || '0').toFixed(2)}`);
            console.log(`     Max Leverage: ${assetPosition.position.maxLeverage}x`);
          }
        }
      }
      
      // Check spot vs perp balances
      try {
        const spotState = await infoClient.spotClearinghouseState({ user: walletAddress });
        if (spotState.balances && spotState.balances.length > 0) {
          console.log(`\n   Spot Balances:`);
          spotState.balances.forEach((bal: any) => {
            const total = parseFloat(bal.total || '0');
            if (total > 0) {
              console.log(`     ${bal.coin}: $${total.toFixed(2)}`);
            }
          });
        }
      } catch (e) {
        // Spot state might not be available, that's OK
      }
      
      console.log('');
    } catch (error: any) {
      console.log(`   ⚠️  Could not get asset metadata: ${error.message}\n`);
    }
  }

  // Format size and price using utilities (like the test file)
  const formattedSize = formatSize(ORDER_CONFIG.size.toString(), szDecimals);
  const formattedPrice = formatPrice(ORDER_CONFIG.limitPrice.toString(), szDecimals, isPerp);

  // Verify format matches frontend (string with proper decimals, e.g., "0.0791")
  console.log('📋 Order Details:');
  console.log('─'.repeat(60));
  console.log(`   Asset: ${ORDER_CONFIG.coin} (${positionType})`);
  console.log(`   Asset ID: ${assetId}`);
  console.log(`   Side: ${side}`);
  console.log(`   Size: ${ORDER_CONFIG.size} -> "${formattedSize}" (type: ${typeof formattedSize}, szDecimals: ${szDecimals})`);
  console.log(`   Limit Price: $${ORDER_CONFIG.limitPrice} -> "${formattedPrice}"`);
  console.log(`   Time in Force: ${ORDER_CONFIG.timeInForce}`);
  console.log(`   Reduce Only: ${ORDER_CONFIG.reduceOnly}`);
  console.log('');
  
  // Show the exact format that will be sent (matching frontend format)
  const orderPayload = {
    a: assetId,
    b: ORDER_CONFIG.isBuy,
    p: formattedPrice,
    s: formattedSize,
    r: ORDER_CONFIG.reduceOnly,
    t: { limit: { tif: ORDER_CONFIG.timeInForce } }
  };
  
  console.log('📤 Order payload (matching frontend format):');
  console.log(JSON.stringify({ orders: [orderPayload] }, null, 2));
  console.log('');

  // Place the order
  console.log('📤 Placing order...');
  console.log('─'.repeat(60));
  console.log('');

  try {
    const result = await exchangeClient.order({
      orders: [{
        a: assetId,
        b: ORDER_CONFIG.isBuy,
        p: formattedPrice,
        s: formattedSize,
        r: ORDER_CONFIG.reduceOnly,
        t: { limit: { tif: ORDER_CONFIG.timeInForce } },
      }],
      grouping: 'na',
    });

    // Parse the result
    console.log('📥 Order Response:');
    console.log('─'.repeat(60));
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    // Check order status
    if (result.response?.data?.statuses && result.response.data.statuses.length > 0) {
      const status = result.response.data.statuses[0];

      if ('filled' in status && status.filled) {
        console.log('✅ ORDER FILLED!');
        console.log(`   Filled Size: ${status.filled.totalSz}`);
        if (status.filled.avgPx) {
          console.log(`   Average Price: $${status.filled.avgPx}`);
        }
        if (status.filled.oid) {
          console.log(`   Order ID: ${status.filled.oid}`);
        }
      } else if ('resting' in status && status.resting) {
        console.log('⏳ ORDER RESTING (waiting to be filled)');
        console.log(`   Order ID: ${status.resting.oid}`);
        if (status.resting.cloid) {
          console.log(`   Client Order ID: ${status.resting.cloid}`);
        }
      } else if ('error' in status && status.error) {
        console.log('❌ ORDER ERROR:');
        const errorMsg = typeof status.error === 'string' ? status.error : JSON.stringify(status.error);
        console.log(`   ${errorMsg}`);
        
        // Provide helpful error messages
        if (typeof status.error === 'string' && (status.error.includes('balance') || status.error.includes('insufficient'))) {
          console.log('\n💡 Troubleshooting Tips:');
          console.log('   1. GTC orders may require more margin than IOC orders');
          console.log('   2. Try using "Ioc" timeInForce instead of "Gtc"');
          console.log('   3. Try a limit price closer to the current market price');
          console.log(`   4. Current free collateral: $${freeCollateral.toFixed(2)}`);
        }
      } else {
        console.log('⚠️  Unknown order status');
        console.log(JSON.stringify(status, null, 2));
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
