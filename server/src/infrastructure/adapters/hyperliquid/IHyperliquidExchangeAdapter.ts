/**
 * IHyperliquidExchangeAdapter - Hyperliquid-specific exchange adapter interface
 * 
 * Extends IPerpExchangeAdapter with Hyperliquid-specific methods and types.
 * Based on: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
 */

import { IPerpExchangeAdapter } from '../../../domain/ports/IPerpExchangeAdapter';
import { PerpOrderRequest, PerpOrderResponse } from '../../../domain/value-objects/PerpOrder';
import {
  HyperliquidOrderRequest,
  HyperliquidModifyOrderRequest,
  HyperliquidBatchOrderRequest,
  HyperliquidFillEvent,
  HyperliquidOrderUpdate,
  HyperliquidPosition,
  HyperliquidOpenOrder,
  HyperliquidClearinghouseState,
  HyperliquidL2Book,
  HyperliquidActiveAssetCtx,
  HyperliquidMetaAndAssetCtxs,
  HyperliquidUserState,
} from './types';

/**
 * Hyperliquid-specific exchange adapter interface
 */
export interface IHyperliquidExchangeAdapter extends IPerpExchangeAdapter {
  /**
   * Get asset index for a coin symbol
   * @param coin Coin symbol (e.g., 'ETH', 'BTC')
   * @returns Asset index
   */
  getAssetIndex(coin: string): Promise<number>;

  /**
   * Get wallet address for the configured account
   * @returns Wallet address
   */
  getWalletAddress(): Promise<string>;

  /**
   * Place order using Hyperliquid-specific order request
   * @param request Hyperliquid order request
   * @returns Order response
   */
  placeHyperliquidOrder(request: HyperliquidOrderRequest): Promise<PerpOrderResponse>;

  /**
   * Place batch orders using Hyperliquid-specific batch request
   * @param request Hyperliquid batch order request
   * @returns Array of order responses
   */
  placeHyperliquidBatchOrders(request: HyperliquidBatchOrderRequest): Promise<PerpOrderResponse[]>;

  /**
   * Modify order using Hyperliquid-specific modification request
   * @param request Hyperliquid modify order request
   * @returns Updated order response
   */
  modifyHyperliquidOrder(request: HyperliquidModifyOrderRequest): Promise<PerpOrderResponse>;

  /**
   * Get position for a coin
   * @param coin Coin symbol
   * @returns Hyperliquid position or null if no position
   */
  getHyperliquidPosition(coin: string): Promise<HyperliquidPosition | null>;

  /**
   * Get all positions
   * @returns Map of coin symbol to Hyperliquid position
   */
  getHyperliquidPositions(): Promise<Map<string, HyperliquidPosition>>;

  /**
   * Get open order by order ID
   * @param oid Order ID
   * @param coin Coin symbol
   * @returns Hyperliquid open order or null if not found
   */
  getHyperliquidOpenOrder(oid: number, coin: string): Promise<HyperliquidOpenOrder | null>;

  /**
   * Get all open orders
   * @returns Array of Hyperliquid open orders
   */
  getHyperliquidOpenOrders(): Promise<HyperliquidOpenOrder[]>;

  /**
   * Get clearinghouse state (positions and margin)
   * @returns Clearinghouse state
   */
  getHyperliquidClearinghouseState(): Promise<HyperliquidClearinghouseState>;

  /**
   * Get user state (positions, margin, withdrawable)
   * @returns User state
   */
  getHyperliquidUserState(): Promise<HyperliquidUserState>;

  /**
   * Get meta and asset contexts
   * @returns Meta and asset contexts
   */
  getHyperliquidMetaAndAssetCtxs(): Promise<HyperliquidMetaAndAssetCtxs>;

  /**
   * Get L2 order book for a coin
   * @param coin Coin symbol
   * @returns L2 order book
   */
  getHyperliquidL2Book(coin: string): Promise<HyperliquidL2Book>;

  /**
   * Get active asset context for a coin
   * @param coin Coin symbol
   * @returns Active asset context
   */
  getHyperliquidActiveAssetCtx(coin: string): Promise<HyperliquidActiveAssetCtx>;

  /**
   * Subscribe to L2 order book updates
   * @param coin Coin symbol
   * @param callback Callback for L2 book updates
   * @returns Subscription ID or handle
   */
  subscribeL2Book(
    coin: string,
    callback: (book: HyperliquidL2Book) => void,
  ): Promise<string>;

  /**
   * Subscribe to active asset context updates
   * @param coin Coin symbol
   * @param callback Callback for asset context updates
   * @returns Subscription ID or handle
   */
  subscribeActiveAssetCtx(
    coin: string,
    callback: (ctx: HyperliquidActiveAssetCtx) => void,
  ): Promise<string>;

  /**
   * Subscribe to user fills (requires authentication)
   * @param callback Callback for fill events
   * @returns Subscription ID or handle
   */
  subscribeUserFills(
    callback: (fill: HyperliquidFillEvent) => void,
  ): Promise<string>;

  /**
   * Subscribe to user events (order updates, requires authentication)
   * @param callback Callback for order update events
   * @returns Subscription ID or handle
   */
  subscribeUserEvents(
    callback: (update: HyperliquidOrderUpdate) => void,
  ): Promise<string>;

  /**
   * Subscribe to clearinghouse state updates (positions and margin, requires authentication)
   * @param callback Callback for clearinghouse state updates
   * @returns Subscription ID or handle
   */
  subscribeClearinghouseState(
    callback: (state: HyperliquidClearinghouseState) => void,
  ): Promise<string>;

  /**
   * Subscribe to open orders updates (requires authentication)
   * @param callback Callback for open orders updates
   * @returns Subscription ID or handle
   */
  subscribeOpenOrders(
    callback: (orders: HyperliquidOpenOrder[]) => void,
  ): Promise<string>;

  /**
   * Get best bid and ask prices for a coin
   * @param coin Coin symbol
   * @returns Object with bestBid and bestAsk, or null if unavailable
   */
  getBestBidAsk(coin: string): Promise<{ bestBid: number; bestAsk: number } | null>;
}

