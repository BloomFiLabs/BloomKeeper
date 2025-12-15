import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/**
 * ExtendedFundingDataProvider - Fetches funding rate data from Extended exchange
 * 
 * Extended API endpoints:
 * - GET /v1/public/markets/{marketId}/funding-rate - Current funding rate
 * - GET /v1/public/markets/{marketId}/open-interest - Open interest
 * - GET /v1/public/markets/{marketId}/mark-price - Mark price
 */
@Injectable()
export class ExtendedFundingDataProvider {
  private readonly logger = new Logger(ExtendedFundingDataProvider.name);
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  
  // Cache for symbol -> market ID mapping
  private symbolToMarketIdCache: Map<string, string> = new Map();
  private marketIdCacheTimestamp: number = 0;
  private readonly MARKET_ID_CACHE_TTL = 3600000; // 1 hour
  
  // Track API availability to avoid spamming a dead API
  private isApiAvailable: boolean = true;
  private lastApiCheckTime: number = 0;
  private readonly API_CHECK_INTERVAL = 300000; // 5 minutes - don't retry too frequently
  private consecutiveFailures: number = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3; // Disable after 3 consecutive failures

  constructor(private readonly configService: ConfigService) {
    const baseUrl = this.configService.get<string>('EXTENDED_API_BASE_URL') || 'https://api.extended.exchange';
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
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
   * Refresh symbol to market ID cache
   */
  private async refreshSymbolCache(): Promise<void> {
    const now = Date.now();
    
    // Check if we should skip due to API being unavailable
    if (this.shouldSkipApiCall()) {
      return;
    }
    
    // Check if cache is still valid
    if (this.symbolToMarketIdCache.size > 0 && (now - this.marketIdCacheTimestamp) < this.MARKET_ID_CACHE_TTL) {
      return;
    }

    try {
      this.lastApiCheckTime = now;
      const response = await this.client.get('/v1/public/markets');
      if (response.data && Array.isArray(response.data)) {
        this.symbolToMarketIdCache.clear();
        for (const market of response.data) {
          if (market.symbol && market.marketId) {
            this.symbolToMarketIdCache.set(market.symbol.toUpperCase(), market.marketId);
          }
        }
        this.marketIdCacheTimestamp = now;
        this.consecutiveFailures = 0; // Reset on success
        this.isApiAvailable = true;
        this.logger.debug(`Cached ${this.symbolToMarketIdCache.size} market IDs from Extended API`);
      }
    } catch (error: any) {
      this.consecutiveFailures++;
      
      // Only log on first failure or when disabling
      if (this.consecutiveFailures === 1) {
        this.logger.debug(`Extended API unavailable: ${error.message}`);
      }
      
      // Disable API after too many consecutive failures
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
   * Get market ID for a symbol
   */
  private async getMarketId(symbol: string): Promise<string> {
    await this.refreshSymbolCache();
    const normalizedSymbol = symbol.toUpperCase().replace('USDC', '').replace('USDT', '').replace('-PERP', '');
    const marketId = this.symbolToMarketIdCache.get(normalizedSymbol);
    if (!marketId) {
      throw new Error(`Market not found for symbol: ${symbol}`);
    }
    return marketId;
  }

  /**
   * Get current funding rate for a symbol
   * @param symbol Trading symbol (e.g., 'ETH', 'BTC')
   * @returns Funding rate as decimal (e.g., 0.0001 = 0.01%)
   */
  async getCurrentFundingRate(symbol: string): Promise<number> {
    // Skip if API is disabled
    if (!this.isApiAvailable && this.shouldSkipApiCall()) {
      throw new Error('Extended API is temporarily disabled');
    }

    try {
      const marketId = await this.getMarketId(symbol);
      const response = await this.client.get(`/v1/public/markets/${marketId}/funding-rate`);

      // Extended returns funding rate as decimal (e.g., 0.0001 = 0.01%)
      const fundingRate = parseFloat(response.data.fundingRate || response.data.rate || '0');
      
      if (isNaN(fundingRate)) {
        throw new Error(`Invalid funding rate format: ${response.data.fundingRate}`);
      }

      return fundingRate;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      // Only log if API is supposedly available (avoid spam when disabled)
      if (this.isApiAvailable) {
        this.logger.debug(`Failed to get funding rate for ${symbol}: ${errorMsg}`);
      }
      throw new Error(`Failed to get Extended funding rate: ${errorMsg}`);
    }
  }

  /**
   * Get predicted next funding rate
   * @param symbol Trading symbol
   * @returns Predicted funding rate as decimal
   */
  async getPredictedFundingRate(symbol: string): Promise<number> {
    try {
      const marketId = await this.getMarketId(symbol);
      const response = await this.client.get(`/v1/public/markets/${marketId}/funding-rate`);

      // Extended may provide predicted rate, otherwise use current
      const predictedRate = parseFloat(
        response.data.predictedRate || 
        response.data.nextFundingRate || 
        response.data.fundingRate || 
        '0'
      );

      if (isNaN(predictedRate)) {
        // Fallback to current rate
        return await this.getCurrentFundingRate(symbol);
      }

      return predictedRate;
    } catch (error: any) {
      // Fallback to current rate if prediction unavailable
      this.logger.warn(`Failed to get predicted funding rate for ${symbol}, using current: ${error.message}`);
      return await this.getCurrentFundingRate(symbol);
    }
  }

  /**
   * Get open interest for a symbol
   * @param symbol Trading symbol
   * @returns Open interest in USD
   */
  async getOpenInterest(symbol: string): Promise<number> {
    // Skip if API is disabled
    if (!this.isApiAvailable && this.shouldSkipApiCall()) {
      throw new Error('Extended API is temporarily disabled');
    }

    try {
      const marketId = await this.getMarketId(symbol);
      const response = await this.client.get(`/v1/public/markets/${marketId}/open-interest`);

      // Extended may return OI in base asset or USD
      const openInterestRaw = response.data.openInterest || response.data.oi;
      const openInterestUsd = response.data.openInterestUsd || response.data.oiUsd;

      if (openInterestUsd !== undefined && openInterestUsd !== null) {
        const oi = parseFloat(openInterestUsd);
        if (isNaN(oi) || oi < 0) {
          throw new Error(`Invalid OI USD: ${openInterestUsd}`);
        }
        return oi;
      }

      // If OI is in base asset, convert to USD using mark price
      if (openInterestRaw !== undefined && openInterestRaw !== null) {
        const oi = parseFloat(openInterestRaw);
        if (isNaN(oi) || oi < 0) {
          throw new Error(`Invalid OI: ${openInterestRaw}`);
        }

        // Get mark price to convert to USD
        const markPrice = await this.getMarkPrice(symbol);
        if (isNaN(markPrice) || markPrice <= 0) {
          throw new Error(`Invalid mark price: ${markPrice}`);
        }

        const oiUsd = oi * markPrice;
        if (isNaN(oiUsd) || oiUsd < 0) {
          throw new Error(`Invalid calculated OI USD: ${oiUsd}`);
        }

        return oiUsd;
      }

      throw new Error(`Open interest not found in response: ${JSON.stringify(response.data)}`);
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      // Only log if API is supposedly available
      if (this.isApiAvailable) {
        this.logger.debug(`Failed to get open interest for ${symbol}: ${errorMsg}`);
      }
      throw new Error(`Failed to get Extended open interest: ${errorMsg}`);
    }
  }

  /**
   * Get mark price for a symbol
   * @param symbol Trading symbol
   * @returns Mark price
   */
  async getMarkPrice(symbol: string): Promise<number> {
    // Skip if API is disabled
    if (!this.isApiAvailable && this.shouldSkipApiCall()) {
      throw new Error('Extended API is temporarily disabled');
    }

    try {
      const marketId = await this.getMarketId(symbol);
      const response = await this.client.get(`/v1/public/markets/${marketId}/mark-price`);

      const markPrice = parseFloat(response.data.markPrice || response.data.price || '0');
      
      if (isNaN(markPrice) || markPrice <= 0) {
        throw new Error(`Invalid mark price: ${response.data.markPrice}`);
      }

      return markPrice;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      // Only log if API is supposedly available
      if (this.isApiAvailable) {
        this.logger.debug(`Failed to get mark price for ${symbol}: ${errorMsg}`);
      }
      throw new Error(`Failed to get Extended mark price: ${errorMsg}`);
    }
  }
}

