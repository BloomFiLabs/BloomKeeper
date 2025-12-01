import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignerClient, OrderType as LighterOrderType, ApiClient, OrderApi, MarketHelper } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import { ExchangeConfig, ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../../domain/entities/PerpPosition';
import { IPerpExchangeAdapter, ExchangeError } from '../../../domain/ports/IPerpExchangeAdapter';

/**
 * LighterExchangeAdapter - Implements IPerpExchangeAdapter for Lighter Protocol
 * 
 * Based on the existing lighter-order-simple.ts script logic
 */
@Injectable()
export class LighterExchangeAdapter implements IPerpExchangeAdapter {
  private readonly logger = new Logger(LighterExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private signerClient: SignerClient | null = null;
  private orderApi: OrderApi | null = null;
  private marketHelpers: Map<number, MarketHelper> = new Map(); // marketIndex -> MarketHelper
  
  // Market index mapping cache: symbol -> marketIndex
  private marketIndexCache: Map<string, number> = new Map();
  private marketIndexCacheTimestamp: number = 0;
  private readonly MARKET_INDEX_CACHE_TTL = 3600000; // 1 hour cache

  constructor(private readonly configService: ConfigService) {
    const baseUrl = this.configService.get<string>('LIGHTER_API_BASE_URL') || 'https://mainnet.zklighter.elliot.ai';
    const apiKey = this.configService.get<string>('LIGHTER_API_KEY');
    const accountIndex = parseInt(this.configService.get<string>('LIGHTER_ACCOUNT_INDEX') || '1000');
    const apiKeyIndex = parseInt(this.configService.get<string>('LIGHTER_API_KEY_INDEX') || '1');

    if (!apiKey) {
      throw new Error('Lighter exchange requires LIGHTER_API_KEY');
    }

    // Normalize API key (remove 0x if present)
    let normalizedKey = apiKey;
    if (normalizedKey.startsWith('0x')) {
      normalizedKey = normalizedKey.slice(2);
    }

    this.config = new ExchangeConfig(
      ExchangeType.LIGHTER,
      baseUrl,
      normalizedKey,
      undefined,
      undefined,
      undefined,
      undefined,
      accountIndex,
      apiKeyIndex,
    );

    this.logger.log(`Lighter adapter initialized for account index: ${accountIndex}`);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.signerClient) {
      const normalizedKey = this.config.apiKey!;
      
      this.signerClient = new SignerClient({
        url: this.config.baseUrl,
        privateKey: normalizedKey,
        accountIndex: this.config.accountIndex!,
        apiKeyIndex: this.config.apiKeyIndex!,
      });

      await this.signerClient.initialize();
      await this.signerClient.ensureWasmClient();

      const apiClient = new ApiClient({ host: this.config.baseUrl });
      this.orderApi = new OrderApi(apiClient);
    }
  }

  private async getMarketHelper(marketIndex: number): Promise<MarketHelper> {
    if (!this.marketHelpers.has(marketIndex)) {
      await this.ensureInitialized();
      const market = new MarketHelper(marketIndex, this.orderApi!);
      await market.initialize();
      this.marketHelpers.set(marketIndex, market);
    }
    return this.marketHelpers.get(marketIndex)!;
  }

  /**
   * Fetch and cache market index mappings from Lighter Explorer API
   * API: https://explorer.elliot.ai/api/markets
   * Docs: https://apidocs.lighter.xyz/reference/get_markets
   */
  private async refreshMarketIndexCache(): Promise<void> {
    const now = Date.now();
    
    // Use cache if fresh
    if (this.marketIndexCache.size > 0 && (now - this.marketIndexCacheTimestamp) < this.MARKET_INDEX_CACHE_TTL) {
      return;
    }

    try {
      this.logger.debug('Fetching market index mappings from Lighter Explorer API...');
      
      const explorerUrl = 'https://explorer.elliot.ai/api/markets';
      const response = await axios.get(explorerUrl, {
        timeout: 10000,
        headers: { accept: 'application/json' },
      });

      if (!response.data || !Array.isArray(response.data)) {
        this.logger.warn('Lighter Explorer API returned invalid data format');
        return;
      }

      // Clear old cache
      this.marketIndexCache.clear();

      // Parse response: [{ "symbol": "ETH", "market_index": 0 }, ...]
      for (const market of response.data) {
        // API uses "market_index" (with underscore)
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
          
          this.marketIndexCache.set(normalizedSymbol, Number(marketIndex));
        }
      }

      this.marketIndexCacheTimestamp = now;
      this.logger.log(`Cached ${this.marketIndexCache.size} market index mappings from Lighter Explorer API`);
    } catch (error: any) {
      this.logger.warn(`Failed to fetch market index mappings from Explorer API: ${error.message}`);
      // Don't throw - allow fallback to hardcoded mapping
    }
  }

  /**
   * Convert symbol to market index
   * Uses cached Explorer API data, with fallback to hardcoded mapping
   */
  private async getMarketIndex(symbol: string): Promise<number> {
    // Refresh cache if needed
    await this.refreshMarketIndexCache();

    // Normalize symbol
    const baseSymbol = symbol.replace('USDC', '').replace('USDT', '').replace('-PERP', '').toUpperCase();

    // Try cached mapping first
    const cachedIndex = this.marketIndexCache.get(baseSymbol);
    if (cachedIndex !== undefined) {
      return cachedIndex;
    }

    // Fallback: Try querying order books API
    try {
      const apiClient = new ApiClient({ host: this.config.baseUrl });
      const orderBooks = await (apiClient as any).order?.getOrderBooks();
      
      if (orderBooks && Array.isArray(orderBooks)) {
        for (let i = 0; i < orderBooks.length; i++) {
          const book = orderBooks[i];
          const bookSymbol = (book.symbol || book.baseAsset || '')
            .replace('USDC', '')
            .replace('USDT', '')
            .replace('-PERP', '')
            .toUpperCase();
          if (bookSymbol === baseSymbol) {
            // Cache the result
            this.marketIndexCache.set(baseSymbol, i);
            return i;
          }
        }
      }
    } catch (error) {
      // Fall back to hardcoded mapping
    }

    // Final fallback: Hardcoded common market indices
    const symbolToMarketIndex: Record<string, number> = {
      'ETH': 0,
      'BTC': 1,
      // Add more as needed
    };

    const fallbackIndex = symbolToMarketIndex[baseSymbol] ?? 0;
    this.logger.warn(
      `Market index not found for ${symbol} (${baseSymbol}), using fallback index: ${fallbackIndex}. ` +
      `Consider checking Lighter Explorer API: https://explorer.elliot.ai/api/markets`
    );
    return fallbackIndex;
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): string {
    return ExchangeType.LIGHTER;
  }

  async placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse> {
    try {
      await this.ensureInitialized();

      const marketIndex = await this.getMarketIndex(request.symbol);
      const market = await this.getMarketHelper(marketIndex);

      const isBuy = request.side === OrderSide.LONG;
      const isAsk = !isBuy;

      // Convert size to market units
      const baseAmount = market.amountToUnits(request.size);

      let orderParams: any;
      if (request.type === OrderType.MARKET) {
        // For market orders, we need to use a limit order with current market price
        // Cast to any since SDK types may be incomplete (script shows this works)
        const orderBook = await this.orderApi!.getOrderBookDetails({ marketIndex: marketIndex } as any) as any;
        const price = isBuy 
          ? parseFloat(orderBook.bestAsk?.price || '0')
          : parseFloat(orderBook.bestBid?.price || '0');
        
        orderParams = {
          marketIndex,
          clientOrderIndex: Date.now(),
          baseAmount,
          price: market.priceToUnits(price),
          isAsk,
          orderType: LighterOrderType.MARKET,
          orderExpiry: Date.now() + 3600000, // 1 hour expiry
        };
      } else {
        // Limit order
        if (!request.price) {
          throw new Error('Limit price is required for LIMIT orders');
        }

        orderParams = {
          marketIndex,
          clientOrderIndex: Date.now(),
          baseAmount,
          price: market.priceToUnits(request.price),
          isAsk,
          orderType: LighterOrderType.LIMIT,
          orderExpiry: Date.now() + 3600000, // 1 hour expiry
        };
      }

      const result = await this.signerClient!.createUnifiedOrder(orderParams);

      if (!result.success) {
        const errorMsg = result.mainOrder.error || 'Order creation failed';
        throw new Error(errorMsg);
      }

      const orderId = result.mainOrder.hash;
      
      // Wait for transaction to be processed (matching script behavior)
      try {
        await this.signerClient!.waitForTransaction(orderId, 30000, 2000);
      } catch (error: any) {
        // Transaction wait might fail, but order may still be submitted
        this.logger.warn(`Order transaction wait failed: ${error.message}`);
      }

      // Check if order was filled immediately or is resting
      // Lighter doesn't provide immediate fill status, so we mark as SUBMITTED
      // The actual status can be checked later via getOrderStatus
      const status = OrderStatus.SUBMITTED;

      return new PerpOrderResponse(
        orderId,
        status,
        request.symbol,
        request.side,
        request.clientOrderId,
        undefined,
        undefined,
        undefined,
        new Date(),
      );
    } catch (error: any) {
      this.logger.error(`Failed to place order: ${error.message}`);
      throw new ExchangeError(
        `Failed to place order: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async getPosition(symbol: string): Promise<PerpPosition | null> {
    try {
      const positions = await this.getPositions();
      return positions.find((p) => p.symbol === symbol) || null;
    } catch (error: any) {
      this.logger.error(`Failed to get position: ${error.message}`);
      throw new ExchangeError(
        `Failed to get position: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async getPositions(): Promise<PerpPosition[]> {
    try {
      await this.ensureInitialized();
      
      // Lighter SDK doesn't have a direct positions endpoint
      // You would need to query positions through the account API
      // For now, return empty array - this would need to be implemented based on Lighter's API
      this.logger.warn('Lighter positions query not fully implemented');
      return [];
    } catch (error: any) {
      this.logger.error(`Failed to get positions: ${error.message}`);
      throw new ExchangeError(
        `Failed to get positions: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      await this.ensureInitialized();
      
      // Lighter uses order hash for cancellation
      // SDK signature may require different parameters - cast to any for now
      await (this.signerClient!.cancelOrder as any)(orderId);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel order: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    try {
      await this.ensureInitialized();
      
      const marketIndex = await this.getMarketIndex(symbol);
      
      // Cancel all orders for the market
      // SDK requires timeInForce and time parameters - use current time
      const timeInForce = 0; // GTC
      const time = Math.floor(Date.now() / 1000);
      await this.signerClient!.cancelAllOrders(timeInForce, time);
      
      // Lighter doesn't return count, so we return 1 as a placeholder
      return 1;
    } catch (error: any) {
      this.logger.error(`Failed to cancel all orders: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel all orders: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    try {
      await this.ensureInitialized();
      
      // Lighter SDK doesn't have getOrder method on OrderApi
      // For now, return a default response indicating order was submitted
      // In production, you would need to query Lighter's API directly or use a different SDK method
      this.logger.warn('getOrderStatus not fully implemented for Lighter - SDK limitation');
      
      return new PerpOrderResponse(
        orderId,
        OrderStatus.SUBMITTED,
        symbol || 'UNKNOWN',
        OrderSide.LONG, // Default, actual side unknown without order data
        undefined,
        undefined,
        undefined,
        undefined,
        new Date(),
      );
    } catch (error: any) {
      this.logger.error(`Failed to get order status: ${error.message}`);
      throw new ExchangeError(
        `Failed to get order status: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  private mapLighterOrderStatus(lighterStatus: string): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      PENDING: OrderStatus.PENDING,
      OPEN: OrderStatus.SUBMITTED,
      FILLED: OrderStatus.FILLED,
      PARTIALLY_FILLED: OrderStatus.PARTIALLY_FILLED,
      CANCELLED: OrderStatus.CANCELLED,
      REJECTED: OrderStatus.REJECTED,
    };
    return statusMap[lighterStatus] || OrderStatus.PENDING;
  }

  // Price cache: key = symbol, value = { price: number, timestamp: number }
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly PRICE_CACHE_TTL = 10000; // 10 seconds cache

  async getMarkPrice(symbol: string): Promise<number> {
    // Check cache first
    const cached = this.priceCache.get(symbol);
    if (cached && (Date.now() - cached.timestamp) < this.PRICE_CACHE_TTL) {
      return cached.price;
    }

    try {
      await this.ensureInitialized();
      
      const marketIndex = await this.getMarketIndex(symbol);
      let markPrice: number | null = null;
      let lastError: string | null = null;

      // Method 1: Try order book first (most accurate)
      try {
        const response = await this.orderApi!.getOrderBookDetails({ marketIndex: marketIndex } as any) as any;
        
        // Response structure: { code: 200, order_book_details: { bestBid: {...}, bestAsk: {...} } }
        const orderBook = response?.order_book_details || response;
        const bestBid = orderBook?.bestBid || orderBook?.best_bid;
        const bestAsk = orderBook?.bestAsk || orderBook?.best_ask;
        
        if (bestBid?.price && bestAsk?.price) {
          markPrice = (parseFloat(bestBid.price) + parseFloat(bestAsk.price)) / 2;
          if (markPrice > 0) {
            this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
            return markPrice;
          }
        }
      } catch (orderBookError: any) {
        lastError = `Order book: ${orderBookError.message}`;
        this.logger.debug(`Order book method failed for ${symbol}: ${orderBookError.message}`);
      }

      // Method 2: Try funding rates API (may include mark price) - this is cached by LighterFundingDataProvider
      try {
        const baseUrl = this.configService.get<string>('LIGHTER_API_BASE_URL') || 'https://mainnet.zklighter.elliot.ai';
        const fundingUrl = `${baseUrl}/api/v1/funding-rates`;
        const response = await axios.get(fundingUrl, {
          timeout: 10000,
        });

        // Handle different response structures
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
              markPrice = parseFloat(marketRate.mark_price);
            } else if (marketRate.price) {
              markPrice = parseFloat(marketRate.price);
            } else if (marketRate.lastPrice) {
              markPrice = parseFloat(marketRate.lastPrice);
            }
            
            if (markPrice && markPrice > 0) {
              this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
              return markPrice;
            }
          }
        }
      } catch (fundingError: any) {
        lastError = `Funding rates API: ${fundingError.message}`;
        this.logger.debug(`Funding rates API method failed for ${symbol}: ${fundingError.message}`);
      }

      // Method 3: Try Explorer API: https://explorer.elliot.ai/api/markets/{SYMBOL}/logs
      // Retry up to 2 times with exponential backoff
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000)); // 2s, 4s delays
          }

          const explorerUrl = `https://explorer.elliot.ai/api/markets/${symbol}/logs`;
          const response = await axios.get(explorerUrl, {
            timeout: 10000,
            headers: { accept: 'application/json' },
          });

          // Try multiple response structures
          if (response.data) {
            // Structure 1: Direct price fields
            if (typeof response.data === 'object' && !Array.isArray(response.data)) {
              if (response.data.price && !isNaN(parseFloat(response.data.price))) {
                markPrice = parseFloat(response.data.price);
              } else if (response.data.markPrice && !isNaN(parseFloat(response.data.markPrice))) {
                markPrice = parseFloat(response.data.markPrice);
              } else if (response.data.lastPrice && !isNaN(parseFloat(response.data.lastPrice))) {
                markPrice = parseFloat(response.data.lastPrice);
              }
              // Structure 2: Nested data object
              else if (response.data.data) {
                if (response.data.data.price) markPrice = parseFloat(response.data.data.price);
                else if (response.data.data.markPrice) markPrice = parseFloat(response.data.data.markPrice);
                else if (response.data.data.lastPrice) markPrice = parseFloat(response.data.data.lastPrice);
              }
              // Structure 3: Array of logs (get latest)
              else if (Array.isArray(response.data) && response.data.length > 0) {
                const latest = response.data[0];
                if (latest.price) markPrice = parseFloat(latest.price);
                else if (latest.markPrice) markPrice = parseFloat(latest.markPrice);
                else if (latest.lastPrice) markPrice = parseFloat(latest.lastPrice);
                else if (latest.price_usd) markPrice = parseFloat(latest.price_usd);
              }
            }
            // Structure 4: Direct array
            else if (Array.isArray(response.data) && response.data.length > 0) {
              const latest = response.data[0];
              if (latest.price) markPrice = parseFloat(latest.price);
              else if (latest.markPrice) markPrice = parseFloat(latest.markPrice);
              else if (latest.lastPrice) markPrice = parseFloat(latest.lastPrice);
            }

            if (markPrice && markPrice > 0) {
              this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
              return markPrice;
            }
          }
        } catch (explorerError: any) {
          lastError = `Explorer API (attempt ${attempt + 1}): ${explorerError.message}`;
          if (attempt === 2) {
            this.logger.debug(`Explorer API method failed for ${symbol} after 3 attempts: ${explorerError.message}`);
          }
        }
      }

      // Method 4: Try market data API as last resort
      try {
        await this.ensureInitialized();
        const apiClient = new ApiClient({ host: this.config.baseUrl });
        const marketData = await (apiClient as any).market?.getMarketData({ marketIndex });
        if (marketData?.markPrice && !isNaN(parseFloat(marketData.markPrice))) {
          markPrice = parseFloat(marketData.markPrice);
        } else if (marketData?.price && !isNaN(parseFloat(marketData.price))) {
          markPrice = parseFloat(marketData.price);
        }
        
        if (markPrice && markPrice > 0) {
          this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
          return markPrice;
        }
      } catch (marketDataError: any) {
        lastError = `Market data API: ${marketDataError.message}`;
        this.logger.debug(`Market data API method failed for ${symbol}: ${marketDataError.message}`);
      }
      
      // All methods failed
      const errorMsg = `Unable to determine mark price for ${symbol} (marketIndex: ${marketIndex}). ` +
        `Tried: order book, funding rates API, explorer API (3 attempts), market data API. ` +
        `Last error: ${lastError || 'unknown'}`;
      throw new Error(errorMsg);
    } catch (error: any) {
      this.logger.error(`Failed to get mark price for ${symbol}: ${error.message}`);
      throw new ExchangeError(
        `Failed to get mark price: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async getBalance(): Promise<number> {
    try {
      // Use AccountApi from SDK - it works and returns the correct structure
      // Based on official docs: https://apidocs.lighter.xyz/reference/account-1
      // The response is wrapped in { code: 200, accounts: [...] }
      const apiClient = new ApiClient({ host: this.config.baseUrl });
      const { AccountApi } = await import('@reservoir0x/lighter-ts-sdk');
      const accountApi = new AccountApi(apiClient);
      
      const accountIndex = this.config.accountIndex!;
      
      // Call getAccount with proper parameters
      const response = await (accountApi.getAccount as any)({ 
        by: 'index', 
        value: String(accountIndex) 
      });

      // Response structure from actual API call:
      // { code: 200, total: 1, accounts: [{ collateral, available_balance, status, ... }] }
      if (response && response.code === 200 && response.accounts && response.accounts.length > 0) {
        const account = response.accounts[0];
        // Use available_balance or collateral (they should be the same)
        const balance = parseFloat(account.available_balance || account.collateral || '0');
        const status = account.status === 1 ? 'active' : 'inactive';
        this.logger.debug(`Lighter balance retrieved: $${balance.toFixed(2)} (Status: ${status}, Index: ${account.index})`);
        return balance;
      }

      // Fallback: try direct REST API call if SDK response structure is different
      try {
        const httpResponse = await axios.get(`${this.config.baseUrl}/api/v1/account`, {
          params: {
            by: 'index',
            value: String(accountIndex),
          },
          timeout: 10000,
        });

        if (httpResponse.data && httpResponse.data.collateral !== undefined) {
          const balance = parseFloat(httpResponse.data.collateral || '0');
          this.logger.debug(`Lighter balance retrieved (REST fallback): $${balance.toFixed(2)}`);
          return balance;
        }
      } catch (httpError: any) {
        this.logger.debug(`REST API fallback failed: ${httpError.message}`);
      }

      this.logger.warn('Lighter account API returned data but no balance found');
      return 0;
    } catch (error: any) {
      this.logger.error(`Failed to get balance: ${error.message}`);
      if (error.response) {
        this.logger.debug(`Lighter API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      }
      // Return 0 instead of throwing to allow system to continue
      this.logger.warn('Returning 0 balance due to error - Lighter balance query may need authentication');
      return 0;
    }
  }

  async getEquity(): Promise<number> {
    try {
      // For Lighter, equity is typically the same as balance
      return await this.getBalance();
    } catch (error: any) {
      this.logger.error(`Failed to get equity: ${error.message}`);
      throw new ExchangeError(
        `Failed to get equity: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.testConnection();
      return true;
    } catch {
      return false;
    }
  }

  async testConnection(): Promise<void> {
    try {
      await this.ensureInitialized();
      // Test by trying to get order book (more reliable than account API)
      const apiClient = new ApiClient({ host: this.config.baseUrl });
      const orderApi = new OrderApi(apiClient);
      // Try to get order book for market 0 (ETH/USDC) as a connection test
      await orderApi.getOrderBookDetails({ marketIndex: 0 } as any);
    } catch (error: any) {
      throw new ExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }
}

