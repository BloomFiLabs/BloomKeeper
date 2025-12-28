/**
 * Lighter Exchange Adapter Types
 * 
 * Type definitions for Lighter Protocol WebSocket API responses and requests.
 * Based on: https://apidocs.lighter.xyz/docs/websocket-reference
 */

/**
 * Lighter Transaction JSON structure
 */
export interface LighterTransaction {
  hash: string;
  type: number;
  info: string; // JSON object as string
  event_info: string; // JSON object as string
  status: number;
  transaction_index: number;
  l1_address: string;
  account_index: number;
  nonce: number;
  expire_at: number;
  block_height: number;
  queued_at: number;
  executed_at: number;
  sequence_index: number;
  parent_hash: string;
  transaction_time: number;
}

/**
 * Lighter Order JSON structure
 */
export interface LighterOrder {
  order_index: number;
  client_order_index: number;
  order_id: string; // Same as order_index but string
  client_order_id: string; // Same as client_order_index but string
  market_index: number;
  owner_account_index: number;
  initial_base_amount: string;
  price: string;
  nonce: number;
  remaining_base_amount: string;
  is_ask: boolean;
  base_size: number;
  base_price: number;
  filled_base_amount: string;
  filled_quote_amount: string;
  side: string; // 'buy' | 'sell'
  type: string; // Order type
  time_in_force: string;
  reduce_only: boolean;
  trigger_price: string;
  order_expiry: number;
  status: string; // Order status
  trigger_status: string;
  trigger_time: number;
  parent_order_index: number;
  parent_order_id: string;
  to_trigger_order_id_0: string;
  to_trigger_order_id_1: string;
  to_cancel_order_id_0: string;
  block_height: number;
  timestamp: number;
  created_at: number;
  updated_at: number;
  transaction_time: number;
}

/**
 * Lighter Trade JSON structure
 */
export interface LighterTrade {
  trade_id: number;
  tx_hash: string;
  type: string; // 'buy' | 'sell'
  market_id: number;
  size: string;
  price: string;
  usd_amount: string;
  ask_id: number;
  bid_id: number;
  ask_account_id: number;
  bid_account_id: number;
  is_maker_ask: boolean;
  block_height: number;
  timestamp: number;
  taker_fee?: number;
  taker_position_size_before?: string;
  taker_entry_quote_before?: string;
  taker_initial_margin_fraction_before?: number;
  taker_position_sign_changed?: boolean;
  maker_fee?: number;
  maker_position_size_before?: string;
  maker_entry_quote_before?: string;
  maker_initial_margin_fraction_before?: number;
  maker_position_sign_changed?: boolean;
  transaction_time: number;
}

/**
 * Lighter Position JSON structure
 */
export interface LighterPosition {
  market_id: number;
  symbol: string;
  initial_margin_fraction: string;
  open_order_count: number;
  pending_order_count: number;
  position_tied_order_count: number;
  sign: number; // 1 for long, -1 for short
  position: string; // Position size
  avg_entry_price: string;
  position_value: string;
  unrealized_pnl: string;
  realized_pnl: string;
  liquidation_price: string;
  total_funding_paid_out?: string;
  margin_mode: number;
  allocated_margin: string;
}

/**
 * Lighter Asset JSON structure
 */
export interface LighterAsset {
  symbol: string;
  asset_id: number;
  balance: string;
  locked_balance: string;
}

/**
 * Lighter PoolShares JSON structure
 */
export interface LighterPoolShares {
  public_pool_index: number;
  shares_amount: number;
  entry_usdc: string;
}

/**
 * Lighter Account Market Response
 */
export interface LighterAccountMarketResponse {
  account: number;
  channel: string;
  nonce: number;
  orders: Record<string, LighterOrder[]>; // market_index -> orders
  positions: Record<string, LighterPosition>; // market_index -> position
  trades: Record<string, LighterTrade[]>; // market_index -> trades
  assets: Record<string, LighterAsset>; // asset_index -> asset
  type: 'update/account_market';
}

/**
 * Lighter Account All Orders Response
 */
export interface LighterAccountAllOrdersResponse {
  account: number;
  channel: string;
  nonce: number;
  orders: Record<string, LighterOrder[]>; // market_index -> orders
  type: 'update/account_all_orders';
}

/**
 * Lighter Account Orders Response (single market)
 */
export interface LighterAccountOrdersResponse {
  account: number;
  channel: string;
  nonce: number;
  orders: Record<string, LighterOrder[]>; // market_index -> orders
  type: 'update/account_orders';
}

/**
 * Lighter Account All Trades Response
 */
export interface LighterAccountAllTradesResponse {
  channel: string;
  trades: Record<string, LighterTrade[]>; // market_index -> trades
  total_volume: number;
  monthly_volume: number;
  weekly_volume: number;
  daily_volume: number;
  type: 'update/account_all_trades';
}

/**
 * Lighter Account All Positions Response
 */
export interface LighterAccountAllPositionsResponse {
  channel: string;
  positions: Record<string, LighterPosition>; // market_index -> position
  shares: LighterPoolShares[];
  type: 'update/account_all_positions';
}

/**
 * Lighter Account All Assets Response
 */
export interface LighterAccountAllAssetsResponse {
  assets: Record<string, LighterAsset>; // asset_index -> asset
  channel: string;
  type: 'update/account_all_assets';
}

/**
 * Lighter Order Book Level
 */
export interface LighterOrderBookLevel {
  price: string;
  size: string;
}

/**
 * Lighter Order Book Response
 */
export interface LighterOrderBookResponse {
  channel: string;
  market_index: number;
  bids: LighterOrderBookLevel[];
  asks: LighterOrderBookLevel[];
  type: 'update/orderbook';
}

/**
 * Lighter Market Stats Response
 */
export interface LighterMarketStatsResponse {
  channel: string;
  market_stats: Record<string, {
    market_id: number;
    mid_price: string;
    last_trade_price: string;
    daily_base_token_volume: number;
    daily_quote_token_volume: number;
    daily_price_low: number;
    daily_price_high: number;
    daily_price_change: number;
  }>;
  type: 'update/market_stats';
}

/**
 * Lighter Trade Response
 */
export interface LighterTradeResponse {
  channel: string;
  trades: Record<string, LighterTrade[]>; // market_index -> trades
  type: 'update/trade';
}

/**
 * Lighter WebSocket Subscription Request
 */
export interface LighterWebSocketSubscription {
  type: 'subscribe';
  channel: string;
  auth?: string; // Auth token for account-specific channels
}

/**
 * Lighter WebSocket Send Transaction Request
 */
export interface LighterWebSocketSendTx {
  type: 'jsonapi/sendtx';
  data: {
    tx_type: number;
    tx_info: any; // Transaction info based on tx_type
  };
}

/**
 * Lighter WebSocket Send Batch Transaction Request
 */
export interface LighterWebSocketSendBatchTx {
  type: 'jsonapi/sendtxbatch';
  data: {
    tx_types: number[];
    tx_infos: any[]; // Transaction infos matching tx_types
  };
}

/**
 * Lighter Order Placement Request (internal)
 */
export interface LighterOrderRequest {
  marketIndex: number;
  side: 'buy' | 'sell';
  size: string; // Base amount as string
  price: string; // Price as string
  orderType: 'LIMIT' | 'MARKET';
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  reduceOnly?: boolean;
  clientOrderId?: string;
}

/**
 * Lighter Order Modification Request (internal)
 */
export interface LighterModifyOrderRequest {
  orderId: string;
  newPrice?: string;
  newSize?: string;
}

/**
 * Lighter Order Update event structure
 */
export interface LighterOrderUpdate {
  orderId: string;
  marketIndex: number;
  side: 'bid' | 'ask';
  status: 'filled' | 'partially_filled' | 'canceled' | 'open';
  size: string;
  filledSize: string;
  price: string;
}

