/**
 * Lighter Close Position Test Script
 * 
 * Tests closing a position with different orderExpiry values to determine the correct format
 * 
 * Usage:
 *   1. Set LIGHTER_API_KEY, ACCOUNT_INDEX, API_KEY_INDEX in .env
 *   2. Modify the position details below (symbol, size, side)
 *   3. Run: npx tsx lighter-close-position-test.ts
 */

import { SignerClient, OrderType, ApiClient, OrderApi, MarketHelper } from '@reservoir0x/lighter-ts-sdk';
import * as dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const API_PRIVATE_KEY = process.env.LIGHTER_API_KEY || process.env.API_PRIVATE_KEY;
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || process.env.ACCOUNT_INDEX || '1000');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || process.env.API_KEY_INDEX || '1');
const EXPLORER_API_URL = process.env.LIGHTER_EXPLORER_API_URL || 'https://explorer-api-mainnet.zklighter.elliot.ai';

// Position to close
const POSITION_CONFIG = {
  symbol: 'YZY',
  marketIndex: 70, // YZY market index
  size: 1172, // Position size to close
  side: 'SHORT', // Position side (SHORT means we need to BUY to close)
};

// Test different orderExpiry values
// Using a base timestamp to ensure consistency
const baseTime = Date.now();
const ORDER_EXPIRY_TESTS = [
  { name: 'orderExpiry = 0', value: 0 },
  { name: 'orderExpiry = expiredAt (1 min)', value: baseTime + 60000 },
  { name: 'orderExpiry > expiredAt (1 hour)', value: baseTime + 3600000 },
  { name: 'orderExpiry = undefined (omitted)', value: undefined },
  { name: 'orderExpiry = expiredAt + 5 min', value: baseTime + 360000 }, // 6 minutes total
  { name: 'orderExpiry = Date.now() + 1 hour (fresh)', value: () => Date.now() + (60 * 60 * 1000) },
];

if (!API_PRIVATE_KEY) {
  throw new Error('LIGHTER_API_KEY not found in .env file');
}

// Normalize the private key
let normalizedKey = API_PRIVATE_KEY;
if (normalizedKey.startsWith('0x')) {
  normalizedKey = normalizedKey.slice(2);
}

const PRIVATE_KEY_FOR_SDK = normalizedKey;

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

function trimException(e: Error): string {
  return e.message.trim().split('\n').pop() || 'Unknown error';
}

async function getPositions(accountIndex: number): Promise<any[]> {
  try {
    const response = await axios.get(`${EXPLORER_API_URL}/v1/positions`, {
      params: { accountIndex },
    });
    return response.data || [];
  } catch (error: any) {
    console.log(`⚠️  Could not fetch positions: ${trimException(error)}`);
    return [];
  }
}

async function getMarkPrice(marketIndex: number, orderApi: OrderApi): Promise<number> {
  try {
    const orderBook = await orderApi.getOrderBookDetails({ marketIndex } as any);
    if (orderBook.bestBid && orderBook.bestAsk) {
      return (parseFloat(orderBook.bestBid.price) + parseFloat(orderBook.bestAsk.price)) / 2;
    }
  } catch (error: any) {
    console.log(`⚠️  Could not fetch mark price: ${trimException(error)}`);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   LIGHTER CLOSE POSITION TEST                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Initialize SDK
  console.log('📡 Initializing Lighter SDK...');
  const signerClient = new SignerClient({
    url: BASE_URL,
    privateKey: PRIVATE_KEY_FOR_SDK,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX
  });

  const apiClient = new ApiClient({ host: BASE_URL });
  const orderApi = new OrderApi(apiClient);

  try {
    await signerClient.initialize();
    await signerClient.ensureWasmClient();
    console.log('✅ SDK initialized');
    console.log('');

    // Initialize market helper
    console.log('🔍 Initializing Market Helper...');
    const market = new MarketHelper(POSITION_CONFIG.marketIndex, orderApi);
    await market.initialize();
    console.log(`   Market Index: ${POSITION_CONFIG.marketIndex}`);
    console.log(`   Market: ${market.marketName || POSITION_CONFIG.symbol}`);
    console.log('✅ Market helper initialized');
    console.log('');

    // Get current positions
    console.log('📊 Fetching current positions...');
    const positions = await getPositions(ACCOUNT_INDEX);
    const yzyPosition = positions.find((p: any) => 
      p.symbol === POSITION_CONFIG.symbol || 
      p.marketIndex === POSITION_CONFIG.marketIndex
    );
    
    if (yzyPosition) {
      console.log(`   Found ${POSITION_CONFIG.symbol} position:`);
      console.log(`     Size: ${yzyPosition.size || yzyPosition.baseAmount}`);
      console.log(`     Side: ${yzyPosition.side || 'N/A'}`);
      console.log(`     Entry Price: ${yzyPosition.entryPrice || 'N/A'}`);
    } else {
      console.log(`   ⚠️  No ${POSITION_CONFIG.symbol} position found, will use configured size`);
    }
    console.log('');

    // Get current market price
    console.log('💰 Getting current market price...');
    const markPrice = await getMarkPrice(POSITION_CONFIG.marketIndex, orderApi);
    if (markPrice > 0) {
      console.log(`   Mark Price: $${markPrice.toFixed(6)}`);
    }
    console.log('');

    // Determine order side and price
    // If we have a SHORT position, we need to BUY (isAsk = false) to close it
    const isClosingShort = POSITION_CONFIG.side === 'SHORT';
    const isAsk = !isClosingShort; // false for BUY (close SHORT), true for SELL (close LONG)
    const closeSize = yzyPosition?.size || POSITION_CONFIG.size;
    
    // Use a limit price slightly worse than market for better fill probability
    const limitPrice = markPrice > 0 
      ? (isClosingShort ? markPrice * 1.002 : markPrice * 0.998) // 0.2% worse for closing
      : 0.37; // Fallback price for YZY
    
    console.log('📋 Close Order Details:');
    console.log(`   Symbol: ${POSITION_CONFIG.symbol}`);
    console.log(`   Market Index: ${POSITION_CONFIG.marketIndex}`);
    console.log(`   Side: ${POSITION_CONFIG.side} position → ${isClosingShort ? 'BUY' : 'SELL'} to close`);
    console.log(`   Size: ${closeSize}`);
    console.log(`   Limit Price: $${limitPrice.toFixed(6)}`);
    console.log(`   Reduce Only: true`);
    console.log('');

    // Use incrementing counter for clientOrderIndex to avoid nonce collisions
    let clientOrderIndexCounter = Date.now();
    
    // Test each orderExpiry value
    for (let i = 0; i < ORDER_EXPIRY_TESTS.length; i++) {
      const test = ORDER_EXPIRY_TESTS[i];
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`🧪 Test ${i + 1}/${ORDER_EXPIRY_TESTS.length}: ${test.name}`);
      console.log('═══════════════════════════════════════════════════════════');
      
      const timeInForce = 1; // IOC for closing
      const expiredAt = Date.now() + 60000; // 1 minute expiry
      
      // Use incrementing counter to ensure unique nonces
      clientOrderIndexCounter = Math.max(clientOrderIndexCounter + 1, Date.now());
      
      // Calculate orderExpiry value (handle function case)
      let orderExpiryValue = typeof test.value === 'function' ? test.value() : test.value;
      
      const orderParams: any = {
        marketIndex: POSITION_CONFIG.marketIndex,
        clientOrderIndex: clientOrderIndexCounter,
        baseAmount: market.amountToUnits(closeSize),
        price: market.priceToUnits(limitPrice),
        isAsk,
        orderType: OrderType.LIMIT,
        timeInForce, // 1 = IOC
        reduceOnly: 1, // Critical: must be 1 for closing
        expiredAt,
      };

      // Set orderExpiry based on test
      if (orderExpiryValue !== undefined) {
        orderParams.orderExpiry = orderExpiryValue;
      }
      // If undefined, don't include the field at all

      console.log('   Order Parameters:');
      console.log(`     clientOrderIndex: ${clientOrderIndexCounter}`);
      console.log(`     orderExpiry: ${orderExpiryValue !== undefined ? orderExpiryValue : 'undefined (not included)'}`);
      console.log(`     expiredAt: ${expiredAt}`);
      console.log(`     orderExpiry > expiredAt: ${orderExpiryValue !== undefined ? orderExpiryValue > expiredAt : 'N/A'}`);
      console.log(`     timeInForce: ${timeInForce} (IOC)`);
      console.log(`     reduceOnly: 1`);
      console.log('');

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/c9284998-e5a7-4b92-b637-b3ecac8841cf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lighter-close-position-test.ts:208',message:'Test attempt',data:{testName:test.name,orderExpiry:orderExpiryValue,expiredAt,clientOrderIndex:clientOrderIndexCounter,orderParams},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion

      try {
        console.log('   📤 Attempting to place order...');
        const result = await signerClient.createUnifiedOrder(orderParams);
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/c9284998-e5a7-4b92-b637-b3ecac8841cf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lighter-close-position-test.ts:215',message:'Order result',data:{success:result.success,error:result.mainOrder?.error,testName:test.name},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion

        if (result.success) {
          console.log('   ✅ SUCCESS! Order created successfully');
          console.log(`      Order Hash: ${result.mainOrder.hash.substring(0, 16)}...`);
          console.log('');
          console.log('   🎉 This orderExpiry value works!');
          console.log('');
          console.log('   Full result:');
          console.log(JSON.stringify(result, null, 2));
          console.log('');
          
          // Wait a bit to see if order processes
          try {
            console.log('   ⏳ Waiting for order processing...');
            await signerClient.waitForTransaction(result.mainOrder.hash, 30000, 2000);
            console.log('   ✅ Order processed successfully!');
          } catch (error) {
            console.log(`   ⚠️  Order processing: ${trimException(error as Error)}`);
          }
          
          console.log('');
          console.log('💡 RECOMMENDATION: Use this orderExpiry value in LighterExchangeAdapter.ts');
          break; // Stop after first success
        } else {
          console.log('   ❌ FAILED');
          console.log(`      Error: ${result.mainOrder.error || 'Unknown error'}`);
          console.log('');
        }
      } catch (error: any) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/c9284998-e5a7-4b92-b637-b3ecac8841cf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lighter-close-position-test.ts:247',message:'Order exception',data:{error:trimException(error),errorMessage:error.message,testName:test.name,orderExpiry:orderExpiryValue,isOrderExpiryInvalid:error.message?.includes('OrderExpiry is invalid'),isInvalidExpiry:error.message?.includes('invalid expiry'),isInvalidNonce:error.message?.includes('invalid nonce')},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        console.log('   ❌ EXCEPTION');
        console.log(`      Error: ${trimException(error)}`);
        if (error.message?.includes('OrderExpiry is invalid')) {
          console.log('      ⚠️  This confirms the orderExpiry validation issue');
        }
        if (error.message?.includes('invalid expiry')) {
          console.log('      ⚠️  Expiry value is invalid (may be relationship issue with expiredAt)');
        }
        if (error.message?.includes('invalid nonce')) {
          console.log('      ⚠️  Nonce issue (clientOrderIndex collision or too fast)');
        }
        console.log('');
      }

      // Wait a bit between tests to avoid rate limits and nonce issues
      if (i < ORDER_EXPIRY_TESTS.length - 1) {
        console.log('   ⏳ Waiting 5 seconds before next test...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ Testing complete');
    console.log('═══════════════════════════════════════════════════════════');

  } catch (error) {
    console.log('[ERROR] Failed to run test');
    console.log(`   Error: ${trimException(error as Error)}`);
  } finally {
    try {
      await signerClient.cleanup();
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

