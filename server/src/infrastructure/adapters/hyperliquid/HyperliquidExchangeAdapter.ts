import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter, formatSize, formatPrice } from '@nktkas/hyperliquid/utils';
import { ethers } from 'ethers';
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
import { HyperLiquidDataProvider } from './HyperLiquidDataProvider';

/**
 * HyperliquidExchangeAdapter - Implements IPerpExchangeAdapter for Hyperliquid
 * 
 * Uses the @nktkas/hyperliquid SDK
 * Uses WebSocket data provider to reduce rate limits (REST API has 1200 weight/minute limit)
 */
@Injectable()
export class HyperliquidExchangeAdapter implements IPerpExchangeAdapter {
  private readonly logger = new Logger(HyperliquidExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private readonly transport: HttpTransport;
  private readonly exchangeClient: ExchangeClient;
  private readonly infoClient: InfoClient;
  private symbolConverter: SymbolConverter | null = null;
  private walletAddress: string;

  // Balance cache: reduce clearinghouseState calls (weight 2 each, 1200 weight/minute limit)
  private balanceCache: { balance: number; timestamp: number } | null = null;
  private readonly BALANCE_CACHE_TTL = 30000; // 30 seconds cache

  constructor(
    private readonly configService: ConfigService,
    private readonly dataProvider: HyperLiquidDataProvider,
  ) {
    const privateKey = this.configService.get<string>('PRIVATE_KEY') || this.configService.get<string>('HYPERLIQUID_PRIVATE_KEY');
    const isTestnet = this.configService.get<boolean>('HYPERLIQUID_TESTNET') || false;

    if (!privateKey) {
      throw new Error('Hyperliquid exchange requires PRIVATE_KEY or HYPERLIQUID_PRIVATE_KEY');
    }

    const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(normalizedPrivateKey);
    this.walletAddress = wallet.address;

    this.config = new ExchangeConfig(
      ExchangeType.HYPERLIQUID,
      'https://api.hyperliquid.xyz',
      undefined,
      undefined,
      normalizedPrivateKey,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      isTestnet,
    );

    this.transport = new HttpTransport({ isTestnet });
    this.exchangeClient = new ExchangeClient({ wallet: normalizedPrivateKey as `0x${string}`, transport: this.transport });
    this.infoClient = new InfoClient({ transport: this.transport });

    // Don't initialize symbol converter in constructor - initialize lazily when needed
    // This prevents rate limiting during startup

    this.logger.log(`Hyperliquid adapter initialized for wallet: ${this.walletAddress}`);
  }

  /**
   * Ensure SymbolConverter is initialized with retry logic for rate limiting
   */
  private async ensureSymbolConverter(): Promise<SymbolConverter> {
    if (this.symbolConverter) {
      return this.symbolConverter;
    }

    // Retry logic with exponential backoff for rate limiting
    const maxRetries = 5;
    const baseDelay = 1000; // 1 second base delay
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(`Initializing SymbolConverter (attempt ${attempt + 1}/${maxRetries})...`);
        this.symbolConverter = await SymbolConverter.create({ transport: this.transport });
        this.logger.debug('SymbolConverter initialized successfully');
        return this.symbolConverter;
      } catch (error: any) {
        // Check if it's a rate limit error (429)
        const isRateLimit = error?.response?.status === 429 || 
                           error?.message?.includes('429') ||
                           error?.message?.includes('Too Many Requests');
        
        if (isRateLimit && attempt < maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s
          const delay = baseDelay * Math.pow(2, attempt);
          this.logger.warn(
            `Rate limit hit (429) when initializing SymbolConverter. ` +
            `Retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // If it's not a rate limit error, or we've exhausted retries, throw
        this.logger.error(`Failed to initialize SymbolConverter: ${error.message}`);
        throw new ExchangeError(
          `Failed to initialize SymbolConverter: ${error.message}`,
          ExchangeType.HYPERLIQUID,
          undefined,
          error,
        );
      }
    }
    
    // Should never reach here, but TypeScript needs it
    throw new Error('Failed to initialize SymbolConverter after all retries');
  }

  /**
   * Convert symbol to Hyperliquid coin format (e.g., "ETH" -> "ETH-PERP")
   */
  private formatCoin(symbol: string): string {
    if (symbol.includes('-PERP')) {
      return symbol;
    }
    // Remove USDT/USDC suffix if present
    const baseSymbol = symbol.replace('USDT', '').replace('USDC', '');
    return `${baseSymbol}-PERP`;
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): string {
    return ExchangeType.HYPERLIQUID;
  }

  async placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse> {
    try {
      await this.ensureSymbolConverter();
      
      // Get asset ID and decimals
      const baseCoin = request.symbol.replace('USDT', '').replace('USDC', '').replace('-PERP', '');
      const assetId = this.symbolConverter!.getAssetId(baseCoin);
      
      if (assetId === undefined) {
        throw new Error(`Could not find asset ID for "${baseCoin}"`);
      }

      const szDecimals = this.symbolConverter!.getSzDecimals(baseCoin);
      if (szDecimals === undefined) {
        throw new Error(`Could not find szDecimals for "${baseCoin}"`);
      }

      const isBuy = request.side === OrderSide.LONG;
      const isPerp = !request.symbol.includes('-SPOT');

      // Format size using utilities (matching simple-hyperliquid-order.ts)
      const formattedSize = formatSize(request.size.toString(), szDecimals);
      
      // For market orders, Hyperliquid requires a limit price (uses IOC for market execution)
      // Fetch current mark price if no price provided
      let orderPrice: number;
      if (request.price) {
        orderPrice = request.price;
      } else if (request.type === OrderType.MARKET) {
        // Fetch current mark price for market orders
        orderPrice = await this.getMarkPrice(request.symbol);
        this.logger.debug(`Market order: using current mark price ${orderPrice} for ${request.symbol}`);
      } else {
        throw new Error('Price is required for LIMIT orders');
      }

      // Format price using utilities
      const formattedPrice = formatPrice(orderPrice.toString(), szDecimals, isPerp);
      
      // Validate price is not zero
      if (parseFloat(formattedPrice) <= 0) {
        throw new Error(`Invalid order price: ${formattedPrice} (original: ${orderPrice})`);
      }

      // Determine time in force
      // For MARKET orders: Use IOC (immediate execution, cancel if not filled)
      // For LIMIT orders: Use GTC (can sit on order book) - matching sdk-perp-order.ts
      let tif: 'Gtc' | 'Ioc' = 'Gtc';
      if (request.type === OrderType.MARKET) {
        tif = 'Ioc'; // Market orders use IOC (Immediate or Cancel) for immediate execution
      } else {
        // LIMIT orders use GTC by default (can sit on order book)
        // This matches the working script which uses 'Gtc' for limit orders
        if (request.timeInForce) {
          const tifMap: Record<TimeInForce, 'Gtc' | 'Ioc'> = {
            [TimeInForce.GTC]: 'Gtc',
            [TimeInForce.IOC]: 'Ioc',
            [TimeInForce.FOK]: 'Ioc', // FOK maps to IOC for Hyperliquid
          };
          tif = tifMap[request.timeInForce] || 'Gtc';
        } else {
          tif = 'Gtc'; // Default to GTC for limit orders (can sit on book)
        }
      }

      // Use the order() method matching simple-hyperliquid-order.ts format
      const result = await this.exchangeClient.order({
        orders: [{
          a: assetId,
          b: isBuy,
          p: formattedPrice,
          r: request.reduceOnly || false,
          s: formattedSize,
          t: { limit: { tif } },
        }],
        grouping: 'na',
      });

      // Parse response matching the script format
      if (result.status === 'ok' && result.response?.type === 'order' && result.response?.data?.statuses) {
        const status = result.response.data.statuses[0];
        
        if ('error' in status && status.error) {
          const errorMsg = typeof status.error === 'string' ? status.error : JSON.stringify(status.error);
          throw new Error(errorMsg);
        }

        let orderId: string;
        let orderStatus: OrderStatus;
        let filledSize: number | undefined;
        let avgFillPrice: number | undefined;

        if ('filled' in status && status.filled) {
          orderId = status.filled.oid?.toString() || 'unknown';
          orderStatus = OrderStatus.FILLED;
          filledSize = parseFloat(status.filled.totalSz || '0');
          avgFillPrice = status.filled.avgPx ? parseFloat(status.filled.avgPx) : undefined;
        } else if ('resting' in status && status.resting) {
          orderId = status.resting.oid?.toString() || 'unknown';
          orderStatus = OrderStatus.SUBMITTED;
        } else {
          throw new Error('Unknown order status');
        }

        return new PerpOrderResponse(
          orderId,
          orderStatus,
          request.symbol,
          request.side,
          request.clientOrderId,
          filledSize,
          avgFillPrice,
          undefined,
          new Date(),
        );
      }

      throw new Error('Unknown response format from Hyperliquid');
    } catch (error: any) {
      this.logger.error(`Failed to place order: ${error.message}`);
      throw new ExchangeError(
        `Failed to place order: ${error.message}`,
        ExchangeType.HYPERLIQUID,
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
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getPositions(): Promise<PerpPosition[]> {
    try {
      const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
      const positions: PerpPosition[] = [];

      if (clearinghouseState.assetPositions) {
        for (const assetPos of clearinghouseState.assetPositions) {
          const size = parseFloat(assetPos.position.szi || '0');
          if (size !== 0) {
            const side = size > 0 ? OrderSide.LONG : OrderSide.SHORT;
            const entryPrice = parseFloat(assetPos.position.entryPx || '0');
            const unrealizedPnl = parseFloat(assetPos.position.unrealizedPnl || '0');
            
            // Calculate mark price from position value or use entry price
            const positionValue = parseFloat(assetPos.position.positionValue || '0');
            const markPrice = Math.abs(size) > 0 ? positionValue / Math.abs(size) : entryPrice;
            
            const marginUsed = parseFloat(assetPos.position.marginUsed || '0');
            const liquidationPrice = parseFloat(assetPos.position.liquidationPx || '0') || undefined;

            // Get coin name from asset index (coin can be number or string)
            const coinIndex = typeof assetPos.position.coin === 'number' 
              ? assetPos.position.coin 
              : parseInt(String(assetPos.position.coin || '0'));
            const coin = await this.getCoinFromAssetIndex(coinIndex);

            positions.push(
              new PerpPosition(
                ExchangeType.HYPERLIQUID,
                coin,
                side,
                Math.abs(size),
                entryPrice,
                markPrice,
                unrealizedPnl,
                undefined,
                liquidationPrice,
                marginUsed,
                undefined,
                new Date(),
              ),
            );
          }
        }
      }

      return positions;
    } catch (error: any) {
      this.logger.error(`Failed to get positions: ${error.message}`);
      throw new ExchangeError(
        `Failed to get positions: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  private async getCoinFromAssetIndex(assetIndex: number): Promise<string> {
    try {
      await this.ensureSymbolConverter();
      const meta = await this.infoClient.meta();
      
      // Find asset by index in universe array
      if (meta.universe && Array.isArray(meta.universe)) {
        // Asset index corresponds to position in universe array
        if (assetIndex >= 0 && assetIndex < meta.universe.length) {
          const asset = meta.universe[assetIndex];
          return asset?.name || `ASSET-${assetIndex}`;
        }
      }
      
      // Fallback: try to find by matching index
      const asset = meta.universe?.find((a: any, index: number) => index === assetIndex);
      return asset?.name || `ASSET-${assetIndex}`;
    } catch {
      return `ASSET-${assetIndex}`;
    }
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      // Hyperliquid SDK doesn't have cancelOrder method on ExchangeClient
      // We need to use the order method with cancel action
      // For now, log a warning and return false
      this.logger.warn('Cancel order not yet implemented for Hyperliquid - SDK limitation');
      // TODO: Implement cancel using order method with cancel action if SDK supports it
      return false;
    } catch (error: any) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel order: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    try {
      // Hyperliquid SDK doesn't have cancelAllOrders method on ExchangeClient
      // We need to use the order method with cancel action
      // For now, log a warning and return 0
      this.logger.warn('Cancel all orders not yet implemented for Hyperliquid - SDK limitation');
      // TODO: Implement cancel all using order method with cancel action if SDK supports it
      return 0;
    } catch (error: any) {
      this.logger.error(`Failed to cancel all orders: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel all orders: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    try {
      const orderIdBigInt = BigInt(orderId);
      const openOrders = await this.infoClient.openOrders({ user: this.walletAddress });
      const order = openOrders.find((o: any) => {
        const oid = typeof o.oid === 'bigint' ? o.oid : BigInt(o.oid || '0');
        return oid === orderIdBigInt;
      });

      if (!order) {
        // Order might be filled or cancelled - check user fills
        const userFills = await this.infoClient.userFills({ user: this.walletAddress });
        const fill = userFills.find((f: any) => {
          const oid = typeof f.oid === 'bigint' ? f.oid : BigInt(f.oid || '0');
          return oid === orderIdBigInt;
        });
        
        if (fill) {
          // Get coin name from asset ID if needed
          let coinName = symbol || fill.coin || 'UNKNOWN';
          if (typeof fill.coin === 'number') {
            coinName = await this.getCoinFromAssetIndex(fill.coin);
          }

          // Hyperliquid fills use 'side' property: "B" = buy/long, "A" = sell/short
          const side = (fill as any).side === 'B' ? OrderSide.LONG : OrderSide.SHORT;

          return new PerpOrderResponse(
            orderId,
            OrderStatus.FILLED,
            coinName,
            side,
            undefined,
            parseFloat(fill.sz || '0'),
            parseFloat(fill.px || '0'),
            undefined,
            new Date(fill.time || Date.now()),
          );
        }

        throw new Error(`Order ${orderId} not found`);
      }

      // Get coin name from asset ID if needed
      let coinName = symbol || order.coin || 'UNKNOWN';
      if (typeof order.coin === 'number') {
        coinName = await this.getCoinFromAssetIndex(order.coin);
      }

      // Hyperliquid orders use 'b' property (boolean) for buy/sell
      const isBuy = (order as any).b === true;
      const side = isBuy ? OrderSide.LONG : OrderSide.SHORT;

      return new PerpOrderResponse(
        orderId,
        OrderStatus.SUBMITTED,
        coinName,
        side,
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
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
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

    // Try WebSocket first (no rate limits! weight 0)
    try {
      const wsPrice = await this.dataProvider.getMarkPrice(symbol);
      if (wsPrice > 0) {
        this.priceCache.set(symbol, { price: wsPrice, timestamp: Date.now() });
        return wsPrice;
      }
    } catch (error: any) {
      // WebSocket not available or data not ready, fall back to REST
      this.logger.debug(`WebSocket mark price not available for ${symbol}, using REST API`);
    }

    // Fallback to REST API (allMids has weight 2, but we cache results)
    // Retry logic: up to 3 attempts with exponential backoff
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s delays
          await new Promise(resolve => setTimeout(resolve, delay));
          this.logger.debug(`Retrying mark price fetch for ${symbol} (attempt ${attempt + 1}/3)`);
        }

        // Use allMids() to get mark prices (matching simple-hyperliquid-order.ts)
        // Weight: 2 per request (1200 weight/minute limit = 600 requests/minute max)
        const allMidsData = await this.infoClient.allMids();
        const coin = this.formatCoin(symbol);
        const baseCoin = coin.replace('-PERP', '');
        
        const markPrice = parseFloat((allMidsData as any)[baseCoin] || (allMidsData as any)[coin] || '0');
        if (markPrice > 0) {
          // Cache the result
          this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
          return markPrice;
        }

        throw new Error(`Mark price not found for ${symbol} (coin: ${coin}, baseCoin: ${baseCoin})`);
      } catch (error: any) {
        lastError = error;
        if (attempt === 2) {
          // Last attempt failed
          this.logger.error(
            `Failed to get mark price for ${symbol} after 3 attempts: ${error.message}. ` +
            `Tried coin formats: ${this.formatCoin(symbol)}, ${this.formatCoin(symbol).replace('-PERP', '')}`
          );
        }
      }
    }

    // All attempts failed
    throw new ExchangeError(
      `Failed to get mark price for ${symbol} after 3 retries: ${lastError?.message || 'unknown error'}`,
      ExchangeType.HYPERLIQUID,
      undefined,
      lastError || undefined,
    );
  }

  async getBalance(): Promise<number> {
    // Check cache first (clearinghouseState has weight 2, 1200 weight/minute limit)
    if (this.balanceCache && (Date.now() - this.balanceCache.timestamp) < this.BALANCE_CACHE_TTL) {
      return this.balanceCache.balance;
    }

    try {
      // clearinghouseState has weight 2 (1200 weight/minute = 600 requests/minute max)
      const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
      const marginSummary = clearinghouseState.marginSummary;
      
      const accountValue = parseFloat(marginSummary.accountValue || '0');
      const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
      const freeCollateral = accountValue - totalMarginUsed;
      
      // Cache the result
      this.balanceCache = { balance: freeCollateral, timestamp: Date.now() };
      
      // Log detailed balance info for debugging
      this.logger.debug(
        `HyperLiquid balance for ${this.walletAddress}: ` +
        `Account Value: $${accountValue.toFixed(2)}, ` +
        `Margin Used: $${totalMarginUsed.toFixed(2)}, ` +
        `Free Collateral: $${freeCollateral.toFixed(2)}`
      );
      
      return freeCollateral; // Free collateral
    } catch (error: any) {
      // If we have cached balance, return it even if expired (graceful degradation)
      if (this.balanceCache) {
        this.logger.warn(
          `Failed to get fresh balance, using cached value: ${error.message}. ` +
          `Cached balance: $${this.balanceCache.balance.toFixed(2)} (age: ${Math.round((Date.now() - this.balanceCache.timestamp) / 1000)}s)`
        );
        return this.balanceCache.balance;
      }

      this.logger.error(`Failed to get balance: ${error.message}`);
      throw new ExchangeError(
        `Failed to get balance: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getEquity(): Promise<number> {
    // Use cached balance if available (equity = accountValue, which we get from clearinghouseState)
    // If balance cache exists, we can derive equity from it (equity = balance + marginUsed)
    // But for simplicity, we'll just call clearinghouseState with caching
    try {
      // Reuse balance cache if recent (both use clearinghouseState)
      if (this.balanceCache && (Date.now() - this.balanceCache.timestamp) < this.BALANCE_CACHE_TTL) {
        // We need accountValue, not freeCollateral, so we still need to fetch
        // But we can reduce calls by using the same cached clearinghouseState
        // For now, just fetch (it's cached in getBalance, but we need accountValue specifically)
        const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
        const marginSummary = clearinghouseState.marginSummary;
        return parseFloat(marginSummary.accountValue || '0');
      }

      // If balance cache is expired, getBalance will refresh it, but we still need accountValue
      // So we fetch here (weight 2, but cached for 30s)
      const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
      const marginSummary = clearinghouseState.marginSummary;
      const accountValue = parseFloat(marginSummary.accountValue || '0');
      
      // Update balance cache while we're at it
      const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
      const freeCollateral = accountValue - totalMarginUsed;
      this.balanceCache = { balance: freeCollateral, timestamp: Date.now() };
      
      return accountValue;
    } catch (error: any) {
      this.logger.error(`Failed to get equity: ${error.message}`);
      throw new ExchangeError(
        `Failed to get equity: ${error.message}`,
        ExchangeType.HYPERLIQUID,
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
      await this.infoClient.meta();
    } catch (error: any) {
      throw new ExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }
}

