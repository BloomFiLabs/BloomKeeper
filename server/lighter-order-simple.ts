/**
 * Lighter Perpetual Order Script - Using Lighter SDK
 * 
 * This script uses the @reservoir0x/lighter-ts-sdk to place perpetual futures orders
 * API Documentation: https://apidocs.lighter.xyz/reference
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file (Ethereum private key for signing, e.g., 0x...)
 *   2. Optionally set ACCOUNT_INDEX and API_KEY_INDEX (defaults: 1000, 1)
 *   3. Modify the order parameters below
 *   4. Run: npx tsx lighter-order-simple.ts
 * 
 * Note: The privateKey should be an Ethereum private key (0x...), not an API key.
 *       If you only have an API key, you may need to generate API keys in the Lighter app
 *       which will give you a private key for signing.
 */

import { SignerClient, OrderType, ApiClient, OrderApi, MarketHelper } from '@reservoir0x/lighter-ts-sdk';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
// The SDK expects an API private key (40 hex characters, 20 bytes)
// This should be generated using lighter-setup-api-key.ts
// Format: 40 hex characters (20 bytes) - can be with or without 0x prefix
const API_PRIVATE_KEY = process.env.LIGHTER_API_KEY || process.env.API_PRIVATE_KEY;
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || process.env.ACCOUNT_INDEX || '1000');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || process.env.API_KEY_INDEX || '1');

if (!API_PRIVATE_KEY) {
  throw new Error('LIGHTER_API_KEY not found in .env file. Run lighter-setup-api-key.ts first to generate an API key.');
}

// Normalize the private key - remove 0x if present, SDK will add it back
let normalizedKey = API_PRIVATE_KEY;
if (normalizedKey.startsWith('0x')) {
  normalizedKey = normalizedKey.slice(2);
}

// The SDK accepts API keys in various formats
// Generated keys are typically 80 hex characters (includes both private and public key parts)
// The SDK will handle the format internally
if (normalizedKey.length === 40 || normalizedKey.length === 80) {
  // Valid API key format
} else if (normalizedKey.length === 64) {
  throw new Error('This looks like an Ethereum private key (64 hex chars). You need a Lighter API key. Run lighter-setup-api-key.ts to generate one.');
} else {
  console.log(`⚠️  WARNING: Unexpected key length: ${normalizedKey.length} hex characters`);
  console.log('   Lighter API keys are typically 40 or 80 hex characters');
  console.log('   Run lighter-setup-api-key.ts to generate a proper API key');
  console.log('');
}

// Use the normalized key (without 0x, SDK will add it)
const PRIVATE_KEY_FOR_SDK = normalizedKey;

// ═══════════════════════════════════════════════════════════
// ORDER CONFIGURATION - Modify these values
// ═══════════════════════════════════════════════════════════

const ORDER_CONFIG = {
  marketIndex: 0, // Market index (0 = ETH/USDC, check markets for others)
  size: 0.1, // Order size (in base asset, e.g., 0.1 ETH)
  price: 2000, // Limit price (in USD)
  isBuy: true, // true = BUY/LONG, false = SELL/SHORT
  leverage: 10, // Leverage multiplier (e.g., 10 for 10x)
  orderExpiry: Date.now() + (60 * 60 * 1000), // Order expires in 1 hour
  // Optional: Stop Loss and Take Profit
  stopLoss: null as { triggerPrice: number; isLimit: boolean } | null,
  takeProfit: null as { triggerPrice: number; isLimit: boolean } | null,
};

// ═══════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════

function trimException(e: Error): string {
  return e.message.trim().split('\n').pop() || 'Unknown error';
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   LIGHTER PERPETUAL ORDER (SDK)                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  console.log('📡 Initializing Lighter SDK...');
  console.log(`   API Base: ${BASE_URL}`);
  console.log(`   Account Index: ${ACCOUNT_INDEX}`);
  console.log(`   API Key Index: ${API_KEY_INDEX}`);
  console.log(`   API Key: ${PRIVATE_KEY_FOR_SDK.substring(0, 8)}... (${PRIVATE_KEY_FOR_SDK.length} chars)`);
  console.log('');

  // Initialize SignerClient
  const signerClient = new SignerClient({
    url: BASE_URL,
    privateKey: PRIVATE_KEY_FOR_SDK, // Use normalized key (SDK will add 0x if needed)
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX
  });

  // Initialize API clients
  const apiClient = new ApiClient({ host: BASE_URL });
  const orderApi = new OrderApi(apiClient);

  try {
    await signerClient.initialize();
    await signerClient.ensureWasmClient();
    console.log('✅ SDK initialized');
    console.log('');

    // Initialize market helper
    console.log('🔍 Initializing Market Helper...');
    const market = new MarketHelper(ORDER_CONFIG.marketIndex, orderApi);
    await market.initialize();
    console.log(`   Market Index: ${ORDER_CONFIG.marketIndex}`);
    console.log(`   Market: ${market.marketName || 'N/A'}`);
    console.log('✅ Market helper initialized');
    console.log('');

    // Check account info
    console.log('💰 Checking Account Info...');
    try {
      const accountApi = apiClient.account;
      const account = await accountApi.getAccount();
      console.log(`   Account: ${account.address || 'N/A'}`);
      if (account.balance) {
        console.log(`   Balance: ${account.balance}`);
      }
    } catch (error: any) {
      console.log(`   ⚠️  Could not fetch account info: ${trimException(error)}`);
    }
    console.log('');

    // Get order book to see current market price
    console.log('📊 Checking Market Data...');
    try {
      const orderBook = await orderApi.getOrderBookDetails({ marketIndex: ORDER_CONFIG.marketIndex });
      if (orderBook.bestBid && orderBook.bestAsk) {
        const midPrice = (parseFloat(orderBook.bestBid.price) + parseFloat(orderBook.bestAsk.price)) / 2;
        console.log(`   Best Bid: ${orderBook.bestBid.price}`);
        console.log(`   Best Ask: ${orderBook.bestAsk.price}`);
        console.log(`   Mid Price: ${midPrice.toFixed(2)}`);
      }
    } catch (error: any) {
      console.log(`   ⚠️  Could not fetch market data: ${trimException(error)}`);
    }
    console.log('');

    // Show order details
    console.log('📋 Order Details:');
    console.log(`   Market Index: ${ORDER_CONFIG.marketIndex}`);
    console.log(`   Side: ${ORDER_CONFIG.isBuy ? 'BUY' : 'SELL'} (${ORDER_CONFIG.isBuy ? 'LONG' : 'SHORT'})`);
    console.log(`   Size: ${ORDER_CONFIG.size}`);
    console.log(`   Price: $${ORDER_CONFIG.price}`);
    console.log(`   Leverage: ${ORDER_CONFIG.leverage}x`);
    console.log(`   Order Type: LIMIT`);
    console.log('');

    // Prepare order parameters
    console.log('🔐 Preparing order...');
    const limitOrderParams = {
      marketIndex: ORDER_CONFIG.marketIndex,
      clientOrderIndex: Date.now(),
      baseAmount: market.amountToUnits(ORDER_CONFIG.size),
      price: market.priceToUnits(ORDER_CONFIG.price),
      isAsk: !ORDER_CONFIG.isBuy, // isAsk = true for SELL, false for BUY
      orderType: OrderType.LIMIT,
      orderExpiry: ORDER_CONFIG.orderExpiry,
      stopLoss: ORDER_CONFIG.stopLoss,
      takeProfit: ORDER_CONFIG.takeProfit,
    };

    console.log('   Order Parameters:');
    console.log(`     Market Index: ${limitOrderParams.marketIndex}`);
    console.log(`     Client Order Index: ${limitOrderParams.clientOrderIndex}`);
    console.log(`     Base Amount (units): ${limitOrderParams.baseAmount}`);
    console.log(`     Price (units): ${limitOrderParams.price}`);
    console.log(`     Is Ask (SELL): ${limitOrderParams.isAsk}`);
    console.log(`     Order Type: LIMIT`);
    console.log('');

    // Place the order
    console.log('📤 Placing order...');
    const result = await signerClient.createUnifiedOrder(limitOrderParams);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('📤 ORDER RESPONSE:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    if (result.success) {
      console.log('[SUCCESS] Order created successfully!');
      console.log(`   Main Order Hash: ${result.mainOrder.hash.substring(0, 16)}...`);
      
      // Wait for main order to be processed
      try {
        console.log('   Waiting for order to be processed...');
        await signerClient.waitForTransaction(result.mainOrder.hash, 30000, 2000);
        console.log('   ✅ Order placed successfully!');
      } catch (error) {
        console.log(`   ⚠️  Order processing: ${trimException(error as Error)}`);
      }
      
      // Handle SL/TP orders if any
      if (result.batchResult && result.batchResult.hashes && result.batchResult.hashes.length > 0) {
        console.log(`   ${result.batchResult.hashes.length} SL/TP order(s) pending`);
        for (const hash of result.batchResult.hashes) {
          if (hash) {
            try {
              await signerClient.waitForTransaction(hash, 30000, 2000);
              console.log(`   ✅ SL/TP order processed: ${hash.substring(0, 16)}...`);
            } catch (error) {
              console.log(`   ⚠️  SL/TP order: ${trimException(error as Error)}`);
            }
          }
        }
      }
    } else {
      console.log('[ERROR] Order creation failed');
      console.log(`   Error: ${result.mainOrder.error || 'Unknown error'}`);
    }

  } catch (error) {
    console.log('[ERROR] Failed to place order');
    console.log(`   Error: ${trimException(error as Error)}`);
    console.log('');
    console.log('💡 Common issues:');
    console.log('   - Check that LIGHTER_API_KEY is correct');
    console.log('   - Verify ACCOUNT_INDEX and API_KEY_INDEX are correct');
    console.log('   - Ensure you have sufficient balance');
    console.log('   - Check that market index is valid');
  } finally {
    // Cleanup
    try {
      await signerClient.cleanup();
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  console.log('');
  console.log('💡 Note: The SDK handled all the complexity automatically!');
  console.log('   No manual API calls or transaction formatting needed.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
