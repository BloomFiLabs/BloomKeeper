import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import { IPerpExchangeAdapter } from '../../domain/ports/IPerpExchangeAdapter';
import { OrderSide } from '../../domain/value-objects/PerpOrder';

/**
 * MarketStateService - Centralized source of truth for market data and positions
 * 
 * This service reduces API load by caching positions and prices across all exchanges,
 * preventing multiple services from redundantly fetching the same data.
 */
@Injectable()
export class MarketStateService {
  private readonly logger = new Logger(MarketStateService.name);
  private readonly adapters: Map<ExchangeType, IPerpExchangeAdapter> = new Map();
  
  // State cache
  private positions: Map<ExchangeType, PerpPosition[]> = new Map();
  private markPrices: Map<string, Map<ExchangeType, number>> = new Map(); // symbol -> exchange -> price
  private lastUpdateTime: Date | null = null;
  private isRefreshing = false;

  /**
   * Initialize with exchange adapters
   */
  initialize(adapters: Map<ExchangeType, IPerpExchangeAdapter>): void {
    for (const [type, adapter] of adapters.entries()) {
      this.adapters.set(type, adapter);
    }
    this.logger.log(`MarketStateService initialized with ${this.adapters.size} adapters`);
  }

  /**
   * Refresh all cached state from exchanges
   */
  async refreshAll(): Promise<void> {
    if (this.isRefreshing) {
      this.logger.debug('Refresh already in progress, skipping');
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      const exchangeTypes = Array.from(this.adapters.keys());
      
      // Fetch positions from all exchanges in parallel
      const positionResults = await Promise.allSettled(
        exchangeTypes.map(async (type) => {
          const adapter = this.adapters.get(type)!;
          return { type, positions: await adapter.getPositions() };
        })
      );

      // Process results
      for (const result of positionResults) {
        if (result.status === 'fulfilled') {
          this.positions.set(result.value.type, result.value.positions);
          
          // Also update mark prices from position data (most fresh source)
          for (const pos of result.value.positions) {
            this.updateMarkPrice(pos.symbol, result.value.type, pos.markPrice);
          }
        } else {
          this.logger.warn(`Failed to refresh positions for an exchange: ${result.reason}`);
        }
      }

      this.lastUpdateTime = new Date();
      const duration = Date.now() - startTime;
      this.logger.debug(`Market state refreshed in ${duration}ms (${this.getTotalPositionCount()} positions cached)`);
    } catch (error: any) {
      this.logger.error(`Error refreshing market state: ${error.message}`);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Update cached mark price for a symbol/exchange
   */
  updateMarkPrice(symbol: string, exchange: ExchangeType, price: number): void {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    if (!this.markPrices.has(normalizedSymbol)) {
      this.markPrices.set(normalizedSymbol, new Map());
    }
    this.markPrices.get(normalizedSymbol)!.set(exchange, price);
  }

  /**
   * Get all positions for an exchange
   */
  getPositions(exchange: ExchangeType): PerpPosition[] {
    return this.positions.get(exchange) || [];
  }

  /**
   * Get all positions across all exchanges
   */
  getAllPositions(): PerpPosition[] {
    const all: PerpPosition[] = [];
    for (const posArray of this.positions.values()) {
      all.push(...posArray);
    }
    return all;
  }

  /**
   * Get total count of cached positions
   */
  getTotalPositionCount(): number {
    let count = 0;
    for (const posArray of this.positions.values()) {
      count += posArray.length;
    }
    return count;
  }

  /**
   * Get cached mark price for a symbol/exchange
   */
  getMarkPrice(symbol: string, exchange: ExchangeType): number | undefined {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    return this.markPrices.get(normalizedSymbol)?.get(exchange);
  }

  /**
   * Get a specific position from cache
   */
  getPosition(symbol: string, exchange: ExchangeType, side: OrderSide): PerpPosition | undefined {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const posArray = this.positions.get(exchange) || [];
    
    return posArray.find(p => 
      this.normalizeSymbol(p.symbol) === normalizedSymbol && 
      p.side === side
    );
  }

  /**
   * Clear cache for an exchange (useful after major actions)
   */
  clearCache(exchange: ExchangeType): void {
    this.positions.delete(exchange);
    this.logger.debug(`Cleared cached positions for ${exchange}`);
  }

  /**
   * Update or add a position in the cache
   * Used for reconciliation when we detect discrepancies
   */
  updatePosition(position: PerpPosition): void {
    const exchange = position.exchangeType;
    const normalizedSymbol = this.normalizeSymbol(position.symbol);
    
    if (!this.positions.has(exchange)) {
      this.positions.set(exchange, []);
    }
    
    const posArray = this.positions.get(exchange)!;
    const existingIndex = posArray.findIndex(p => 
      this.normalizeSymbol(p.symbol) === normalizedSymbol && 
      p.side === position.side
    );
    
    if (existingIndex >= 0) {
      // Update existing position
      posArray[existingIndex] = position;
      this.logger.debug(`Updated cached position: ${exchange} ${position.symbol} ${position.side}`);
    } else {
      // Add new position
      posArray.push(position);
      this.logger.debug(`Added cached position: ${exchange} ${position.symbol} ${position.side}`);
    }
    
    // Also update mark price
    if (position.markPrice) {
      this.updateMarkPrice(position.symbol, exchange, position.markPrice);
    }
  }

  /**
   * Remove a position from the cache
   * Used for reconciliation when we detect phantom positions
   */
  removePosition(exchange: ExchangeType, symbol: string): void {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    if (!this.positions.has(exchange)) {
      return;
    }
    
    const posArray = this.positions.get(exchange)!;
    const filteredArray = posArray.filter(p => 
      this.normalizeSymbol(p.symbol) !== normalizedSymbol
    );
    
    if (filteredArray.length !== posArray.length) {
      this.positions.set(exchange, filteredArray);
      this.logger.debug(`Removed cached position: ${exchange} ${symbol}`);
    }
  }

  /**
   * Get last update time
   */
  getLastUpdateTime(): Date | null {
    return this.lastUpdateTime;
  }

  /**
   * Normalize symbol for consistent cache keys
   */
  private normalizeSymbol(symbol: string): string {
    return symbol
      .toUpperCase()
      .replace('USDT', '')
      .replace('USDC', '')
      .replace('-PERP', '')
      .replace('PERP', '');
  }
}

