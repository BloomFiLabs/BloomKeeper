import { Injectable, Logger } from '@nestjs/common';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  TimeInForce,
} from '../../value-objects/PerpOrder';

/**
 * SliceResult - Result of executing a single slice
 */
export interface SliceResult {
  sliceNumber: number;
  longFilled: boolean;
  shortFilled: boolean;
  longFilledSize: number;
  shortFilledSize: number;
  longOrderId?: string;
  shortOrderId?: string;
  error?: string;
}

/**
 * SlicedExecutionResult - Result of full sliced execution
 */
export interface SlicedExecutionResult {
  success: boolean;
  totalSlices: number;
  completedSlices: number;
  totalLongFilled: number;
  totalShortFilled: number;
  sliceResults: SliceResult[];
  abortReason?: string;
}

/**
 * SlicedExecutionConfig - Configuration for sliced execution
 */
export interface SlicedExecutionConfig {
  /** Number of slices to divide the order into */
  numberOfSlices: number;
  /** Maximum time to wait for a slice to fill (ms) */
  sliceFillTimeoutMs: number;
  /** Time between fill checks (ms) */
  fillCheckIntervalMs: number;
  /** Maximum imbalance tolerance before aborting (percent of slice size) */
  maxImbalancePercent: number;
  /** Whether to use market orders for final slice if limit doesn't fill */
  useMarketForFinalSlice: boolean;
}

const DEFAULT_CONFIG: SlicedExecutionConfig = {
  numberOfSlices: 5,
  sliceFillTimeoutMs: 30000, // 30 seconds per slice
  fillCheckIntervalMs: 2000, // Check every 2 seconds
  maxImbalancePercent: 10, // Abort if imbalance > 10% of slice
  useMarketForFinalSlice: false,
};

/**
 * SlicedExecutionService - Executes hedged trades in smaller slices
 * 
 * Benefits:
 * 1. Limits single-leg exposure to slice size (not full position)
 * 2. Allows early abort if one side consistently fails to fill
 * 3. Provides reconciliation checkpoints between slices
 * 4. Adapts pricing between slices based on market conditions
 */
@Injectable()
export class SlicedExecutionService {
  private readonly logger = new Logger(SlicedExecutionService.name);

  /**
   * Execute a hedged trade in slices
   * 
   * @param longAdapter Adapter for long exchange
   * @param shortAdapter Adapter for short exchange
   * @param symbol Trading symbol
   * @param totalSize Total position size in base asset
   * @param longPrice Initial limit price for long
   * @param shortPrice Initial limit price for short
   * @param longExchange Exchange type for long
   * @param shortExchange Exchange type for short
   * @param config Sliced execution configuration
   */
  async executeSlicedHedge(
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    symbol: string,
    totalSize: number,
    longPrice: number,
    shortPrice: number,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    config: Partial<SlicedExecutionConfig> = {},
  ): Promise<SlicedExecutionResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const sliceSize = totalSize / cfg.numberOfSlices;
    
    this.logger.log(
      `🍕 Starting sliced execution for ${symbol}: ` +
      `${totalSize.toFixed(4)} total in ${cfg.numberOfSlices} slices of ${sliceSize.toFixed(4)} each`
    );

    const result: SlicedExecutionResult = {
      success: false,
      totalSlices: cfg.numberOfSlices,
      completedSlices: 0,
      totalLongFilled: 0,
      totalShortFilled: 0,
      sliceResults: [],
    };

    // Track cumulative fills
    let cumulativeLongFilled = 0;
    let cumulativeShortFilled = 0;

    for (let i = 0; i < cfg.numberOfSlices; i++) {
      const sliceNumber = i + 1;
      this.logger.debug(`📍 Executing slice ${sliceNumber}/${cfg.numberOfSlices}`);

      // Refresh prices for this slice (market may have moved)
      const [currentLongPrice, currentShortPrice] = await Promise.all([
        longAdapter.getMarkPrice(symbol).catch(() => longPrice),
        shortAdapter.getMarkPrice(symbol).catch(() => shortPrice),
      ]);

      // Determine which exchange to place first (Lighter first if involved)
      const lighterFirst = 
        longExchange === ExchangeType.LIGHTER || 
        shortExchange === ExchangeType.LIGHTER;
      
      const firstIsLong = longExchange === ExchangeType.LIGHTER || 
        (shortExchange !== ExchangeType.LIGHTER);

      const sliceResult = await this.executeSlice(
        longAdapter,
        shortAdapter,
        symbol,
        sliceSize,
        currentLongPrice,
        currentShortPrice,
        longExchange,
        shortExchange,
        sliceNumber,
        cfg,
        firstIsLong,
      );

      result.sliceResults.push(sliceResult);

      if (sliceResult.longFilled && sliceResult.shortFilled) {
        // Both sides filled - success!
        cumulativeLongFilled += sliceResult.longFilledSize;
        cumulativeShortFilled += sliceResult.shortFilledSize;
        result.completedSlices++;
        
        this.logger.log(
          `✅ Slice ${sliceNumber} complete: ` +
          `LONG ${sliceResult.longFilledSize.toFixed(4)}, SHORT ${sliceResult.shortFilledSize.toFixed(4)}`
        );
      } else {
        // Partial or no fill - check imbalance
        const sliceImbalance = Math.abs(sliceResult.longFilledSize - sliceResult.shortFilledSize);
        const imbalancePercent = (sliceImbalance / sliceSize) * 100;

        if (imbalancePercent > cfg.maxImbalancePercent) {
          result.abortReason = 
            `Slice ${sliceNumber} imbalance too high: ${imbalancePercent.toFixed(1)}% > ${cfg.maxImbalancePercent}%`;
          this.logger.warn(`🛑 Aborting sliced execution: ${result.abortReason}`);
          
          // Update totals with partial fills
          cumulativeLongFilled += sliceResult.longFilledSize;
          cumulativeShortFilled += sliceResult.shortFilledSize;
          break;
        }

        // Small imbalance - continue but log warning
        this.logger.warn(
          `⚠️ Slice ${sliceNumber} partial fill: ` +
          `LONG ${sliceResult.longFilledSize.toFixed(4)}, SHORT ${sliceResult.shortFilledSize.toFixed(4)} ` +
          `(imbalance: ${imbalancePercent.toFixed(1)}%)`
        );
        
        cumulativeLongFilled += sliceResult.longFilledSize;
        cumulativeShortFilled += sliceResult.shortFilledSize;
        
        // If one side completely failed, abort
        if (sliceResult.longFilledSize === 0 || sliceResult.shortFilledSize === 0) {
          result.abortReason = `Slice ${sliceNumber}: One side completely failed to fill`;
          this.logger.error(`🛑 Aborting: ${result.abortReason}`);
          break;
        }
      }

      // Brief pause between slices to let market settle
      if (i < cfg.numberOfSlices - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    result.totalLongFilled = cumulativeLongFilled;
    result.totalShortFilled = cumulativeShortFilled;
    result.success = 
      result.completedSlices === cfg.numberOfSlices &&
      Math.abs(cumulativeLongFilled - cumulativeShortFilled) / totalSize < 0.02; // < 2% total imbalance

    this.logger.log(
      `${result.success ? '✅' : '⚠️'} Sliced execution ${result.success ? 'complete' : 'partial'}: ` +
      `${result.completedSlices}/${cfg.numberOfSlices} slices, ` +
      `LONG: ${cumulativeLongFilled.toFixed(4)}, SHORT: ${cumulativeShortFilled.toFixed(4)}` +
      (result.abortReason ? ` (Aborted: ${result.abortReason})` : '')
    );

    return result;
  }

  /**
   * Execute a single slice
   */
  private async executeSlice(
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    symbol: string,
    sliceSize: number,
    longPrice: number,
    shortPrice: number,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    sliceNumber: number,
    config: SlicedExecutionConfig,
    firstIsLong: boolean,
  ): Promise<SliceResult> {
    const result: SliceResult = {
      sliceNumber,
      longFilled: false,
      shortFilled: false,
      longFilledSize: 0,
      shortFilledSize: 0,
    };

    // Create orders
    const longOrder = new PerpOrderRequest(
      symbol,
      OrderSide.LONG,
      OrderType.LIMIT,
      sliceSize,
      longPrice,
      TimeInForce.GTC,
    );

    const shortOrder = new PerpOrderRequest(
      symbol,
      OrderSide.SHORT,
      OrderType.LIMIT,
      sliceSize,
      shortPrice,
      TimeInForce.GTC,
    );

    // Execute first leg (Lighter if involved)
    const firstAdapter = firstIsLong ? longAdapter : shortAdapter;
    const firstOrder = firstIsLong ? longOrder : shortOrder;
    const firstExchange = firstIsLong ? longExchange : shortExchange;

    try {
      const firstResponse = await firstAdapter.placeOrder(firstOrder);
      
      if (!firstResponse.isSuccess()) {
        result.error = `First leg (${firstIsLong ? 'LONG' : 'SHORT'}) failed: ${firstResponse.error}`;
        return result;
      }

      if (firstIsLong) {
        result.longOrderId = firstResponse.orderId;
      } else {
        result.shortOrderId = firstResponse.orderId;
      }

      // Wait for first leg to fill (with timeout)
      const firstFillResult = await this.waitForFill(
        firstAdapter,
        firstResponse.orderId!,
        symbol,
        sliceSize,
        config.sliceFillTimeoutMs,
        config.fillCheckIntervalMs,
      );

      if (firstIsLong) {
        result.longFilledSize = firstFillResult.filledSize;
        result.longFilled = firstFillResult.filled;
      } else {
        result.shortFilledSize = firstFillResult.filledSize;
        result.shortFilled = firstFillResult.filled;
      }

      // If first leg didn't fill well, don't proceed with second
      if (firstFillResult.filledSize < sliceSize * 0.5) {
        result.error = `First leg only ${((firstFillResult.filledSize / sliceSize) * 100).toFixed(0)}% filled`;
        // Cancel remaining first leg order
        if (firstResponse.orderId && !firstFillResult.filled) {
          await firstAdapter.cancelOrder(firstResponse.orderId, symbol).catch(() => {});
        }
        return result;
      }

      // Execute second leg with size matching first leg's fill
      const secondAdapter = firstIsLong ? shortAdapter : longAdapter;
      const matchedSize = firstFillResult.filledSize; // Match the actual fill
      const secondOrder = new PerpOrderRequest(
        symbol,
        firstIsLong ? OrderSide.SHORT : OrderSide.LONG,
        OrderType.LIMIT,
        matchedSize,
        firstIsLong ? shortPrice : longPrice,
        TimeInForce.GTC,
      );

      const secondResponse = await secondAdapter.placeOrder(secondOrder);

      if (!secondResponse.isSuccess()) {
        result.error = `Second leg failed: ${secondResponse.error}`;
        // Rollback first leg
        await this.rollbackLeg(
          firstAdapter,
          symbol,
          firstFillResult.filledSize,
          firstIsLong ? OrderSide.LONG : OrderSide.SHORT,
          firstIsLong ? longPrice : shortPrice,
        );
        if (firstIsLong) {
          result.longFilledSize = 0;
          result.longFilled = false;
        } else {
          result.shortFilledSize = 0;
          result.shortFilled = false;
        }
        return result;
      }

      if (firstIsLong) {
        result.shortOrderId = secondResponse.orderId;
      } else {
        result.longOrderId = secondResponse.orderId;
      }

      // Wait for second leg to fill
      const secondFillResult = await this.waitForFill(
        secondAdapter,
        secondResponse.orderId!,
        symbol,
        matchedSize,
        config.sliceFillTimeoutMs,
        config.fillCheckIntervalMs,
      );

      if (firstIsLong) {
        result.shortFilledSize = secondFillResult.filledSize;
        result.shortFilled = secondFillResult.filled;
      } else {
        result.longFilledSize = secondFillResult.filledSize;
        result.longFilled = secondFillResult.filled;
      }

      // If second leg partially filled, we have imbalance (handled by caller)
      if (!secondFillResult.filled && secondResponse.orderId) {
        // Cancel unfilled portion
        await secondAdapter.cancelOrder(secondResponse.orderId, symbol).catch(() => {});
      }

      return result;

    } catch (error: any) {
      result.error = error.message;
      this.logger.error(`Slice ${sliceNumber} error: ${error.message}`);
      return result;
    }
  }

  /**
   * Wait for an order to fill
   */
  private async waitForFill(
    adapter: IPerpExchangeAdapter,
    orderId: string,
    symbol: string,
    expectedSize: number,
    timeoutMs: number,
    checkIntervalMs: number,
  ): Promise<{ filled: boolean; filledSize: number }> {
    const startTime = Date.now();
    let lastFilledSize = 0;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const orderStatus = await adapter.getOrderStatus(orderId, symbol);
        
        if (orderStatus.status === 'FILLED') {
          return { filled: true, filledSize: orderStatus.filledSize || expectedSize };
        }

        if (orderStatus.status === 'PARTIALLY_FILLED') {
          lastFilledSize = orderStatus.filledSize || 0;
        }

        if (orderStatus.status === 'CANCELLED' || orderStatus.status === 'REJECTED') {
          return { filled: false, filledSize: lastFilledSize };
        }

        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
      } catch (error: any) {
        // If we can't get status, check position instead
        try {
          const position = await adapter.getPosition(symbol);
          if (position && Math.abs(position.size) >= expectedSize * 0.95) {
            return { filled: true, filledSize: Math.abs(position.size) };
          }
        } catch {
          // Continue waiting
        }
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
      }
    }

    // Timeout - return what we have
    return { filled: false, filledSize: lastFilledSize };
  }

  /**
   * Rollback a filled leg by placing opposite order
   */
  private async rollbackLeg(
    adapter: IPerpExchangeAdapter,
    symbol: string,
    size: number,
    originalSide: OrderSide,
    price: number,
  ): Promise<void> {
    try {
      const rollbackOrder = new PerpOrderRequest(
        symbol,
        originalSide === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
        OrderType.LIMIT,
        size,
        price,
        TimeInForce.GTC,
        true, // reduceOnly
      );
      await adapter.placeOrder(rollbackOrder);
      this.logger.log(`✅ Rolled back ${originalSide} position of ${size.toFixed(4)} ${symbol}`);
    } catch (error: any) {
      this.logger.error(`🚨 Failed to rollback ${originalSide} leg: ${error.message}`);
    }
  }
}

