import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';

/**
 * Execution metrics for a single order
 */
export interface OrderExecutionMetrics {
  symbol: string;
  exchange: ExchangeType;
  side: 'LONG' | 'SHORT';
  requestedSize: number;
  filledSize: number;
  requestedPrice: number;
  executedPrice: number;
  slippageBps: number; // Basis points
  fillTimeMs: number;
  attempts: number;
  success: boolean;
  timestamp: Date;
}

/**
 * Aggregated execution statistics
 */
export interface ExecutionStats {
  totalOrders: number;
  successfulOrders: number;
  failedOrders: number;
  fillRate: number; // 0-100%
  avgSlippageBps: number;
  avgFillTimeMs: number;
  p50FillTimeMs: number;
  p95FillTimeMs: number;
  p99FillTimeMs: number;
  avgAttempts: number;
  partialFillRate: number; // % of orders with partial fills
  byExchange: Map<ExchangeType, {
    orders: number;
    fillRate: number;
    avgSlippageBps: number;
    avgFillTimeMs: number;
  }>;
}

/**
 * Order book depth snapshot
 */
export interface OrderBookDepth {
  symbol: string;
  exchange: ExchangeType;
  timestamp: Date;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  midPrice: number;
  spread: number;
  spreadBps: number;
  depth5Pct: { bidSize: number; askSize: number }; // Liquidity within 5% of mid
  depth1Pct: { bidSize: number; askSize: number }; // Liquidity within 1% of mid
}

/**
 * Retry configuration with exponential backoff
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableErrors: [
    'TIMEOUT',
    'RATE_LIMIT',
    'NETWORK_ERROR',
    'TEMPORARY_FAILURE',
    'INSUFFICIENT_LIQUIDITY',
    'PRICE_MOVED',
  ],
};

/**
 * ExecutionAnalytics - Tracks and analyzes order execution performance
 */
@Injectable()
export class ExecutionAnalytics {
  private readonly logger = new Logger(ExecutionAnalytics.name);
  
  // Rolling window of execution metrics (last 24 hours)
  private readonly metricsWindow: OrderExecutionMetrics[] = [];
  private readonly WINDOW_SIZE_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly MAX_METRICS = 10000; // Max metrics to keep in memory
  
  // Order book depth cache
  private readonly depthCache: Map<string, OrderBookDepth> = new Map();
  private readonly DEPTH_CACHE_TTL_MS = 5000; // 5 seconds
  
  /**
   * Record execution metrics for an order
   */
  recordExecution(metrics: OrderExecutionMetrics): void {
    this.metricsWindow.push(metrics);
    
    // Cleanup old metrics
    this.cleanupOldMetrics();
    
    // Log significant slippage
    if (metrics.slippageBps > 50) {
      this.logger.warn(
        `⚠️ High slippage on ${metrics.symbol} (${metrics.exchange}): ` +
        `${metrics.slippageBps.toFixed(1)} bps (requested: $${metrics.requestedPrice.toFixed(2)}, ` +
        `executed: $${metrics.executedPrice.toFixed(2)})`
      );
    }
    
    // Log slow fills
    if (metrics.fillTimeMs > 30000) {
      this.logger.warn(
        `⚠️ Slow fill on ${metrics.symbol} (${metrics.exchange}): ` +
        `${(metrics.fillTimeMs / 1000).toFixed(1)}s (${metrics.attempts} attempts)`
      );
    }
  }
  
  /**
   * Calculate slippage in basis points
   */
  calculateSlippageBps(requestedPrice: number, executedPrice: number, side: 'LONG' | 'SHORT'): number {
    if (requestedPrice === 0) return 0;
    
    // For LONG: slippage is positive if we paid more
    // For SHORT: slippage is positive if we received less
    const priceDiff = side === 'LONG' 
      ? executedPrice - requestedPrice 
      : requestedPrice - executedPrice;
    
    return (priceDiff / requestedPrice) * 10000; // Convert to basis points
  }
  
  /**
   * Get aggregated execution statistics
   */
  getStats(periodMs?: number): ExecutionStats {
    const cutoff = periodMs 
      ? Date.now() - periodMs 
      : Date.now() - this.WINDOW_SIZE_MS;
    
    const relevantMetrics = this.metricsWindow.filter(
      m => m.timestamp.getTime() > cutoff
    );
    
    if (relevantMetrics.length === 0) {
      return this.emptyStats();
    }
    
    const successful = relevantMetrics.filter(m => m.success);
    const fillTimes = successful.map(m => m.fillTimeMs).sort((a, b) => a - b);
    const partialFills = relevantMetrics.filter(
      m => m.filledSize > 0 && m.filledSize < m.requestedSize
    );
    
    // Calculate by-exchange stats
    const byExchange = new Map<ExchangeType, {
      orders: number;
      fillRate: number;
      avgSlippageBps: number;
      avgFillTimeMs: number;
    }>();
    
    const exchangeGroups = this.groupBy(relevantMetrics, m => m.exchange);
    for (const [exchange, metrics] of exchangeGroups) {
      const exchangeSuccessful = metrics.filter(m => m.success);
      byExchange.set(exchange, {
        orders: metrics.length,
        fillRate: metrics.length > 0 ? (exchangeSuccessful.length / metrics.length) * 100 : 0,
        avgSlippageBps: this.average(exchangeSuccessful.map(m => m.slippageBps)),
        avgFillTimeMs: this.average(exchangeSuccessful.map(m => m.fillTimeMs)),
      });
    }
    
    return {
      totalOrders: relevantMetrics.length,
      successfulOrders: successful.length,
      failedOrders: relevantMetrics.length - successful.length,
      fillRate: (successful.length / relevantMetrics.length) * 100,
      avgSlippageBps: this.average(successful.map(m => m.slippageBps)),
      avgFillTimeMs: this.average(fillTimes),
      p50FillTimeMs: this.percentile(fillTimes, 50),
      p95FillTimeMs: this.percentile(fillTimes, 95),
      p99FillTimeMs: this.percentile(fillTimes, 99),
      avgAttempts: this.average(relevantMetrics.map(m => m.attempts)),
      partialFillRate: (partialFills.length / relevantMetrics.length) * 100,
      byExchange,
    };
  }
  
  /**
   * Get execution stats for diagnostics
   */
  getDiagnosticsStats(): {
    last1h: ExecutionStats;
    last24h: ExecutionStats;
  } {
    return {
      last1h: this.getStats(60 * 60 * 1000),
      last24h: this.getStats(24 * 60 * 60 * 1000),
    };
  }
  
  /**
   * Cache order book depth for slippage estimation
   */
  cacheOrderBookDepth(depth: OrderBookDepth): void {
    const key = `${depth.exchange}:${depth.symbol}`;
    this.depthCache.set(key, depth);
  }
  
  /**
   * Get cached order book depth
   */
  getOrderBookDepth(exchange: ExchangeType, symbol: string): OrderBookDepth | null {
    const key = `${exchange}:${symbol}`;
    const cached = this.depthCache.get(key);
    
    if (!cached) return null;
    
    // Check if cache is stale
    if (Date.now() - cached.timestamp.getTime() > this.DEPTH_CACHE_TTL_MS) {
      this.depthCache.delete(key);
      return null;
    }
    
    return cached;
  }
  
  /**
   * Estimate slippage based on order book depth
   */
  estimateSlippage(
    exchange: ExchangeType,
    symbol: string,
    side: 'BUY' | 'SELL',
    sizeUsd: number,
  ): { estimatedSlippageBps: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
    const depth = this.getOrderBookDepth(exchange, symbol);
    
    if (!depth) {
      // No depth data - use historical average or default
      const stats = this.getStats(60 * 60 * 1000); // Last hour
      const exchangeStats = stats.byExchange.get(exchange);
      
      if (exchangeStats && exchangeStats.orders > 5) {
        return {
          estimatedSlippageBps: exchangeStats.avgSlippageBps * 1.5, // Conservative estimate
          confidence: 'MEDIUM',
        };
      }
      
      // Default conservative estimate
      return { estimatedSlippageBps: 10, confidence: 'LOW' };
    }
    
    // Calculate slippage from order book
    const levels = side === 'BUY' ? depth.asks : depth.bids;
    let remainingSize = sizeUsd;
    let totalCost = 0;
    
    for (const level of levels) {
      const levelValue = level.price * level.size;
      const fillAmount = Math.min(remainingSize, levelValue);
      totalCost += fillAmount;
      remainingSize -= fillAmount;
      
      if (remainingSize <= 0) break;
    }
    
    if (remainingSize > 0) {
      // Not enough liquidity - high slippage expected
      return { estimatedSlippageBps: 100, confidence: 'LOW' };
    }
    
    const avgPrice = totalCost / sizeUsd;
    const slippageBps = Math.abs((avgPrice - depth.midPrice) / depth.midPrice) * 10000;
    
    return {
      estimatedSlippageBps: slippageBps,
      confidence: 'HIGH',
    };
  }
  
  /**
   * Calculate retry delay with exponential backoff
   */
  calculateRetryDelay(attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): number {
    const delay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
    const jitter = delay * 0.2 * (Math.random() * 2 - 1); // ±20% jitter
    return Math.min(delay + jitter, config.maxDelayMs);
  }
  
  /**
   * Check if an error is retryable
   */
  isRetryableError(errorType: string, config: RetryConfig = DEFAULT_RETRY_CONFIG): boolean {
    return config.retryableErrors.some(
      retryable => errorType.toUpperCase().includes(retryable)
    );
  }
  
  /**
   * Calculate adaptive timeout based on recent fill times
   */
  calculateAdaptiveTimeout(
    exchange: ExchangeType,
    baseTimeoutMs: number = 30000,
  ): number {
    const stats = this.getStats(60 * 60 * 1000); // Last hour
    const exchangeStats = stats.byExchange.get(exchange);
    
    if (!exchangeStats || exchangeStats.orders < 5) {
      return baseTimeoutMs; // Not enough data, use default
    }
    
    // Use p95 fill time + 50% buffer, but at least baseTimeout
    const adaptiveTimeout = exchangeStats.avgFillTimeMs * 2;
    return Math.max(baseTimeoutMs, Math.min(adaptiveTimeout, 120000)); // Cap at 2 minutes
  }
  
  /**
   * Get recommended position size based on liquidity
   */
  getRecommendedPositionSize(
    exchange: ExchangeType,
    symbol: string,
    maxSlippageBps: number = 20,
  ): number | null {
    const depth = this.getOrderBookDepth(exchange, symbol);
    
    if (!depth) return null;
    
    // Find the size that would cause maxSlippageBps slippage
    // Use the smaller of bid/ask depth within 1%
    const availableLiquidity = Math.min(depth.depth1Pct.bidSize, depth.depth1Pct.askSize);
    
    // Conservative: use 50% of available liquidity
    return availableLiquidity * 0.5;
  }
  
  /**
   * Cleanup old metrics to prevent memory growth
   */
  private cleanupOldMetrics(): void {
    const cutoff = Date.now() - this.WINDOW_SIZE_MS;
    
    // Remove old metrics
    while (this.metricsWindow.length > 0 && 
           this.metricsWindow[0].timestamp.getTime() < cutoff) {
      this.metricsWindow.shift();
    }
    
    // Also cap total size
    while (this.metricsWindow.length > this.MAX_METRICS) {
      this.metricsWindow.shift();
    }
  }
  
  private emptyStats(): ExecutionStats {
    return {
      totalOrders: 0,
      successfulOrders: 0,
      failedOrders: 0,
      fillRate: 100,
      avgSlippageBps: 0,
      avgFillTimeMs: 0,
      p50FillTimeMs: 0,
      p95FillTimeMs: 0,
      p99FillTimeMs: 0,
      avgAttempts: 1,
      partialFillRate: 0,
      byExchange: new Map(),
    };
  }
  
  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, index)];
  }
  
  private groupBy<T, K>(array: T[], keyFn: (item: T) => K): Map<K, T[]> {
    const map = new Map<K, T[]>();
    for (const item of array) {
      const key = keyFn(item);
      const group = map.get(key) || [];
      group.push(item);
      map.set(key, group);
    }
    return map;
  }
}

