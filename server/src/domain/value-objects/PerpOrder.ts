/**
 * Order side enum - LONG or SHORT
 */
export enum OrderSide {
  LONG = 'LONG',
  SHORT = 'SHORT',
}

/**
 * Order type enum
 */
export enum OrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
  STOP_LOSS = 'STOP_LOSS',
  TAKE_PROFIT = 'TAKE_PROFIT',
}

/**
 * Order status enum
 */
export enum OrderStatus {
  PENDING = 'PENDING',
  SUBMITTED = 'SUBMITTED',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCELLED = 'CANCELLED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

/**
 * Time in force enum
 */
export enum TimeInForce {
  GTC = 'GTC', // Good Till Cancel
  IOC = 'IOC', // Immediate Or Cancel
  FOK = 'FOK', // Fill Or Kill
}

/**
 * PerpOrderRequest - Value object for order requests
 */
export class PerpOrderRequest {
  constructor(
    public readonly symbol: string,
    public readonly side: OrderSide,
    public readonly type: OrderType,
    public readonly size: number,
    public readonly price?: number, // Required for LIMIT orders
    public readonly timeInForce?: TimeInForce, // Required for LIMIT orders
    public readonly reduceOnly: boolean = false, // True for closing orders
    public readonly stopPrice?: number, // Required for STOP_LOSS and TAKE_PROFIT orders
    public readonly clientOrderId?: string, // Optional client-provided order ID
  ) {
    // Validation
    if (size <= 0) {
      throw new Error('Order size must be greater than 0');
    }

    if (type === OrderType.LIMIT && !price) {
      throw new Error('Limit price is required for LIMIT orders');
    }

    if ((type === OrderType.STOP_LOSS || type === OrderType.TAKE_PROFIT) && !stopPrice) {
      throw new Error('Stop price is required for STOP_LOSS and TAKE_PROFIT orders');
    }
  }

  /**
   * Returns true if this is a market order
   */
  isMarketOrder(): boolean {
    return this.type === OrderType.MARKET;
  }

  /**
   * Returns true if this is a limit order
   */
  isLimitOrder(): boolean {
    return this.type === OrderType.LIMIT;
  }

  /**
   * Returns true if this is an opening order (not reduce-only)
   */
  isOpeningOrder(): boolean {
    return !this.reduceOnly;
  }

  /**
   * Returns true if this is a closing order (reduce-only)
   */
  isClosingOrder(): boolean {
    return this.reduceOnly;
  }
}

/**
 * PerpOrderResponse - Value object for order responses
 */
export class PerpOrderResponse {
  constructor(
    public readonly orderId: string,
    public readonly status: OrderStatus,
    public readonly symbol: string,
    public readonly side: OrderSide,
    public readonly clientOrderId?: string,
    public readonly filledSize?: number,
    public readonly averageFillPrice?: number,
    public readonly error?: string,
    public readonly timestamp: Date = new Date(),
  ) {}

  /**
   * Returns true if the order was successfully placed
   */
  isSuccess(): boolean {
    return this.status !== OrderStatus.REJECTED && !this.error;
  }

  /**
   * Returns true if the order is fully filled
   */
  isFilled(): boolean {
    return this.status === OrderStatus.FILLED;
  }

  /**
   * Returns true if the order is still active (pending, submitted, or partially filled)
   */
  isActive(): boolean {
    return (
      this.status === OrderStatus.PENDING ||
      this.status === OrderStatus.SUBMITTED ||
      this.status === OrderStatus.PARTIALLY_FILLED
    );
  }

  /**
   * Returns true if the order was cancelled
   */
  isCancelled(): boolean {
    return this.status === OrderStatus.CANCELLED;
  }

  /**
   * Returns true if the order was rejected
   */
  isRejected(): boolean {
    return this.status === OrderStatus.REJECTED;
  }
}
