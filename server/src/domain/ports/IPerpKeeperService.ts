import { ExchangeType } from '../value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
} from '../value-objects/PerpOrder';
import { PerpPosition } from '../entities/PerpPosition';
import { PerpOrder } from '../entities/PerpOrder';
import { IPerpExchangeAdapter } from './IPerpExchangeAdapter';

/**
 * Strategy execution result
 */
export interface StrategyExecutionResult {
  success: boolean;
  ordersPlaced: number;
  ordersFilled: number;
  ordersFailed: number;
  error?: string;
  timestamp: Date;
}

/**
 * Position monitoring result
 */
export interface PositionMonitoringResult {
  positions: PerpPosition[];
  totalUnrealizedPnl: number;
  totalPositionValue: number;
  timestamp: Date;
}

/**
 * IPerpKeeperService - Main interface for the perpetual keeper service
 *
 * This service orchestrates perpetual trading operations across multiple exchanges.
 * It manages order placement, position monitoring, and strategy execution.
 */
export interface IPerpKeeperService {
  /**
   * Get an exchange adapter by type
   * @param exchangeType Exchange type
   * @returns Exchange adapter instance
   * @throws Error if exchange adapter not found
   */
  getExchangeAdapter(exchangeType: ExchangeType): IPerpExchangeAdapter;

  /**
   * Get all available exchange adapters
   * @returns Map of exchange types to adapters
   */
  getExchangeAdapters(): Map<ExchangeType, IPerpExchangeAdapter>;

  /**
   * Place an order on a specific exchange
   * @param exchangeType Exchange to use
   * @param request Order request
   * @returns Order response
   * @throws Error if order placement fails
   */
  placeOrder(
    exchangeType: ExchangeType,
    request: PerpOrderRequest,
  ): Promise<PerpOrderResponse>;

  /**
   * Place orders on multiple exchanges (for redundancy or arbitrage)
   * @param requests Map of exchange types to order requests
   * @returns Map of exchange types to order responses
   */
  placeOrdersOnMultipleExchanges(
    requests: Map<ExchangeType, PerpOrderRequest>,
  ): Promise<Map<ExchangeType, PerpOrderResponse>>;

  /**
   * Get position from a specific exchange
   * @param exchangeType Exchange to query
   * @param symbol Trading symbol
   * @returns Position or null if no position
   */
  getPosition(
    exchangeType: ExchangeType,
    symbol: string,
  ): Promise<PerpPosition | null>;

  /**
   * Get all positions across all exchanges
   * @returns Array of all positions
   */
  getAllPositions(): Promise<PerpPosition[]>;

  /**
   * Monitor positions across all exchanges
   * @returns Position monitoring result with aggregated data
   */
  monitorPositions(): Promise<PositionMonitoringResult>;

  /**
   * Cancel an order on a specific exchange
   * @param exchangeType Exchange to use
   * @param orderId Order ID to cancel
   * @param symbol Trading symbol (optional)
   * @returns True if cancellation was successful
   */
  cancelOrder(
    exchangeType: ExchangeType,
    orderId: string,
    symbol?: string,
  ): Promise<boolean>;

  /**
   * Cancel all orders for a symbol on a specific exchange
   * @param exchangeType Exchange to use
   * @param symbol Trading symbol
   * @returns Number of orders cancelled
   */
  cancelAllOrders(exchangeType: ExchangeType, symbol: string): Promise<number>;

  /**
   * Execute a trading strategy
   * This is a high-level method that can execute complex multi-exchange strategies
   * @param strategy Strategy execution function
   * @returns Strategy execution result
   */
  executeStrategy(
    strategy: (
      adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    ) => Promise<StrategyExecutionResult>,
  ): Promise<StrategyExecutionResult>;

  /**
   * Get order status from a specific exchange
   * @param exchangeType Exchange to query
   * @param orderId Order ID
   * @param symbol Trading symbol (optional)
   * @returns Order response with current status
   */
  getOrderStatus(
    exchangeType: ExchangeType,
    orderId: string,
    symbol?: string,
  ): Promise<PerpOrderResponse>;

  /**
   * Get mark price from a specific exchange
   * @param exchangeType Exchange to query
   * @param symbol Trading symbol
   * @returns Current mark price
   */
  getMarkPrice(exchangeType: ExchangeType, symbol: string): Promise<number>;

  /**
   * Get account balance from a specific exchange
   * @param exchangeType Exchange to query
   * @returns Available balance in USD
   */
  getBalance(exchangeType: ExchangeType): Promise<number>;

  /**
   * Get account equity from a specific exchange
   * @param exchangeType Exchange to query
   * @returns Total equity in USD
   */
  getEquity(exchangeType: ExchangeType): Promise<number>;

  /**
   * Check if all exchange adapters are ready
   * @returns True if all adapters are ready
   */
  areExchangesReady(): Promise<boolean>;

  /**
   * Test connections to all exchanges
   * @throws Error if any connection test fails
   */
  testAllConnections(): Promise<void>;
}
