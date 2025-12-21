import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import WebSocket from 'ws';

interface MarketStatsMessage {
  channel: string;
  market_stats: {
    market_id: number;
    index_price: string;
    mark_price: string;
    open_interest: string;
    last_trade_price: string;
    current_funding_rate: string;
    funding_rate: string;
    funding_timestamp: number;
    daily_base_token_volume: number;
    daily_quote_token_volume: number;
    daily_price_low: number;
    daily_price_high: number;
    daily_price_change: number;
  };
  type: string;
}

interface OrderBookLevel {
  price: string;
  size: string;
}

interface OrderBookMessage {
  channel: string;
  type: string;
  data: {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  };
}

interface WsMessage {
  channel?: string;
  type?: string;
  market_stats?: MarketStatsMessage['market_stats'];
  data?: any;
  market_id?: number;
  error?: { code: number; message: string };
}

/**
 * LighterWebSocketProvider - WebSocket-based market data provider for Lighter Protocol
 *
 * Subscribes to market_stats channels for real-time open interest updates
 * This eliminates rate limit issues and provides accurate OI data
 *
 * Docs: https://apidocs.lighter.xyz/docs/websocket-reference#market-stats
 */
@Injectable()
export class LighterWebSocketProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LighterWebSocketProvider.name);
  private readonly WS_URL = 'wss://mainnet.zklighter.elliot.ai/stream';

  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds

  // Cache for market stats data (key: marketIndex, value: { openInterest: number, markPrice: number, volume24h: number })
  private marketStatsCache: Map<
    number,
    { openInterest: number; markPrice: number; volume24h: number }
  > = new Map();
  private subscribedMarkets: Set<number> = new Set();
  
  // Cache for orderbook data (key: marketIndex, value: { bids, asks })
  private orderbookCache: Map<number, { bids: OrderBookLevel[]; asks: OrderBookLevel[] }> = new Map();
  private subscribedOrderbooks: Set<number> = new Set();

  // Track if we've received initial data for each market
  private hasInitialData: Set<number> = new Set();

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  /**
   * Connect to Lighter WebSocket
   */
  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Removed WebSocket connection log - only execution logs shown
        this.ws = new WebSocket(this.WS_URL);

        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          // Removed WebSocket connection log - only execution logs shown

          // Resubscribe to all markets we were tracking
          // Use setTimeout to ensure subscriptions happen after connection is fully established
          // Also gives time for markets to be discovered if discovery happens concurrently
          setTimeout(() => {
            if (this.subscribedMarkets.size > 0) {
              this.logger.log(
                `Resubscribing to ${this.subscribedMarkets.size} Lighter markets after connection...`,
              );
              this.resubscribeAll();
            } else {
              this.logger.debug(
                'No markets to resubscribe yet (subscribedMarkets is empty - markets may be discovered shortly)',
              );
              // Check again after a longer delay in case markets are discovered late
              setTimeout(() => {
                if (this.subscribedMarkets.size > 0) {
                  this.logger.log(
                    `Markets discovered late - subscribing to ${this.subscribedMarkets.size} Lighter markets...`,
                  );
                  this.resubscribeAll();
                }
              }, 2000);
            }
          }, 500); // Increased delay to allow markets to be discovered
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const rawMessage = data.toString();
            const message: WsMessage = JSON.parse(rawMessage);
            this.handleMessage(message);
          } catch (error: any) {
            this.logger.error(
              `Failed to parse WebSocket message: ${error.message}`,
            );
          }
        });

        // Handle WebSocket ping frames - respond with pong to keep connection alive
        this.ws.on('ping', (data: Buffer) => {
          try {
            if (this.ws && this.isConnected) {
              this.ws.pong(data);
            }
          } catch (error: any) {
            this.logger.debug(`Failed to send pong: ${error.message}`);
          }
        });

        this.ws.on('error', (error: Error) => {
          this.logger.error(`WebSocket error: ${error.message}`);
          this.isConnected = false;
          reject(error);
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          // Removed WebSocket connection log - only execution logs shown

          // Attempt to reconnect (silently - only log on repeated failures)
          if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++;
            // Only log on 3rd+ attempt to reduce noise
            if (this.reconnectAttempts >= 3) {
              this.logger.warn(
                `WebSocket reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}...`,
              );
            }
            setTimeout(() => this.connect(), this.RECONNECT_DELAY);
          } else {
            this.logger.error(
              'Max reconnection attempts reached. WebSocket will not reconnect.',
            );
          }
        });
      } catch (error: any) {
        this.logger.error(
          `Failed to create WebSocket connection: ${error.message}`,
        );
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket
   */
  private async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      // Removed WebSocket disconnection log - only execution logs shown
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: WsMessage): void {
    // Handle ping/pong heartbeat - respond with pong to keep connection alive
    if (message.type === 'ping') {
      try {
        if (this.ws && this.isConnected) {
          this.ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error: any) {
        this.logger.debug(`Failed to send pong: ${error.message}`);
      }
      return;
    }

    // Handle connected message (just acknowledge, don't log)
    if (message.type === 'connected') {
      return;
    }

    // Handle market_stats updates - check for market_stats field first (more reliable)
    if (message.market_stats) {
      // ... existing logic for market_stats ...
      const marketStats = message.market_stats;
      const marketIndex = marketStats.market_id;

      if (marketIndex === undefined) {
        this.logger.warn(
          `Received market_stats message without market_id: ${JSON.stringify(message)}`,
        );
        return;
      }

      try {
        const openInterestRaw = marketStats.open_interest || '0';
        const markPriceRaw = marketStats.mark_price || '0';
        const volume24hRaw = marketStats.daily_quote_token_volume || 0;
        const openInterest = parseFloat(openInterestRaw);
        const markPrice = parseFloat(markPriceRaw);
        const volume24h =
          typeof volume24hRaw === 'string'
            ? parseFloat(volume24hRaw)
            : volume24hRaw;

        if (markPrice > 0) {
          this.marketStatsCache.set(marketIndex, {
            openInterest: openInterest,
            markPrice: markPrice,
            volume24h: isNaN(volume24h) ? 0 : volume24h,
          });

          if (!this.hasInitialData.has(marketIndex)) {
            this.hasInitialData.add(marketIndex);
          }
        }
      } catch (error: any) {
        this.logger.error(
          `Failed to parse market_stats for market ${marketIndex}: ${error.message}`,
        );
      }
      return;
    }

    // Handle orderbook updates (channel format: order_book/{MARKET_INDEX})
    if ((message.channel?.startsWith('order_book/') || message.channel?.startsWith('order_book:')) && message.data) {
      const marketIndex = parseInt(message.channel.split(/[:/]/)[1]);
      
      if (!isNaN(marketIndex)) {
        this.orderbookCache.set(marketIndex, {
          bids: message.data.bids || [],
          asks: message.data.asks || []
        });
      }
      return;
    }

    // Handle other message types (subscription confirmations, etc.)
    if (message.type && message.channel) {
      // Only log subscription confirmations, not routine updates
      if (message.type === 'subscribed') {
        this.logger.debug(
          `WebSocket subscribed: channel=${message.channel}`,
        );
      }
      // Silently ignore update/market_stats and update/order_book - they're already handled above
    } else if (message.error) {
      // Log errors but don't spam
      this.logger.warn(
        `WebSocket error: code=${message.error.code}, message=${message.error.message}`,
      );
    }
    // Don't log unhandled messages - too noisy
  }

  /**
   * Subscribe to orderbook for a specific market
   */
  subscribeToOrderbook(marketIndex: number): void {
    if (this.subscribedOrderbooks.has(marketIndex)) {
      return;
    }

    this.subscribedOrderbooks.add(marketIndex);

    if (this.isConnected && this.ws) {
      const subscribeMessage = {
        type: 'subscribe',
        channel: `order_book/${marketIndex}`,
      };
      this.ws.send(JSON.stringify(subscribeMessage));
    }
  }

  /**
   * Get best bid/ask for a market
   */
  getBestBidAsk(marketIndex: number): { bestBid: number; bestAsk: number } | null {
    const book = this.orderbookCache.get(marketIndex);
    if (!book || book.bids.length === 0 || book.asks.length === 0) {
      if (!this.subscribedOrderbooks.has(marketIndex)) {
        this.subscribeToOrderbook(marketIndex);
      }
      return null;
    }

    return {
      bestBid: parseFloat(book.bids[0].price),
      bestAsk: parseFloat(book.asks[0].price)
    };
  }

  /**
   * Subscribe to market_stats for a specific market
   */
  subscribeToMarket(
    marketIndex: number,
    forceResubscribe: boolean = false,
  ): void {
    // Always track the subscription, even if WebSocket isn't connected yet
    // This ensures we resubscribe when it reconnects
    const wasNew = !this.subscribedMarkets.has(marketIndex);
    if (wasNew) {
      this.subscribedMarkets.add(marketIndex);
    }

    if (!this.isConnected || !this.ws) {
      // WebSocket not connected - subscription will happen on reconnect via resubscribeAll
      return;
    }

    // If we already have data for this market and not forcing resubscribe, assume we're already subscribed
    if (!forceResubscribe && !wasNew && this.hasMarketData(marketIndex)) {
      return;
    }

    // Subscribe to the market
    try {
      const subscribeMessage = {
        type: 'subscribe',
        channel: `market_stats/${marketIndex}`,
      };

      if (!this.ws) {
        return;
      }

      this.ws.send(JSON.stringify(subscribeMessage));
      // Don't log individual subscriptions - too noisy
    } catch (error: any) {
      this.logger.error(
        `Failed to subscribe to market ${marketIndex}: ${error.message}`,
      );
    }
  }

  /**
   * Subscribe to multiple markets at once (with throttling to avoid rate limits)
   */
  subscribeToMarkets(marketIndexes: number[]): void {
    // Add all markets to tracking set first
    marketIndexes.forEach((index) => {
      if (!this.subscribedMarkets.has(index)) {
        this.subscribedMarkets.add(index);
      }
    });

    // If connected, subscribe to ALL markets (force subscribe to ensure we get data)
    // WebSocket.OPEN = 1
    if (this.isConnected && this.ws && this.ws.readyState === 1) {
      // Subscribe to all markets that don't have data yet
      const marketsToSubscribe = marketIndexes.filter(
        (index) => !this.hasMarketData(index),
      );
      if (marketsToSubscribe.length > 0) {
        // Throttle subscriptions to avoid "Too Many Websocket Messages!" error
        // Subscribe in batches of 5 with 200ms delay between batches
        const BATCH_SIZE = 5;
        const BATCH_DELAY_MS = 200;
        
        this.logger.log(`📡 Subscribing to ${marketsToSubscribe.length} Lighter markets...`);
        
        for (let i = 0; i < marketsToSubscribe.length; i += BATCH_SIZE) {
          const batch = marketsToSubscribe.slice(i, i + BATCH_SIZE);
          const delay = Math.floor(i / BATCH_SIZE) * BATCH_DELAY_MS;
          
          setTimeout(() => {
            batch.forEach((index) => {
              this.subscribeToMarket(index, true);
            });
          }, delay);
        }
      }
    }
    // Silently queue if not connected - will subscribe on reconnect
  }

  /**
   * Ensure all tracked markets are subscribed (useful when markets are discovered after connection)
   */
  ensureAllMarketsSubscribed(): void {
    if (!this.isConnected || !this.ws) {
      return;
    }

    if (this.subscribedMarkets.size === 0) {
      return;
    }

    // Subscribe to all markets that don't have data yet
    const marketsToSubscribe = Array.from(this.subscribedMarkets).filter(
      (marketIndex) => !this.hasMarketData(marketIndex),
    );

    if (marketsToSubscribe.length > 0) {
      this.logger.log(
        `Ensuring ${marketsToSubscribe.length} Lighter markets are subscribed...`,
      );
      // Throttle subscriptions
      const BATCH_SIZE = 5;
      const BATCH_DELAY_MS = 200;
      
      for (let i = 0; i < marketsToSubscribe.length; i += BATCH_SIZE) {
        const batch = marketsToSubscribe.slice(i, i + BATCH_SIZE);
        const delay = Math.floor(i / BATCH_SIZE) * BATCH_DELAY_MS;
        
        setTimeout(() => {
          batch.forEach((index) => {
            this.subscribeToMarket(index, true);
          });
        }, delay);
      }
    }
  }

  /**
   * Resubscribe to all previously subscribed markets (with throttling)
   */
  private resubscribeAll(): void {
    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 200;
    
    if (this.subscribedMarkets.size > 0) {
      this.logger.log(
        `Resubscribing to ${this.subscribedMarkets.size} Lighter market stats...`,
      );
      const markets = Array.from(this.subscribedMarkets);
      
      for (let i = 0; i < markets.length; i += BATCH_SIZE) {
        const batch = markets.slice(i, i + BATCH_SIZE);
        const delay = Math.floor(i / BATCH_SIZE) * BATCH_DELAY_MS;
        
        setTimeout(() => {
          batch.forEach((index) => this.subscribeToMarket(index, true));
        }, delay);
      }
    }
    
    if (this.subscribedOrderbooks.size > 0) {
      this.logger.log(
        `Resubscribing to ${this.subscribedOrderbooks.size} Lighter orderbooks...`,
      );
      const markets = Array.from(this.subscribedOrderbooks);
      
      // Clear and resubscribe with delay
      this.subscribedOrderbooks.clear();
      
      for (let i = 0; i < markets.length; i += BATCH_SIZE) {
        const batch = markets.slice(i, i + BATCH_SIZE);
        // Add offset to avoid overlap with market_stats subscriptions
        const delay = Math.floor(i / BATCH_SIZE) * BATCH_DELAY_MS + (this.subscribedMarkets.size / BATCH_SIZE) * BATCH_DELAY_MS + 500;
        
        setTimeout(() => {
          batch.forEach((index) => this.subscribeToOrderbook(index));
        }, delay);
      }
    }
  }

  /**
   * Get open interest for a market from WebSocket cache
   * Returns undefined if not available
   */
  getOpenInterest(marketIndex: number): number | undefined {
    const stats = this.marketStatsCache.get(marketIndex);
    return stats?.openInterest;
  }

  /**
   * Get mark price for a market from WebSocket cache
   * Returns undefined if not available
   */
  getMarkPrice(marketIndex: number): number | undefined {
    const stats = this.marketStatsCache.get(marketIndex);
    return stats?.markPrice;
  }

  /**
   * Get 24-hour trading volume in USD for a market from WebSocket cache
   * Returns undefined if not available
   */
  get24hVolume(marketIndex: number): number | undefined {
    const stats = this.marketStatsCache.get(marketIndex);
    return stats?.volume24h;
  }

  /**
   * Check if WebSocket is connected
   */
  isWsConnected(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === 1;
  }

  /**
   * Check if we have data for a market
   */
  hasMarketData(marketIndex: number): boolean {
    return this.marketStatsCache.has(marketIndex);
  }
}
