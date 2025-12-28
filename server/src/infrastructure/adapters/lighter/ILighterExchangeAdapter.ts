/**
 * ILighterExchangeAdapter - Lighter-specific exchange adapter interface
 * 
 * Extends IPerpExchangeAdapter with Lighter Protocol-specific methods and types.
 * Based on: https://apidocs.lighter.xyz/docs/websocket-reference
 */

import { IPerpExchangeAdapter } from '../../../domain/ports/IPerpExchangeAdapter';
import { PerpOrderRequest, PerpOrderResponse } from '../../../domain/value-objects/PerpOrder';
import {
  LighterOrder,
  LighterPosition,
  LighterTrade,
  LighterAccountMarketResponse,
  LighterAccountAllOrdersResponse,
  LighterAccountOrdersResponse,
  LighterAccountAllTradesResponse,
  LighterAccountAllPositionsResponse,
  LighterAccountAllAssetsResponse,
  LighterOrderBookResponse,
  LighterMarketStatsResponse,
  LighterOrderRequest,
  LighterModifyOrderRequest,
} from './types';

/**
 * Lighter-specific exchange adapter interface
 */
export interface ILighterExchangeAdapter extends IPerpExchangeAdapter {
  /**
   * Get market index for a symbol
   * @param symbol Trading symbol
   * @returns Market index
   */
  getMarketIndex(symbol: string): Promise<number>;

  /**
   * Get account index for the configured account
   * @returns Account index
   */
  getAccountIndex(): Promise<number>;

  /**
   * Place order using Lighter-specific order request
   * @param request Lighter order request
   * @returns Order response
   */
  placeLighterOrder(request: LighterOrderRequest): Promise<PerpOrderResponse>;

  /**
   * Modify order using Lighter-specific modification request
   * @param request Lighter modify order request
   * @returns Updated order response
   */
  modifyLighterOrder(request: LighterModifyOrderRequest): Promise<PerpOrderResponse>;

  /**
   * Get order by order index
   * @param orderIndex Order index
   * @param marketIndex Market index
   * @returns Lighter order or null if not found
   */
  getLighterOrder(orderIndex: number, marketIndex: number): Promise<LighterOrder | null>;

  /**
   * Get all orders for a market
   * @param marketIndex Market index
   * @returns Array of Lighter orders
   */
  getLighterOrders(marketIndex: number): Promise<LighterOrder[]>;

  /**
   * Get position for a market
   * @param marketIndex Market index
   * @returns Lighter position or null if no position
   */
  getLighterPosition(marketIndex: number): Promise<LighterPosition | null>;

  /**
   * Get all positions
   * @returns Map of market index to Lighter position
   */
  getLighterPositions(): Promise<Map<number, LighterPosition>>;

  /**
   * Get trades for a market
   * @param marketIndex Market index
   * @param limit Optional limit on number of trades
   * @returns Array of Lighter trades
   */
  getLighterTrades(marketIndex: number, limit?: number): Promise<LighterTrade[]>;

  /**
   * Get order book for a market
   * @param marketIndex Market index
   * @returns Order book response
   */
  getLighterOrderBook(marketIndex: number): Promise<LighterOrderBookResponse>;

  /**
   * Get market stats for a market
   * @param marketIndex Market index
   * @returns Market stats response
   */
  getLighterMarketStats(marketIndex: number): Promise<LighterMarketStatsResponse>;

  /**
   * Subscribe to account market updates
   * @param marketIndex Market index
   * @param callback Callback for account market updates
   * @returns Subscription ID or handle
   */
  subscribeAccountMarket(
    marketIndex: number,
    callback: (data: LighterAccountMarketResponse) => void,
  ): Promise<string>;

  /**
   * Subscribe to account all orders updates
   * @param callback Callback for account all orders updates
   * @returns Subscription ID or handle
   */
  subscribeAccountAllOrders(
    callback: (data: LighterAccountAllOrdersResponse) => void,
  ): Promise<string>;

  /**
   * Subscribe to account orders updates for a specific market
   * @param marketIndex Market index
   * @param callback Callback for account orders updates
   * @returns Subscription ID or handle
   */
  subscribeAccountOrders(
    marketIndex: number,
    callback: (data: LighterAccountOrdersResponse) => void,
  ): Promise<string>;

  /**
   * Subscribe to account all trades updates
   * @param callback Callback for account all trades updates
   * @returns Subscription ID or handle
   */
  subscribeAccountAllTrades(
    callback: (data: LighterAccountAllTradesResponse) => void,
  ): Promise<string>;

  /**
   * Subscribe to account all positions updates
   * @param callback Callback for account all positions updates
   * @returns Subscription ID or handle
   */
  subscribeAccountAllPositions(
    callback: (data: LighterAccountAllPositionsResponse) => void,
  ): Promise<string>;

  /**
   * Subscribe to account all assets updates
   * @param callback Callback for account all assets updates
   * @returns Subscription ID or handle
   */
  subscribeAccountAllAssets(
    callback: (data: LighterAccountAllAssetsResponse) => void,
  ): Promise<string>;

  /**
   * Send transaction via WebSocket
   * @param txType Transaction type
   * @param txInfo Transaction info
   * @returns Transaction hash
   */
  sendWebSocketTransaction(txType: number, txInfo: any): Promise<string>;

  /**
   * Send batch transactions via WebSocket
   * @param txTypes Array of transaction types
   * @param txInfos Array of transaction infos
   * @returns Array of transaction hashes
   */
  sendWebSocketBatchTransactions(
    txTypes: number[],
    txInfos: any[],
  ): Promise<string[]>;
}

