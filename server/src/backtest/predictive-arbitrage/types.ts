/**
 * Types for Predictive Funding Rate Arbitrage Backtester
 */

import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { MarketRegime } from '../../domain/ports/IFundingRatePredictor';

/**
 * Historical funding rate data point for backtest
 */
export interface BacktestFundingPoint {
  symbol: string;
  timestamp: Date;
  hyperliquidRate: number | null;
  lighterRate: number | null;
  spread: number | null; // lighterRate - hyperliquidRate (or vice versa based on direction)
  hyperliquidMarkPrice?: number;
  lighterMarkPrice?: number;
}

/**
 * Position tracking
 */
export interface BacktestPosition {
  id: string;
  symbol: string;
  entryTimestamp: Date;
  exitTimestamp?: Date;
  
  // Position details
  shortExchange: ExchangeType;
  longExchange: ExchangeType;
  notionalSize: number; // USD
  leverage: number;
  
  // Entry metrics
  entrySpread: number;
  entryPriceShort?: number;
  entryPriceLong?: number;
  predictedSpread?: number;
  entryConfidence?: number;
  entryRegime?: MarketRegime;
  
  // Costs
  entryFees: number;
  exitFees: number;
  estimatedSlippage: number;
  
  // P&L tracking
  cumulativeFundingPnL: number;
  cumulativePricePnL: number;
  fundingPayments: FundingPayment[];
  realizedPnL?: number;
  
  // Exit metrics
  exitSpread?: number;
  exitPriceShort?: number;
  exitPriceLong?: number;
  exitReason?: 'spread_flip' | 'stop_loss' | 'take_profit' | 'max_duration' | 'end_of_backtest';
}

/**
 * Individual funding payment
 */
export interface FundingPayment {
  timestamp: Date;
  shortExchangePayment: number; // positive = received
  longExchangePayment: number;  // negative = paid
  netPayment: number;
}

/**
 * Backtest configuration
 */
export interface BacktestConfig {
  // Capital
  initialCapital: number;
  maxPositionSizeUsd: number;
  balanceUsagePercent: number;
  maxConcurrentPositions: number;
  
  // Strategy parameters
  minSpreadThreshold: number;     // Minimum spread to enter (reactive)
  predictedSpreadThreshold: number; // Minimum predicted spread to enter (predictive)
  predictionConfidenceThreshold: number;
  maxBreakEvenHours: number;
  
  // Leverage
  useDynamicLeverage: boolean;
  defaultLeverage: number;
  maxLeverage: number;
  kFactor: number; // For sigma-distance model
  
  // Risk management
  maxDrawdownPercent: number;
  positionStopLossPercent: number;
  maxPositionDurationHours: number;
  
  // Fees (in decimal, e.g., 0.0002 = 0.02%)
  hyperliquidMakerFee: number;
  hyperliquidTakerFee: number;
  lighterMakerFee: number;
  lighterTakerFee: number;
  
  // Slippage model
  baseSlippagePercent: number;
  sqrtImpactFactor: number;
  
  // Symbols to include (empty = all)
  symbolWhitelist: string[];
  symbolBlacklist: string[];
}

/**
 * Strategy mode for comparison
 */
export type StrategyMode = 'reactive' | 'predictive' | 'hybrid';

/**
 * Backtest results
 */
export interface BacktestResults {
  config: BacktestConfig;
  strategyMode: StrategyMode;
  
  // Time period
  startDate: Date;
  endDate: Date;
  totalHours: number;
  
  // Capital metrics
  initialCapital: number;
  finalCapital: number;
  peakCapital: number;
  
  // Performance metrics
  totalPnL: number;
  totalFundingPnL: number;
  totalPricePnL: number;
  totalTradingCosts: number;
  grossAPY: number;
  netAPY: number;
  
  // Risk metrics
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  
  // Trade metrics
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgTradeProfit: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  avgHoldingPeriodHours: number;
  
  // Prediction metrics (for predictive mode)
  predictionAccuracy?: number;
  avgPredictionError?: number;
  directionAccuracy?: number;
  
  // Capacity metrics
  avgPositionSize: number;
  maxPositionSize: number;
  avgLeverage: number;
  estimatedMarketSharePercent: number;
  
  // Detailed data
  positions: BacktestPosition[];
  equityCurve: EquityPoint[];
  dailyReturns: DailyReturn[];
  
  // Symbol breakdown
  symbolPerformance: Map<string, SymbolPerformance>;
}

/**
 * Equity curve point
 */
export interface EquityPoint {
  timestamp: Date;
  equity: number;
  drawdown: number;
  drawdownPercent: number;
  activePositions: number;
}

/**
 * Daily return for Sharpe calculation
 */
export interface DailyReturn {
  date: string;
  return: number;
  returnPercent: number;
}

/**
 * Per-symbol performance breakdown
 */
export interface SymbolPerformance {
  symbol: string;
  totalTrades: number;
  totalPnL: number;
  winRate: number;
  avgSpread: number;
  avgHoldingHours: number;
  fundingReceived: number;
  tradingCosts: number;
}

/**
 * Default backtest configuration
 */
export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  // Capital - targeting $200k
  initialCapital: 200000,
  maxPositionSizeUsd: 50000, // Max $50k per position
  balanceUsagePercent: 0.9,
  maxConcurrentPositions: 10,
  
  // Strategy parameters
  minSpreadThreshold: 0.00005,      // 0.5 bps minimum spread
  predictedSpreadThreshold: 0.0001, // 1.0 bps predicted spread to enter
  predictionConfidenceThreshold: 0.6,
  maxBreakEvenHours: 168, // 7 days
  
  // Leverage
  useDynamicLeverage: true,
  defaultLeverage: 2.0,
  maxLeverage: 5.0,
  kFactor: 5.0,
  
  // Risk management
  maxDrawdownPercent: 0.15, // 15% max drawdown
  positionStopLossPercent: 0.05, // 5% position stop loss
  maxPositionDurationHours: 336, // 14 days max
  
  // Fees (Hyperliquid/Lighter typical rates)
  hyperliquidMakerFee: 0.0002,  // 0.02%
  hyperliquidTakerFee: 0.0005,  // 0.05%
  lighterMakerFee: 0.0002,      // 0.02%
  lighterTakerFee: 0.0005,      // 0.05%
  
  // Slippage model
  baseSlippagePercent: 0.0001,  // 0.01% base
  sqrtImpactFactor: 0.005,      // 0.5% impact at 100% liquidity usage
  
  // Symbols
  symbolWhitelist: [],
  symbolBlacklist: ['NVDA'], // Known problematic
};

