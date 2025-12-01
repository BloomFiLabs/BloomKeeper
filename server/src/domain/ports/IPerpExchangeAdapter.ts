import { ExchangeConfig } from '../value-objects/ExchangeConfig';
import { PerpOrderRequest, PerpOrderResponse } from '../value-objects/PerpOrder';
import { PerpPosition } from '../entities/PerpPosition';

/**
 * Exchange-specific error
 */
export class ExchangeError extends Error {
  constructor(
    message: string,
    public readonly exchangeType: string,
    public readonly code?: string,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
}

/**
 * IPerpExchangeAdapter - Interface for perpetual exchange adapters
 * 
 * This interface abstracts the operations needed to interact with perpetual exchanges
 * (Aster, Lighter, Hyperliquid). Each exchange will have its own implementation.
 */
export interface IPerpExchangeAdapter {
  /**
   * Get the exchange configuration
   */
  getConfig(): ExchangeConfig;

  /**
   * Get the exchange type
   */
  getExchangeType(): string;

  /**
   * Place an order on the exchange
   * @param request Order request
   * @returns Order response with order ID and status
   * @throws ExchangeError if order placement fails
   */
  placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse>;

  /**
   * Get current position for a symbol
   * @param symbol Trading symbol (e.g., 'ETHUSDT', 'ETH')
   * @returns Position information or null if no position
   * @throws ExchangeError if position fetch fails
   */
  getPosition(symbol: string): Promise<PerpPosition | null>;

  /**
   * Get all open positions
   * @returns Array of all open positions
   * @throws ExchangeError if positions fetch fails
   */
  getPositions(): Promise<PerpPosition[]>;

  /**
   * Cancel an order
   * @param orderId Exchange-provided order ID
   * @param symbol Trading symbol (optional, some exchanges require it)
   * @returns True if cancellation was successful
   * @throws ExchangeError if cancellation fails
   */
  cancelOrder(orderId: string, symbol?: string): Promise<boolean>;

  /**
   * Cancel all open orders for a symbol
   * @param symbol Trading symbol
   * @returns Number of orders cancelled
   * @throws ExchangeError if cancellation fails
   */
  cancelAllOrders(symbol: string): Promise<number>;

  /**
   * Get order status
   * @param orderId Exchange-provided order ID
   * @param symbol Trading symbol (optional, some exchanges require it)
   * @returns Order response with current status
   * @throws ExchangeError if order fetch fails
   */
  getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse>;

  /**
   * Get current mark price for a symbol
   * @param symbol Trading symbol
   * @returns Current mark price
   * @throws ExchangeError if price fetch fails
   */
  getMarkPrice(symbol: string): Promise<number>;

  /**
   * Get account balance (available margin/collateral)
   * @returns Available balance in USD
   * @throws ExchangeError if balance fetch fails
   */
  getBalance(): Promise<number>;

  /**
   * Get account equity (total account value)
   * @returns Total equity in USD
   * @throws ExchangeError if equity fetch fails
   */
  getEquity(): Promise<number>;

  /**
   * Check if the exchange adapter is connected and ready
   * @returns True if adapter is ready
   */
  isReady(): Promise<boolean>;

  /**
   * Test the connection to the exchange
   * @throws ExchangeError if connection test fails
   */
  testConnection(): Promise<void>;
}

