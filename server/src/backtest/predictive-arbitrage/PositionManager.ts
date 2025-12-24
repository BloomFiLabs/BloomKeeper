/**
 * PositionManager - Tracks concurrent positions, P&L, margin, and funding accrual
 */

import { v4 as uuidv4 } from 'uuid';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { MarketRegime } from '../../domain/ports/IFundingRatePredictor';
import {
  BacktestPosition,
  BacktestConfig,
  BacktestFundingPoint,
  FundingPayment,
  EquityPoint,
} from './types';
import { CostModel, TradeCosts } from './CostModel';

/**
 * Position entry request
 */
export interface PositionEntryRequest {
  symbol: string;
  timestamp: Date;
  currentSpread: number;
  predictedSpread?: number;
  confidence?: number;
  regime?: MarketRegime;
  hyperliquidRate: number;
  lighterRate: number;
  hyperliquidMarkPrice?: number;
  lighterMarkPrice?: number;
}

/**
 * Position state summary
 */
export interface PositionSummary {
  activePositions: number;
  totalNotional: number;
  totalMarginUsed: number;
  unrealizedPnL: number;
  cumulativeFundingPnL: number;
  positionsBySymbol: Map<string, BacktestPosition>;
}

/**
 * PositionManager - Manages backtest positions
 */
export class PositionManager {
  private readonly config: BacktestConfig;
  private readonly costModel: CostModel;
  
  // State
  private positions: Map<string, BacktestPosition> = new Map(); // id -> position
  private positionsBySymbol: Map<string, string> = new Map(); // symbol -> positionId
  private closedPositions: BacktestPosition[] = [];
  
  private capital: number;
  private peakCapital: number;
  private currentDrawdown: number = 0;
  private maxDrawdown: number = 0;
  
  private equityCurve: EquityPoint[] = [];
  
  constructor(config: BacktestConfig, costModel: CostModel) {
    this.config = config;
    this.costModel = costModel;
    this.capital = config.initialCapital;
    this.peakCapital = config.initialCapital;
  }
  
  /**
   * Get current capital
   */
  getCapital(): number {
    return this.capital;
  }
  
  /**
   * Get current equity (capital + unrealized P&L)
   */
  getEquity(): number {
    let unrealizedPnL = 0;
    for (const position of this.positions.values()) {
      unrealizedPnL += position.cumulativeFundingPnL;
    }
    return this.capital + unrealizedPnL;
  }
  
  /**
   * Get active position count
   */
  getActivePositionCount(): number {
    return this.positions.size;
  }
  
  /**
   * Check if can open a new position
   */
  canOpenPosition(symbol: string): boolean {
    // Check max concurrent positions
    if (this.positions.size >= this.config.maxConcurrentPositions) {
      return false;
    }
    
    // Check if symbol already has a position
    if (this.positionsBySymbol.has(symbol)) {
      return false;
    }
    
    // Check available margin
    const availableMargin = this.getAvailableMargin();
    const minPositionSize = this.config.maxPositionSizeUsd * 0.1; // 10% of max as minimum
    if (availableMargin < minPositionSize) {
      return false;
    }
    
    // Check drawdown limit
    if (this.currentDrawdown >= this.config.maxDrawdownPercent) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Get available margin for new positions
   */
  getAvailableMargin(): number {
    const totalMarginUsed = this.getTotalMarginUsed();
    const maxMargin = this.capital * this.config.balanceUsagePercent;
    return Math.max(0, maxMargin - totalMarginUsed);
  }
  
  /**
   * Get total margin used by active positions
   */
  getTotalMarginUsed(): number {
    let totalMargin = 0;
    for (const position of this.positions.values()) {
      totalMargin += position.notionalSize / position.leverage;
    }
    return totalMargin;
  }
  
  /**
   * Calculate position size for a new trade
   */
  calculatePositionSize(leverage: number): number {
    const availableMargin = this.getAvailableMargin();
    
    // Size based on available margin
    const sizeByMargin = availableMargin * leverage;
    
    // Cap at max position size
    const sizeByConfig = this.config.maxPositionSizeUsd;
    
    // Use smaller of the two
    return Math.min(sizeByMargin, sizeByConfig);
  }
  
  /**
   * Open a new position
   */
  openPosition(request: PositionEntryRequest, leverage: number): BacktestPosition | null {
    if (!this.canOpenPosition(request.symbol)) {
      return null;
    }
    
    const notionalSize = this.calculatePositionSize(leverage);
    if (notionalSize < 100) { // Minimum $100 position
      return null;
    }
    
    // Determine direction: short high rate, long low rate
    const shortExchange = request.hyperliquidRate > request.lighterRate
      ? ExchangeType.HYPERLIQUID
      : ExchangeType.LIGHTER;
    const longExchange = shortExchange === ExchangeType.HYPERLIQUID
      ? ExchangeType.LIGHTER
      : ExchangeType.HYPERLIQUID;
    
    // Set entry prices
    const entryPriceShort = shortExchange === ExchangeType.HYPERLIQUID 
      ? request.hyperliquidMarkPrice 
      : request.lighterMarkPrice;
    const entryPriceLong = longExchange === ExchangeType.HYPERLIQUID 
      ? request.hyperliquidMarkPrice 
      : request.lighterMarkPrice;
    
    // Calculate entry costs
    const basisBps = this.calculateBasisDivergence(
      request.hyperliquidMarkPrice,
      request.lighterMarkPrice,
    );
    const entryCosts = this.costModel.calculateEntryCosts(
      notionalSize,
      1000000, // Assume decent liquidity for backtest
      500000,
      basisBps,
    );
    
    // Deduct entry costs from capital
    this.capital -= entryCosts.totalCost;
    
    const position: BacktestPosition = {
      id: uuidv4(),
      symbol: request.symbol,
      entryTimestamp: request.timestamp,
      shortExchange,
      longExchange,
      notionalSize,
      leverage,
      entrySpread: request.currentSpread,
      entryPriceShort,
      entryPriceLong,
      predictedSpread: request.predictedSpread,
      entryConfidence: request.confidence,
      entryRegime: request.regime,
      entryFees: entryCosts.totalFees,
      exitFees: 0, // Will be calculated on close
      estimatedSlippage: entryCosts.totalSlippage,
      cumulativeFundingPnL: 0,
      cumulativePricePnL: 0,
      fundingPayments: [],
    };
    
    this.positions.set(position.id, position);
    this.positionsBySymbol.set(request.symbol, position.id);
    
    return position;
  }
  
  /**
   * Accrue funding payment to a position
   */
  accrueFunding(
    symbol: string,
    timestamp: Date,
    hyperliquidRate: number,
    lighterRate: number,
  ): FundingPayment | null {
    const positionId = this.positionsBySymbol.get(symbol);
    if (!positionId) return null;
    
    const position = this.positions.get(positionId);
    if (!position) return null;
    
    // Calculate funding payment
    // Short position: receive funding if rate > 0, pay if rate < 0
    // Long position: pay funding if rate > 0, receive if rate < 0
    
    const shortRate = position.shortExchange === ExchangeType.HYPERLIQUID
      ? hyperliquidRate
      : lighterRate;
    const longRate = position.longExchange === ExchangeType.HYPERLIQUID
      ? hyperliquidRate
      : lighterRate;
    
    // Short side: positive rate = we receive, negative rate = we pay
    const shortPayment = position.notionalSize * shortRate;
    // Long side: positive rate = we pay, negative rate = we receive
    const longPayment = -position.notionalSize * longRate;
    
    const netPayment = shortPayment + longPayment;
    
    const fundingPayment: FundingPayment = {
      timestamp,
      shortExchangePayment: shortPayment,
      longExchangePayment: longPayment,
      netPayment,
    };
    
    position.fundingPayments.push(fundingPayment);
    position.cumulativeFundingPnL += netPayment;
    
    // Add to capital immediately (funding is realized)
    this.capital += netPayment;
    
    return fundingPayment;
  }
  
  /**
   * Close a position
   */
  closePosition(
    symbol: string,
    timestamp: Date,
    exitSpread: number,
    exitReason: BacktestPosition['exitReason'],
    hyperliquidPrice?: number,
    lighterPrice?: number,
  ): BacktestPosition | null {
    const positionId = this.positionsBySymbol.get(symbol);
    if (!positionId) return null;
    
    const position = this.positions.get(positionId);
    if (!position) return null;
    
    // Calculate exit costs
    const exitCosts = this.costModel.calculateExitCosts(position.notionalSize);
    
    position.exitTimestamp = timestamp;
    position.exitSpread = exitSpread;
    position.exitReason = exitReason;
    position.exitFees = exitCosts.totalFees;
    
    // Calculate price P&L (basis convergence)
    if (hyperliquidPrice && lighterPrice && position.entryPriceShort && position.entryPriceLong) {
      const exitPriceShort = position.shortExchange === ExchangeType.HYPERLIQUID ? hyperliquidPrice : lighterPrice;
      const exitPriceLong = position.longExchange === ExchangeType.HYPERLIQUID ? hyperliquidPrice : lighterPrice;
      
      position.exitPriceShort = exitPriceShort;
      position.exitPriceLong = exitPriceLong;
      
      // P&L = Notional * (LongExit/LongEntry - 1) - Notional * (ShortExit/ShortEntry - 1)
      const longReturn = (exitPriceLong / position.entryPriceLong) - 1;
      const shortReturn = (exitPriceShort / position.entryPriceShort) - 1;
      position.cumulativePricePnL = position.notionalSize * (longReturn - shortReturn);
      
      // Add price P&L to capital
      this.capital += position.cumulativePricePnL;
    }
    
    // Realized P&L = funding P&L + price P&L - entry costs - exit costs
    const totalCosts = position.entryFees + position.estimatedSlippage + position.exitFees + exitCosts.totalSlippage;
    position.realizedPnL = position.cumulativeFundingPnL + position.cumulativePricePnL - totalCosts;
    
    // Deduct exit costs from capital
    this.capital -= exitCosts.totalCost;
    
    // Move to closed positions
    this.positions.delete(positionId);
    this.positionsBySymbol.delete(symbol);
    this.closedPositions.push(position);
    
    return position;
  }
  
  /**
   * Check if position should be closed (stop loss, max duration, etc.)
   */
  shouldClosePosition(
    symbol: string,
    currentTimestamp: Date,
    currentSpread: number,
  ): { shouldClose: boolean; reason: BacktestPosition['exitReason'] } {
    const positionId = this.positionsBySymbol.get(symbol);
    if (!positionId) return { shouldClose: false, reason: undefined };
    
    const position = this.positions.get(positionId);
    if (!position) return { shouldClose: false, reason: undefined };
    
    // Check max duration
    const hoursHeld = (currentTimestamp.getTime() - position.entryTimestamp.getTime()) / (1000 * 60 * 60);
    if (hoursHeld >= this.config.maxPositionDurationHours) {
      return { shouldClose: true, reason: 'max_duration' };
    }
    
    // Check stop loss (position P&L as % of margin)
    const margin = position.notionalSize / position.leverage;
    const pnlPercent = (position.cumulativeFundingPnL - position.entryFees - position.estimatedSlippage) / margin;
    if (pnlPercent <= -this.config.positionStopLossPercent) {
      return { shouldClose: true, reason: 'stop_loss' };
    }
    
    // Check if spread has flipped significantly against us
    // If we were short HL/long Lighter and HL rate drops below Lighter, spread flipped
    const spreadFlipped = (position.entrySpread > 0 && currentSpread < -0.00005) ||
                          (position.entrySpread < 0 && currentSpread > 0.00005);
    if (spreadFlipped) {
      return { shouldClose: true, reason: 'spread_flip' };
    }
    
    return { shouldClose: false, reason: undefined };
  }
  
  /**
   * Update equity curve
   */
  recordEquityPoint(timestamp: Date): void {
    const equity = this.getEquity();
    
    // Update peak and drawdown
    if (equity > this.peakCapital) {
      this.peakCapital = equity;
    }
    
    this.currentDrawdown = (this.peakCapital - equity) / this.peakCapital;
    if (this.currentDrawdown > this.maxDrawdown) {
      this.maxDrawdown = this.currentDrawdown;
    }
    
    this.equityCurve.push({
      timestamp,
      equity,
      drawdown: this.peakCapital - equity,
      drawdownPercent: this.currentDrawdown,
      activePositions: this.positions.size,
    });
  }
  
  /**
   * Get all closed positions
   */
  getClosedPositions(): BacktestPosition[] {
    return [...this.closedPositions];
  }
  
  /**
   * Get active positions
   */
  getActivePositions(): BacktestPosition[] {
    return Array.from(this.positions.values());
  }
  
  /**
   * Get equity curve
   */
  getEquityCurve(): EquityPoint[] {
    return [...this.equityCurve];
  }
  
  /**
   * Get max drawdown
   */
  getMaxDrawdown(): number {
    return this.maxDrawdown;
  }
  
  /**
   * Get peak capital
   */
  getPeakCapital(): number {
    return this.peakCapital;
  }
  
  /**
   * Get position summary
   */
  getSummary(): PositionSummary {
    let totalNotional = 0;
    let totalMarginUsed = 0;
    let unrealizedPnL = 0;
    let cumulativeFundingPnL = 0;
    
    const positionsBySymbol = new Map<string, BacktestPosition>();
    
    for (const position of this.positions.values()) {
      totalNotional += position.notionalSize;
      totalMarginUsed += position.notionalSize / position.leverage;
      // Unrealized P&L includes both funding and price P&L (implied by current prices, but simplified here to cumulative so far)
      unrealizedPnL += position.cumulativeFundingPnL + position.cumulativePricePnL - position.entryFees - position.estimatedSlippage;
      cumulativeFundingPnL += position.cumulativeFundingPnL;
      positionsBySymbol.set(position.symbol, position);
    }
    
    return {
      activePositions: this.positions.size,
      totalNotional,
      totalMarginUsed,
      unrealizedPnL,
      cumulativeFundingPnL,
      positionsBySymbol,
    };
  }
  
  /**
   * Calculate basis divergence in bps
   */
  private calculateBasisDivergence(
    hyperliquidPrice?: number,
    lighterPrice?: number,
  ): number {
    if (!hyperliquidPrice || !lighterPrice) return 0;
    const avgPrice = (hyperliquidPrice + lighterPrice) / 2;
    if (avgPrice === 0) return 0;
    return ((hyperliquidPrice - lighterPrice) / avgPrice) * 10000;
  }
}

