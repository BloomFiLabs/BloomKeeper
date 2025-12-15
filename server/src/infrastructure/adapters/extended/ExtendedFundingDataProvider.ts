import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/**
 * ExtendedFundingDataProvider - Fetches funding rate data from Extended exchange
 * 
 * Extended API endpoints (Starknet instance):
 * - GET /api/v1/info/markets - List all markets with stats
 * - GET /api/v1/info/markets/{market}/stats - Market stats including funding rate
 * - GET /api/v1/info/{market}/funding - Historical funding rates
 * - GET /api/v1/info/{market}/open-interests - Open interest history
 * 
 * API Docs: https://api.docs.extended.exchange/
 */
@Injectable()
export class ExtendedFundingDataProvider {
  private readonly logger = new Logger(ExtendedFundingDataProvider.name);
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  
  // Cache for market info
  private marketInfoCache: Map<string, any> = new Map();
  private marketCacheTimestamp: number = 0;
  private readonly MARKET_CACHE_TTL = 3600000; // 1 hour
  
  // Track API availability to avoid spamming a dead API
  private isApiAvailable: boolean = true;
  private lastApiCheckTime: number = 0;
  private readonly API_CHECK_INTERVAL = 300000; // 5 minutes - don't retry too frequently
  private consecutiveFailures: number = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3; // Disable after 3 consecutive failures

  constructor(private readonly configService: ConfigService) {
    // Extended Starknet instance base URL
    const baseUrl = this.configService.get<string>('EXTENDED_API_BASE_URL') || 
                    'https://api.starknet.extended.exchange';
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'User-Agent': 'Bloom-Vault-Bot/1.0',  // Required header
      },
    });
  }

  /**
   * Check if the API should be considered unavailable
   */
  private shouldSkipApiCall(): boolean {
    if (!this.isApiAvailable) {
      const now = Date.now();
      // Re-check periodically to see if API came back online
      if ((now - this.lastApiCheckTime) < this.API_CHECK_INTERVAL) {
        return true; // Skip, API is disabled and not enough time has passed
      }
      // Enough time has passed, allow a retry
      this.logger.debug('Extended API was disabled, attempting to reconnect...');
    }
    return false;
  }

  /**
   * Refresh market info cache
   * API: GET /api/v1/info/markets
   */
  private async refreshMarketCache(): Promise<void> {
    const now = Date.now();
    
    // Check if we should skip due to API being unavailable
    if (this.shouldSkipApiCall()) {
      return;
    }
    
    // Check if cache is still valid
    if (this.marketInfoCache.size > 0 && (now - this.marketCacheTimestamp) < this.MARKET_CACHE_TTL) {
      return;
    }

    try {
      this.lastApiCheckTime = now;
      const response = await this.client.get('/api/v1/info/markets');
      if (response.data?.status === 'ok' && Array.isArray(response.data.data)) {
        this.marketInfoCache.clear();
        for (const market of response.data.data) {
          if (market.name) {
            // Store by market name (e.g., "BTC-USD") and asset name (e.g., "BTC")
            this.marketInfoCache.set(market.name.toUpperCase(), market);
            if (market.assetName) {
              this.marketInfoCache.set(market.assetName.toUpperCase(), market);
            }
          }
        }
        this.marketCacheTimestamp = now;
        this.consecutiveFailures = 0;
        this.isApiAvailable = true;
        this.logger.debug(`Cached ${this.marketInfoCache.size} markets from Extended API`);
      }
    } catch (error: any) {
      this.consecutiveFailures++;
      
      if (this.consecutiveFailures === 1) {
        this.logger.debug(`Extended API unavailable: ${error.message}`);
      }
      
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES && this.isApiAvailable) {
        this.isApiAvailable = false;
        this.logger.warn(
          `Extended API disabled after ${this.consecutiveFailures} consecutive failures. ` +
          `Will retry in ${this.API_CHECK_INTERVAL / 60000} minutes.`
        );
      }
    }
  }

  /**
   * Get market name for a symbol (Extended uses "BTC-USD" format)
   */
  private async getMarketName(symbol: string): Promise<string> {
    await this.refreshMarketCache();
    
    // Normalize: remove common suffixes
    const normalized = symbol.toUpperCase()
      .replace('USDC', '')
      .replace('USDT', '')
      .replace('-PERP', '')
      .replace('-USD', '');
    
    // Try as market name first
    if (this.marketInfoCache.has(`${normalized}-USD`)) {
      return `${normalized}-USD`;
    }
    
    // Try as asset name
    const market = this.marketInfoCache.get(normalized);
    if (market?.name) {
      return market.name;
    }
    
    // Default format
    return `${normalized}-USD`;
  }

  /**
   * Get current funding rate for a symbol
   * API: GET /api/v1/info/markets/{market}/stats
   * Funding rate is in marketStats.fundingRate
   * 
   * @param symbol Trading symbol (e.g., 'ETH', 'BTC')
   * @returns Funding rate as decimal (e.g., 0.0001 = 0.01%)
   */
  async getCurrentFundingRate(symbol: string): Promise<number> {
    if (!this.isApiAvailable && this.shouldSkipApiCall()) {
      throw new Error('Extended API is temporarily disabled');
    }

    try {
      const marketName = await this.getMarketName(symbol);
      const response = await this.client.get(`/api/v1/info/markets/${marketName}/stats`);

      if (response.data?.status !== 'OK' || !response.data.data) {
        throw new Error(`Invalid response for ${symbol}`);
      }

      // Funding rate is calculated every minute, per API docs
      const fundingRate = parseFloat(response.data.data.fundingRate || '0');
      
      if (isNaN(fundingRate)) {
        throw new Error(`Invalid funding rate format: ${response.data.data.fundingRate}`);
      }

      this.consecutiveFailures = 0;
      this.isApiAvailable = true;
      return fundingRate;
    } catch (error: any) {
      this.consecutiveFailures++;
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      
      if (this.isApiAvailable) {
        this.logger.debug(`Failed to get funding rate for ${symbol}: ${errorMsg}`);
      }
      
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES && this.isApiAvailable) {
        this.isApiAvailable = false;
      }
      
      throw new Error(`Failed to get Extended funding rate: ${errorMsg}`);
    }
  }

  /**
   * Get predicted next funding rate
   * Extended doesn't provide predicted rate, so we use current rate
   * 
   * @param symbol Trading symbol
   * @returns Funding rate as decimal
   */
  async getPredictedFundingRate(symbol: string): Promise<number> {
    // Extended calculates funding rate every minute and applies hourly
    // No separate "predicted" rate endpoint - use current rate
    return await this.getCurrentFundingRate(symbol);
  }

  /**
   * Get open interest for a symbol
   * API: GET /api/v1/info/markets/{market}/stats
   * Open interest is in marketStats.openInterest (in USD)
   * 
   * @param symbol Trading symbol
   * @returns Open interest in USD
   */
  async getOpenInterest(symbol: string): Promise<number> {
    if (!this.isApiAvailable && this.shouldSkipApiCall()) {
      throw new Error('Extended API is temporarily disabled');
    }

    try {
      const marketName = await this.getMarketName(symbol);
      const response = await this.client.get(`/api/v1/info/markets/${marketName}/stats`);

      if (response.data?.status !== 'OK' || !response.data.data) {
        throw new Error(`Invalid response for ${symbol}`);
      }

      // openInterest is in collateral asset (USD), openInterestBase is in base asset
      const openInterestUsd = parseFloat(response.data.data.openInterest || '0');
      
      if (isNaN(openInterestUsd) || openInterestUsd < 0) {
        throw new Error(`Invalid OI: ${response.data.data.openInterest}`);
      }

      this.consecutiveFailures = 0;
      this.isApiAvailable = true;
      return openInterestUsd;
    } catch (error: any) {
      this.consecutiveFailures++;
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      
      if (this.isApiAvailable) {
        this.logger.debug(`Failed to get open interest for ${symbol}: ${errorMsg}`);
      }
      
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES && this.isApiAvailable) {
        this.isApiAvailable = false;
      }
      
      throw new Error(`Failed to get Extended open interest: ${errorMsg}`);
    }
  }

  /**
   * Get mark price for a symbol
   * API: GET /api/v1/info/markets/{market}/stats
   * Mark price is in marketStats.markPrice
   * 
   * @param symbol Trading symbol
   * @returns Mark price
   */
  async getMarkPrice(symbol: string): Promise<number> {
    if (!this.isApiAvailable && this.shouldSkipApiCall()) {
      throw new Error('Extended API is temporarily disabled');
    }

    try {
      const marketName = await this.getMarketName(symbol);
      const response = await this.client.get(`/api/v1/info/markets/${marketName}/stats`);

      if (response.data?.status !== 'OK' || !response.data.data) {
        throw new Error(`Invalid response for ${symbol}`);
      }

      const markPrice = parseFloat(response.data.data.markPrice || '0');
      
      if (isNaN(markPrice) || markPrice <= 0) {
        throw new Error(`Invalid mark price: ${response.data.data.markPrice}`);
      }

      this.consecutiveFailures = 0;
      this.isApiAvailable = true;
      return markPrice;
    } catch (error: any) {
      this.consecutiveFailures++;
      const errorMsg = error.response?.data?.error?.message || error.message || String(error);
      
      if (this.isApiAvailable) {
        this.logger.debug(`Failed to get mark price for ${symbol}: ${errorMsg}`);
      }
      
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES && this.isApiAvailable) {
        this.isApiAvailable = false;
      }
      
      throw new Error(`Failed to get Extended mark price: ${errorMsg}`);
    }
  }
}

