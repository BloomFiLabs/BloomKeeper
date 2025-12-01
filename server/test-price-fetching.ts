/**
 * Test Price Fetching Script
 * 
 * Tests mark price fetching for all exchanges with various symbols
 * 
 * Usage:
 *   npx tsx test-price-fetching.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import axios from 'axios';
import { ApiClient, OrderApi } from '@reservoir0x/lighter-ts-sdk';

// Test symbols
const TEST_SYMBOLS = ['ETH', 'BTC', 'MOODENG', 'SOL', 'BNB'];

async function testHyperliquidPrice(symbol: string): Promise<{ success: boolean; price?: number; error?: string }> {
  try {
    const transport = new HttpTransport({ isTestnet: false });
    const infoClient = new InfoClient({ transport });

    // Use allMids() to get mark prices (matching adapter)
    const allMidsData = await infoClient.allMids();
    const baseCoin = symbol.replace('USDT', '').replace('USDC', '').replace('-PERP', '');
    
    const markPrice = parseFloat((allMidsData as any)[baseCoin] || (allMidsData as any)[symbol] || '0');
    
    if (markPrice > 0) {
      return { success: true, price: markPrice };
    } else {
      return { success: false, error: `Price not found in allMids (tried: ${baseCoin}, ${symbol})` };
    }
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function testAsterPrice(symbol: string): Promise<{ success: boolean; price?: number; error?: string }> {
  try {
    const baseUrl = process.env.ASTER_BASE_URL || 'https://api.aster.exchange';
    const client = axios.create({ baseURL: baseUrl, timeout: 10000 });

    const asterSymbol = `${symbol}USDT`;
    const response = await client.get('/fapi/v1/ticker/price', {
      params: { symbol: asterSymbol },
    });

    const price = parseFloat(response.data.price);
    if (price > 0) {
      return { success: true, price };
    } else {
      return { success: false, error: 'Invalid price returned' };
    }
  } catch (error: any) {
    return { 
      success: false, 
      error: error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message 
    };
  }
}

// Cache for market index mappings
let marketIndexCache: Map<string, number> | null = null;
let marketIndexCacheTimestamp: number = 0;
const MARKET_INDEX_CACHE_TTL = 3600000; // 1 hour

async function refreshMarketIndexCache(): Promise<void> {
  const now = Date.now();
  
  // Use cache if fresh
  if (marketIndexCache && (now - marketIndexCacheTimestamp) < MARKET_INDEX_CACHE_TTL) {
    return;
  }

  try {
    const explorerUrl = 'https://explorer.elliot.ai/api/markets';
    const response = await axios.get(explorerUrl, {
      timeout: 10000,
      headers: { accept: 'application/json' },
    });

    if (!response.data || !Array.isArray(response.data)) {
      console.error('Lighter Explorer API returned invalid data format');
      return;
    }

    // Clear old cache
    marketIndexCache = new Map();

    // Parse response: [{ "symbol": "ETH", "market_index": 0 }, ...]
    for (const market of response.data) {
      const marketIndex = market.market_index ?? market.marketIndex ?? market.index ?? null;
      const symbol = market.symbol || market.baseAsset || market.name;
      
      if (marketIndex !== null && symbol) {
        // Normalize symbol (remove USDC/USDT suffixes)
        const normalizedSymbol = symbol
          .replace('USDC', '')
          .replace('USDT', '')
          .replace('-PERP', '')
          .replace('PERP', '')
          .toUpperCase();
        
        marketIndexCache.set(normalizedSymbol, Number(marketIndex));
      }
    }

    marketIndexCacheTimestamp = now;
    console.log(`Cached ${marketIndexCache.size} market index mappings from Lighter Explorer API`);
  } catch (error: any) {
    console.error(`Failed to fetch market index mappings: ${error.message}`);
    // Fallback to hardcoded mapping
    marketIndexCache = new Map([
      ['ETH', 0],
      ['BTC', 1],
      ['SOL', 2],
      ['BNB', 25],
    ]);
  }
}

async function testLighterPrice(symbol: string): Promise<{ success: boolean; price?: number; error?: string; method?: string }> {
  // Refresh market index cache
  await refreshMarketIndexCache();

  const baseUrl = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
  const apiClient = new ApiClient({ host: baseUrl });
  const orderApi = new OrderApi(apiClient);

  // Get market index from cache
  const normalizedSymbol = symbol.toUpperCase();
  const marketIndex = marketIndexCache?.get(normalizedSymbol);
  
  if (marketIndex === undefined) {
    return { success: false, error: `Unknown market index for ${symbol} (not found in Explorer API cache)` };
  }

  // Method 1: Order book
  try {
    const response = await orderApi.getOrderBookDetails({ marketIndex: marketIndex } as any) as any;
    
    // Response structure: { code: 200, order_book_details: { bestBid: {...}, bestAsk: {...} } }
    const orderBook = response?.order_book_details || response;
    const bestBid = orderBook?.bestBid || orderBook?.best_bid || orderBook?.bids?.[0];
    const bestAsk = orderBook?.bestAsk || orderBook?.best_ask || orderBook?.asks?.[0];
    
    // Try different price field names
    const bidPrice = bestBid?.price || bestBid?.px || bestBid?.[0];
    const askPrice = bestAsk?.price || bestAsk?.px || bestAsk?.[0];
    
    if (bidPrice && askPrice) {
      const midPrice = (parseFloat(bidPrice) + parseFloat(askPrice)) / 2;
      if (midPrice > 0) {
        return { success: true, price: midPrice, method: 'order book' };
      }
    }
  } catch (error: any) {
    // Continue to next method
  }

  // Method 2: Funding rates API
  try {
    const fundingUrl = `${baseUrl}/api/v1/funding-rates`;
    const response = await axios.get(fundingUrl, {
      timeout: 10000,
    });

    let fundingRates: any[] = [];
    if (response.data?.funding_rates && Array.isArray(response.data.funding_rates)) {
      fundingRates = response.data.funding_rates;
    } else if (Array.isArray(response.data)) {
      fundingRates = response.data;
    }

    if (fundingRates.length > 0) {
      const marketRate = fundingRates.find(
        (r: any) => 
          r.market_id === marketIndex || 
          r.market_index === marketIndex ||
          r.marketIndex === marketIndex
      );
      
      if (marketRate) {
        if (marketRate.mark_price) {
          return { success: true, price: parseFloat(marketRate.mark_price), method: 'funding rates API' };
        } else if (marketRate.price) {
          return { success: true, price: parseFloat(marketRate.price), method: 'funding rates API' };
        }
      }
    }
  } catch (error: any) {
    // Continue to next method
  }

  // Method 3: Explorer API
  try {
    const explorerUrl = `https://explorer.elliot.ai/api/markets/${symbol}/logs`;
    const response = await axios.get(explorerUrl, {
      timeout: 10000,
      headers: { accept: 'application/json' },
    });

    // Try multiple response structures
    if (response.data) {
      // Direct price fields
      if (response.data.price) {
        return { success: true, price: parseFloat(response.data.price), method: 'explorer API (direct)' };
      }
      if (response.data.markPrice) {
        return { success: true, price: parseFloat(response.data.markPrice), method: 'explorer API (markPrice)' };
      }
      // Array of logs
      if (Array.isArray(response.data) && response.data.length > 0) {
        const latest = response.data[0];
        if (latest.price) {
          return { success: true, price: parseFloat(latest.price), method: 'explorer API (array)' };
        }
      }
      // Nested data
      if (response.data.data?.price) {
        return { success: true, price: parseFloat(response.data.data.price), method: 'explorer API (nested)' };
      }
    }
  } catch (error: any) {
    // All methods failed
  }

  return { success: false, error: 'All methods failed' };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   PRICE FETCHING TESTS                                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const results: Record<string, {
    hyperliquid: { success: boolean; price?: number; error?: string };
    aster: { success: boolean; price?: number; error?: string };
    lighter: { success: boolean; price?: number; error?: string; method?: string };
  }> = {};

  for (const symbol of TEST_SYMBOLS) {
    console.log(`\n📊 Testing ${symbol}...`);
    console.log('─'.repeat(60));

    const symbolResults = {
      hyperliquid: await testHyperliquidPrice(symbol),
      aster: await testAsterPrice(symbol),
      lighter: await testLighterPrice(symbol),
    };

    results[symbol] = symbolResults;

    // Display results
    console.log(`Hyperliquid: ${symbolResults.hyperliquid.success 
      ? `✅ $${symbolResults.hyperliquid.price?.toFixed(2)}` 
      : `❌ ${symbolResults.hyperliquid.error}`}`);
    console.log(`Aster:       ${symbolResults.aster.success 
      ? `✅ $${symbolResults.aster.price?.toFixed(2)}` 
      : `❌ ${symbolResults.aster.error}`}`);
    console.log(`Lighter:     ${symbolResults.lighter.success 
      ? `✅ $${symbolResults.lighter.price?.toFixed(2)} (${symbolResults.lighter.method})` 
      : `❌ ${symbolResults.lighter.error}`}`);

    // Small delay between symbols
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   TEST SUMMARY                                           ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  let totalTests = 0;
  let passedTests = 0;

  for (const [symbol, symbolResults] of Object.entries(results)) {
    console.log(`${symbol}:`);
    for (const [exchange, result] of Object.entries(symbolResults)) {
      totalTests++;
      if (result.success) {
        passedTests++;
        console.log(`  ${exchange.padEnd(12)} ✅ $${result.price?.toFixed(2)}`);
      } else {
        console.log(`  ${exchange.padEnd(12)} ❌ ${result.error}`);
      }
    }
    console.log('');
  }

  console.log(`Total: ${passedTests}/${totalTests} tests passed`);
  console.log('');

  if (passedTests === totalTests) {
    console.log('✅ All price fetching tests passed!');
    process.exit(0);
  } else {
    console.log(`❌ ${totalTests - passedTests} test(s) failed`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

