/**
 * Simple script to test Lighter price queries for the 9 allowed assets
 * Uses candlesticks endpoint to get latest prices
 * 
 * Usage: npx tsx test-lighter-prices.ts
 */

import zklighter from '@api/zklighter';
import * as dotenv from 'dotenv';

dotenv.config();

// Set the server URL (default to mainnet)
const BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
zklighter.server(BASE_URL);

// The 9 allowed assets with high liquidity
const ALLOWED_ASSETS = [
  'BTC',
  'ETH',
  'SOL',
  'HYPE',
  'ZEC',
  'XRP',
  'ASTER',
  'SUI',
  'GOOGL',
  'TSLA',
  'USDC',
  'USDT',
];

// Market index mapping (we'll try to discover this or use known values)
// Common market indices: 0=ETH, 1=BTC, 2=SOL, etc.
const MARKET_INDICES: Record<string, number> = {
  'ETH': 0,
  'BTC': 1,
  'SOL': 2,
  'XRP': 7,
  // We'll need to discover the rest
};

interface PriceResult {
  symbol: string;
  marketIndex?: number;
  success: boolean;
  price?: number;
  method?: string;
  error?: string;
  response?: any;
}

/**
 * Get price using candlesticks endpoint
 */
async function getPriceFromCandlesticks(symbol: string, marketIndex: number): Promise<PriceResult> {
  try {
    // Get latest candlestick (count_back=1, set_timestamp_to_end=true)
    const now = Math.floor(Date.now() / 1000);
    const oneMinuteAgo = now - 60;
    
    const response = await zklighter.candlesticks({
      market_id: marketIndex.toString(),
      resolution: '1m',
      start_timestamp: oneMinuteAgo.toString(),
      end_timestamp: now.toString(),
      count_back: '1',
      set_timestamp_to_end: 'true'
    });

    const data = response.data;
    
    // Log full response for debugging
    console.log(`  📋 Full response for ${symbol}:`, JSON.stringify(data).substring(0, 500));
    
    // Response structure: { code: 200, candlesticks: [...] }
    // Candlestick structure: { timestamp, open, high, low, close, volume }
    const candlesticks = data?.candlesticks || (Array.isArray(data) ? data : []);
    
    if (candlesticks && Array.isArray(candlesticks) && candlesticks.length > 0) {
      const latest = candlesticks[candlesticks.length - 1];
      const price = latest.close || latest.c || latest.price;
      
      if (price && !isNaN(parseFloat(price))) {
        return {
          symbol,
          marketIndex,
          success: true,
          price: parseFloat(price),
          method: 'candlesticks',
          response: latest,
        };
      } else {
        return {
          symbol,
          marketIndex,
          success: false,
          error: `No price field in candlestick. Available fields: ${Object.keys(latest).join(', ')}. Data: ${JSON.stringify(latest).substring(0, 200)}`,
          response: latest,
        };
      }
    }
    
    return {
      symbol,
      marketIndex,
      success: false,
      error: `No candlesticks data in response. Response structure: ${JSON.stringify(data).substring(0, 400)}`,
      response: data,
    };
  } catch (error: any) {
    return {
      symbol,
      marketIndex,
      success: false,
      error: error?.message || error?.toString() || String(error),
      response: error?.response?.data || error?.response || error,
    };
  }
}

/**
 * Get price using orderBooks endpoint (to verify market exists)
 */
async function verifyMarketExists(marketIndex: number): Promise<{ exists: boolean; symbol?: string; status?: string }> {
  try {
    const response = await zklighter.orderBooks({ market_id: marketIndex.toString() });
    const data = response.data;
    
    if (data?.order_books && Array.isArray(data.order_books)) {
      const market = data.order_books.find((book: any) => 
        book.market_id === marketIndex || book.market_id === marketIndex.toString()
      );
      
      if (market) {
        return {
          exists: true,
          symbol: market.symbol,
          status: market.status,
        };
      }
    }
    
    return { exists: false };
  } catch (error: any) {
    return { exists: false };
  }
}

/**
 * Discover market indices by querying all orderBooks
 */
async function discoverMarketIndices(): Promise<Map<string, number>> {
  const mapping = new Map<string, number>();
  
  try {
    console.log('🔍 Discovering market indices from orderBooks...');
    const response = await zklighter.orderBooks();
    const data = response.data;
    
    if (data?.order_books && Array.isArray(data.order_books)) {
      for (const book of data.order_books) {
        const marketId = book.market_id;
        const symbol = book.symbol?.replace('USDC', '').replace('USDT', '').replace('-PERP', '').toUpperCase();
        
        if (symbol && marketId !== undefined) {
          mapping.set(symbol, marketId);
          console.log(`  Found: ${symbol} -> market_id ${marketId}`);
        }
      }
    }
  } catch (error: any) {
    console.error(`Failed to discover market indices: ${error.message}`);
  }
  
  return mapping;
}

/**
 * Main test function
 */
async function main() {
  console.log('🚀 Testing Lighter price queries for 9 allowed assets\n');
  console.log('Assets to test:', ALLOWED_ASSETS.join(', '));
  console.log('');
  
  // First, discover market indices
  const marketMapping = await discoverMarketIndices();
  
  // Merge with known mappings
  for (const [symbol, index] of Object.entries(MARKET_INDICES)) {
    if (!marketMapping.has(symbol)) {
      marketMapping.set(symbol, index);
    }
  }
  
  console.log(`\n📊 Found ${marketMapping.size} market mappings\n`);
  
  const results: PriceResult[] = [];
  
  // Test each asset
  for (const symbol of ALLOWED_ASSETS) {
    const marketIndex = marketMapping.get(symbol);
    
    if (marketIndex === undefined) {
      console.log(`❌ ${symbol}: No market index found`);
      results.push({
        symbol,
        success: false,
        error: 'Market index not found',
      });
      continue;
    }
    
    // Verify market exists first
    const marketInfo = await verifyMarketExists(marketIndex);
    if (!marketInfo.exists) {
      console.log(`❌ ${symbol} (market_id: ${marketIndex}): Market not found`);
      results.push({
        symbol,
        marketIndex,
        success: false,
        error: 'Market not found in orderBooks',
      });
      continue;
    }
    
    console.log(`🔍 Testing ${symbol} (market_id: ${marketIndex}, status: ${marketInfo.status})...`);
    
    // Try candlesticks endpoint
    const result = await getPriceFromCandlesticks(symbol, marketIndex);
    results.push(result);
    
    if (result.success) {
      console.log(`  ✅ Price: $${result.price?.toFixed(2)}`);
    } else {
      console.log(`  ❌ Error: ${result.error}`);
      if (result.response) {
        console.log(`  Response: ${JSON.stringify(result.response).substring(0, 200)}`);
      }
    }
    
    // Small delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`✅ Successful: ${successful.length}/${results.length}`);
  successful.forEach(r => {
    console.log(`   ${r.symbol}: $${r.price?.toFixed(2)} (market_id: ${r.marketIndex})`);
  });
  
  console.log(`\n❌ Failed: ${failed.length}/${results.length}`);
  failed.forEach(r => {
    console.log(`   ${r.symbol} (market_id: ${r.marketIndex || 'N/A'}): ${r.error}`);
  });
  
  console.log('\n');
}

// Run the test
main().catch(console.error);

