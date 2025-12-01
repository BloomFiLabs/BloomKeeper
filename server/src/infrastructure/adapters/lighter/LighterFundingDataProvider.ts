import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiClient } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';

interface LighterFundingRate {
  market_id: number;
  exchange: string;
  symbol: string;
  rate: number;
}

interface LighterFundingRatesResponse {
  code: number;
  funding_rates: LighterFundingRate[];
}

/**
 * LighterFundingDataProvider - Fetches funding rate data from Lighter Protocol
 * 
 * Uses the funding-rates endpoint to fetch all rates at once and caches them
 */
@Injectable()
export class LighterFundingDataProvider implements OnModuleInit {
  private readonly logger = new Logger(LighterFundingDataProvider.name);
  private readonly apiClient: ApiClient;
  private readonly baseUrl: string;
  
  // Cache for funding rates (key: market_id, value: rate)
  private fundingRatesCache: Map<number, number> = new Map();
  private lastCacheUpdate: number = 0;
  private readonly CACHE_TTL = 60000; // 1 minute cache (funding rates update hourly)

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('LIGHTER_API_BASE_URL') || 'https://mainnet.zklighter.elliot.ai';
    this.apiClient = new ApiClient({ host: this.baseUrl });
  }

  /**
   * Initialize and fetch funding rates on module init
   */
  async onModuleInit() {
    await this.refreshFundingRates();
  }

  /**
   * Fetch all funding rates from Lighter API and cache them
   */
  async refreshFundingRates(): Promise<void> {
    try {
      const fundingUrl = `${this.baseUrl}/api/v1/funding-rates`;
      
      const response = await axios.get<LighterFundingRatesResponse>(fundingUrl, {
        timeout: 10000,
      });

      if (response.data?.code === 200 && Array.isArray(response.data.funding_rates)) {
        // Clear old cache
        this.fundingRatesCache.clear();
        
        // Populate cache with all funding rates
        for (const rate of response.data.funding_rates) {
          this.fundingRatesCache.set(rate.market_id, rate.rate);
        }
        
        this.lastCacheUpdate = Date.now();
        this.logger.log(`Cached ${this.fundingRatesCache.size} Lighter funding rates`);
      } else {
        this.logger.warn('Lighter funding-rates API returned unexpected format');
      }
    } catch (error: any) {
      this.logger.error(`Failed to refresh Lighter funding rates: ${error.message}`);
      // Don't throw - allow using stale cache if available
    }
  }

  /**
   * Ensure cache is fresh (refresh if needed)
   */
  private async ensureCacheFresh(): Promise<void> {
    const now = Date.now();
    if (this.fundingRatesCache.size === 0 || (now - this.lastCacheUpdate) > this.CACHE_TTL) {
      await this.refreshFundingRates();
    }
  }

  /**
   * Get current funding rate for a market
   * Uses cached funding rates from the funding-rates API endpoint
   * @param marketIndex Market index (e.g., 0 for ETH/USDC)
   * @returns Funding rate as decimal (e.g., 0.0001 = 0.01%)
   */
  async getCurrentFundingRate(marketIndex: number): Promise<number> {
    await this.ensureCacheFresh();
    
    const rate = this.fundingRatesCache.get(marketIndex);
    if (rate !== undefined) {
      return rate;
    }
    
    // If not in cache, return 0 (market might not exist or have no funding rate)
    return 0;
  }

  /**
   * Get predicted next funding rate
   * @param marketIndex Market index
   * @returns Predicted funding rate as decimal
   */
  async getPredictedFundingRate(marketIndex: number): Promise<number> {
    try {
      // Use current funding rate as prediction (Lighter may not provide prediction)
      return await this.getCurrentFundingRate(marketIndex);
    } catch (error: any) {
      this.logger.error(`Failed to get predicted funding rate for market ${marketIndex}: ${error.message}`);
      throw new Error(`Failed to get Lighter predicted funding rate: ${error.message}`);
    }
  }

  /**
   * Get open interest for a market
   * @param marketIndex Market index
   * @returns Open interest in USD
   */
  async getOpenInterest(marketIndex: number): Promise<number> {
    try {
      // Cast to any since SDK types may be incomplete
      const marketData = await (this.apiClient as any).market?.getMarketData({ marketIndex });
      
      if (!marketData) {
        return 0;
      }
      
      // Extract open interest (adjust field name as needed)
      const openInterest = parseFloat(marketData.openInterest || '0');
      const markPrice = parseFloat(marketData.markPrice || await this.getMarkPrice(marketIndex));
      
      return openInterest * markPrice; // Convert to USD value
    } catch (error: any) {
      this.logger.error(`Failed to get open interest for market ${marketIndex}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get mark price for a market
   * Tries multiple methods: order book, funding rates API, or market data
   * @param marketIndex Market index
   * @returns Mark price
   */
  async getMarkPrice(marketIndex: number): Promise<number> {
    // Try order book first (most accurate)
    try {
      const orderBook = await (this.apiClient as any).order?.getOrderBookDetails({ marketIndex: marketIndex } as any) as any;
      
      if (orderBook?.bestBid?.price && orderBook?.bestAsk?.price) {
        const midPrice = (parseFloat(orderBook.bestBid.price) + parseFloat(orderBook.bestAsk.price)) / 2;
        return midPrice;
      }
    } catch (error: any) {
      // Fall through to next method - only log actual errors
    }

    // Try funding rates API (may include mark price)
    try {
      const fundingUrl = `${this.baseUrl}/api/v1/funding-rates`;
      const response = await axios.get(fundingUrl, {
        timeout: 10000,
        params: { market_index: marketIndex },
      });

      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        const latest = response.data[0];
        if (latest.mark_price) {
          return parseFloat(latest.mark_price);
        }
        if (latest.price) {
          return parseFloat(latest.price);
        }
      }
    } catch (error: any) {
      // Fall through to next method - only log actual errors
    }

    // Try market data API as last resort
    try {
      const marketData = await (this.apiClient as any).market?.getMarketData({ marketIndex });
      if (marketData?.markPrice) {
        return parseFloat(marketData.markPrice);
      }
      if (marketData?.price) {
        return parseFloat(marketData.price);
      }
    } catch (error: any) {
      // All methods failed
    }

    // If all methods fail, throw error
    throw new Error(`Failed to get Lighter mark price for market ${marketIndex}: All methods failed`);
  }

  /**
   * Convert symbol to market index
   * This is a simplified version - in production, you'd query available markets
   */
  async getMarketIndex(symbol: string): Promise<number> {
    const symbolToMarketIndex: Record<string, number> = {
      'ETH': 0,
      'BTC': 1,
      // Add more mappings as needed
    };

    const baseSymbol = symbol.replace('USDC', '').replace('USDT', '').replace('-PERP', '');
    return symbolToMarketIndex[baseSymbol] ?? 0; // Default to 0 (ETH/USDC)
  }

  /**
   * Get all available markets from Lighter
   * Uses the Explorer API: https://explorer.elliot.ai/api/markets
   * @returns Array of objects with marketIndex and symbol
   */
  async getAvailableMarkets(): Promise<Array<{ marketIndex: number; symbol: string }>> {
    try {
      // Use the Explorer API to get all markets
      // Based on: https://apidocs.lighter.xyz/reference/get_markets
      const explorerUrl = 'https://explorer.elliot.ai/api/markets';
      
      const response = await axios.get(explorerUrl, {
        timeout: 10000,
      });

      if (!response.data || !Array.isArray(response.data)) {
        this.logger.warn('Lighter Explorer API returned invalid data format');
        // Fallback: try orderBooks API
        return await this.getAvailableMarketsFallback();
      }

      // Map markets to our format
      // The API returns: [{"symbol":"JUP","market_index":26},{"symbol":"ADA","market_index":39},...]
      const markets = response.data.map((market: any) => {
        // API uses "market_index" (with underscore)
        const marketIndex = market.market_index ?? market.marketIndex ?? market.index ?? 0;
        const symbol = market.symbol || market.baseAsset || market.name || `MARKET_${marketIndex}`;
        
        // Normalize symbol (remove USDC/USDT suffixes, already normalized from API)
        const normalizedSymbol = symbol
          .replace('USDC', '')
          .replace('USDT', '')
          .replace('-PERP', '')
          .replace('PERP', '')
          .toUpperCase();

        return {
          marketIndex: Number(marketIndex),
          symbol: normalizedSymbol,
        };
      });

      this.logger.debug(`Found ${markets.length} available markets on Lighter via Explorer API`);
      return markets;
    } catch (error: any) {
      this.logger.warn(`Failed to get markets from Lighter Explorer API: ${error.message}`);
      // Fallback: try orderBooks API
      return await this.getAvailableMarketsFallback();
    }
  }

  /**
   * Fallback method to get markets using orderBooks API
   */
  private async getAvailableMarketsFallback(): Promise<Array<{ marketIndex: number; symbol: string }>> {
    try {
      const orderBooks = await (this.apiClient as any).order?.getOrderBooks();
      
      if (!orderBooks || !Array.isArray(orderBooks)) {
        this.logger.warn('Lighter orderBooks API also failed');
        // Final fallback: return known markets
        return [
          { marketIndex: 0, symbol: 'ETH' },
          { marketIndex: 1, symbol: 'BTC' },
        ];
      }

      // Map order books to market indices and symbols
      const markets = orderBooks.map((book: any, index: number) => {
        const symbol = book.symbol || book.baseAsset || `MARKET_${index}`;
        return {
          marketIndex: index,
          symbol: symbol.replace('USDC', '').replace('USDT', '').replace('-PERP', '').toUpperCase(),
        };
      });

      this.logger.debug(`Found ${markets.length} available markets on Lighter via orderBooks API`);
      return markets;
    } catch (error: any) {
      this.logger.warn(`Failed to get markets from Lighter orderBooks API: ${error.message}`);
      // Final fallback
      return [
        { marketIndex: 0, symbol: 'ETH' },
        { marketIndex: 1, symbol: 'BTC' },
      ];
    }
  }
}

