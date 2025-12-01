import { ExchangeType } from '../value-objects/ExchangeConfig';
import { OrderSide, OrderStatus, OrderType, PerpOrderRequest, PerpOrderResponse } from '../value-objects/PerpOrder';

/**
 * PerpOrder entity - tracks order lifecycle across exchanges
 */
export class PerpOrder {
  constructor(
    public readonly id: string, // Internal order ID (UUID)
    public readonly exchangeType: ExchangeType,
    public readonly exchangeOrderId: string, // Exchange-provided order ID
    public readonly symbol: string,
    public readonly side: OrderSide,
    public readonly type: OrderType,
    public readonly size: number, // Original order size
    public readonly price?: number, // Limit price if applicable
    public readonly status: OrderStatus = OrderStatus.PENDING,
    public readonly filledSize: number = 0, // Amount filled so far
    public readonly averageFillPrice?: number, // Average fill price
    public readonly error?: string, // Error message if rejected
    public readonly createdAt: Date = new Date(),
    public readonly updatedAt: Date = new Date(),
    public readonly filledAt?: Date, // When order was filled
    public readonly cancelledAt?: Date, // When order was cancelled
    public readonly clientOrderId?: string, // Client-provided order ID
  ) {
    // Validation
    if (size <= 0) {
      throw new Error('Order size must be greater than 0');
    }

    if (filledSize < 0 || filledSize > size) {
      throw new Error('Filled size must be between 0 and order size');
    }

    if (averageFillPrice !== undefined && averageFillPrice <= 0) {
      throw new Error('Average fill price must be greater than 0');
    }
  }

  /**
   * Creates a PerpOrder from a PerpOrderRequest and PerpOrderResponse
   */
  static fromRequestAndResponse(
    id: string,
    exchangeType: ExchangeType,
    request: PerpOrderRequest,
    response: PerpOrderResponse,
  ): PerpOrder {
    return new PerpOrder(
      id,
      exchangeType,
      response.orderId,
      request.symbol,
      request.side,
      request.type,
      request.size,
      request.price,
      response.status,
      response.filledSize ?? 0,
      response.averageFillPrice,
      response.error,
      response.timestamp ?? new Date(),
      response.timestamp ?? new Date(),
      response.isFilled() ? response.timestamp : undefined,
      undefined,
      response.clientOrderId ?? request.clientOrderId,
    );
  }

  /**
   * Returns true if the order is fully filled
   */
  isFilled(): boolean {
    return this.status === OrderStatus.FILLED;
  }

  /**
   * Returns true if the order is partially filled
   */
  isPartiallyFilled(): boolean {
    return this.status === OrderStatus.PARTIALLY_FILLED;
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
   * Returns true if the order is cancelled or rejected
   */
  isTerminal(): boolean {
    return (
      this.status === OrderStatus.CANCELLED ||
      this.status === OrderStatus.REJECTED ||
      this.status === OrderStatus.EXPIRED ||
      this.status === OrderStatus.FILLED
    );
  }

  /**
   * Returns the remaining size to be filled
   */
  getRemainingSize(): number {
    return this.size - this.filledSize;
  }

  /**
   * Returns the fill percentage (0-100)
   */
  getFillPercentage(): number {
    if (this.size === 0) return 0;
    return (this.filledSize / this.size) * 100;
  }

  /**
   * Updates the order with new status and fill information
   */
  update(
    status: OrderStatus,
    filledSize?: number,
    averageFillPrice?: number,
    error?: string,
  ): PerpOrder {
    const newFilledSize = filledSize ?? this.filledSize;
    const newAverageFillPrice = averageFillPrice ?? this.averageFillPrice;
    const filledAt = status === OrderStatus.FILLED ? new Date() : this.filledAt;
    const cancelledAt = status === OrderStatus.CANCELLED ? new Date() : this.cancelledAt;

    return new PerpOrder(
      this.id,
      this.exchangeType,
      this.exchangeOrderId,
      this.symbol,
      this.side,
      this.type,
      this.size,
      this.price,
      status,
      newFilledSize,
      newAverageFillPrice,
      error,
      this.createdAt,
      new Date(),
      filledAt,
      cancelledAt,
      this.clientOrderId,
    );
  }
}

