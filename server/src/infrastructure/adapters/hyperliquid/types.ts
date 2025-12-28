/**
 * Hyperliquid Exchange Adapter Types
 * 
 * Type definitions for Hyperliquid WebSocket API responses and requests.
 * Based on: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
 */

/**
 * Hyperliquid L2 Order Book Level
 */
export interface HyperliquidL2Level {
  px: string; // Price as string
  sz: string; // Size as string
  n: number; // Number of orders at this level
}

/**
 * Hyperliquid L2 Order Book Response
 */
export interface HyperliquidL2Book {
  coin: string;
  levels: [HyperliquidL2Level[], HyperliquidL2Level[]]; // [bids, asks]
  time: number;
}

/**
 * Hyperliquid Active Asset Context
 */
export interface HyperliquidActiveAssetCtx {
  coin: string;
  ctx: {
    funding: number;
    openInterest: number;
    oraclePx: number;
    markPx: number;
    midPx?: number;
    dayNtlVlm: number; // Daily notional volume
    prevDayPx: number;
  };
}

/**
 * Hyperliquid Fill Event (from userFills subscription)
 */
export interface HyperliquidFillEvent {
  coin: string;
  oid: string; // Order ID
  side: 'B' | 'A'; // B = Buy/Long, A = Ask/Short
  px: string; // Price
  sz: string; // Size
  time: number;
  hash: string; // Transaction hash
  closedPnl?: string;
  fee?: string;
}

/**
 * Hyperliquid Order Update Event (from userEvents subscription)
 */
export interface HyperliquidOrderUpdate {
  order: {
    coin: string;
    side: 'B' | 'A'; // B = Buy/Long, A = Ask/Short
    oid: number; // Order ID
    sz: string; // Current size
    px?: string; // Price (optional for market orders)
    origSz?: string; // Original size
    status: 'filled' | 'canceled' | 'open' | 'triggered';
  };
}

/**
 * Hyperliquid Position (from clearinghouseState)
 */
export interface HyperliquidPosition {
  coin: string;
  szi: string; // Position size (positive = long, negative = short)
  leverage: {
    type: string; // 'cross' | 'isolated'
    value: number;
  };
  entryPx: string; // Entry price
  positionValue: string; // Position value in USD
  unrealizedPnl: string; // Unrealized PnL
  returnOnEquity: string; // Return on equity
  liquidationPx: string | null; // Liquidation price
  marginUsed: string; // Margin used
}

/**
 * Hyperliquid Asset Position (wrapped position)
 */
export interface HyperliquidAssetPosition {
  coin: string;
  position: HyperliquidPosition;
}

/**
 * Hyperliquid Margin Summary
 */
export interface HyperliquidMarginSummary {
  accountValue: number; // Total account value
  totalNtlPos: number; // Total notional position
  totalRawUsd: number; // Total raw USD
  totalMarginUsed: number; // Total margin used
}

/**
 * Hyperliquid Clearinghouse State Response
 */
export interface HyperliquidClearinghouseState {
  assetPositions: HyperliquidAssetPosition[];
  marginSummary: HyperliquidMarginSummary;
  crossMarginSummary?: HyperliquidMarginSummary; // Alternative field name
  withdrawable: number; // Withdrawable amount
}

/**
 * Hyperliquid Open Order (from openOrders subscription)
 */
export interface HyperliquidOpenOrder {
  coin: string;
  side: string; // 'B' | 'A'
  limitPx: string; // Limit price
  sz: string; // Size
  oid: number; // Order ID
  timestamp: number;
  origSz: string; // Original size
  cloid?: string; // Client order ID
}

/**
 * Hyperliquid Open Orders Response
 */
export interface HyperliquidOpenOrdersResponse {
  orders: HyperliquidOpenOrder[];
}

/**
 * Hyperliquid WebSocket Subscription Request
 */
export interface HyperliquidWebSocketSubscription {
  method: 'subscribe';
  subscription: {
    type: 'l2Book' | 'activeAssetCtx' | 'userFills' | 'userEvents' | 'clearinghouseState' | 'openOrders';
    coin?: string; // Required for l2Book, activeAssetCtx
    user?: string; // Required for userFills, userEvents, clearinghouseState, openOrders
  };
}

/**
 * Hyperliquid WebSocket Message
 */
export interface HyperliquidWebSocketMessage {
  channel?: string;
  data?: any;
}

/**
 * Hyperliquid Order Request (internal)
 */
export interface HyperliquidOrderRequest {
  coin: string;
  side: 'B' | 'A'; // B = Buy/Long, A = Ask/Short
  sz: string; // Size
  limitPx?: string; // Limit price (required for limit orders)
  orderType: 'Limit' | 'Market';
  timeInForce?: 'Gtc' | 'Ioc' | 'Alo'; // Good till cancel, Immediate or cancel, Add liquidity only
  reduceOnly?: boolean;
  cloid?: string; // Client order ID
  triggerPx?: string; // Trigger price for stop orders
  isTrigger?: boolean; // Is this a trigger order
}

/**
 * Hyperliquid Order Modification Request (internal)
 */
export interface HyperliquidModifyOrderRequest {
  oid: number; // Order ID
  coin: string;
  newLimitPx?: string; // New limit price
  newSz?: string; // New size
}

/**
 * Hyperliquid Meta Response (from REST API)
 */
export interface HyperliquidMeta {
  universe: Array<{
    name: string; // Coin symbol
    szDecimals: number; // Size decimals
    maxLeverage: number;
    onlyIsolated: boolean;
    maxFundingRate: number;
    maxOracleSpread: number;
  }>;
}

/**
 * Hyperliquid Asset Context (from REST API)
 */
export interface HyperliquidAssetCtx {
  coin: string;
  funding: number;
  openInterest: number;
  oraclePx: number;
  markPx: number;
  midPx?: number;
  dayNtlVlm: number;
  prevDayPx: number;
}

/**
 * Hyperliquid Meta and Asset Contexts Response (from REST API)
 */
export interface HyperliquidMetaAndAssetCtxs {
  meta: HyperliquidMeta;
  assetCtxs: HyperliquidAssetCtx[];
}

/**
 * Hyperliquid User State Response (from REST API)
 */
export interface HyperliquidUserState {
  assetPositions: HyperliquidAssetPosition[];
  marginSummary: HyperliquidMarginSummary;
  withdrawable: number;
}

/**
 * Hyperliquid Order Response (from REST API)
 */
export interface HyperliquidOrderResponse {
  status: 'ok' | 'err';
  response?: {
    type: 'order';
    data: {
      statuses: Array<{
        rest: {
          oid: number;
          cloid?: string;
        };
        filled?: {
          totalSz: string;
          avgPx: string;
        };
      }>;
    };
  };
  error?: string;
}

/**
 * Hyperliquid Cancel Order Response (from REST API)
 */
export interface HyperliquidCancelOrderResponse {
  status: 'ok' | 'err';
  response?: {
    type: 'cancel';
    data: {
      statuses: Array<{
        cancelled: string[]; // Array of cancelled order IDs
      }>;
    };
  };
  error?: string;
}

/**
 * Hyperliquid Batch Order Request (internal)
 */
export interface HyperliquidBatchOrderRequest {
  orders: HyperliquidOrderRequest[];
}

/**
 * Hyperliquid Batch Order Response (from REST API)
 */
export interface HyperliquidBatchOrderResponse {
  status: 'ok' | 'err';
  response?: {
    type: 'order';
    data: {
      statuses: Array<{
        rest: {
          oid: number;
          cloid?: string;
        };
        filled?: {
          totalSz: string;
          avgPx: string;
        };
        err?: string;
      }>;
    };
  };
  error?: string;
}

