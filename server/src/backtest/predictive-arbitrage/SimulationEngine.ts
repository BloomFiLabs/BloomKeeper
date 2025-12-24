/**
 * SimulationEngine - Main backtest simulation loop
 * 
 * Iterates through historical data hour by hour:
 * 1. Update strategy state with new data
 * 2. Accrue funding payments to active positions
 * 3. Check for position exits
 * 4. Evaluate new entry signals
 * 5. Record equity curve
 */

import {
  BacktestConfig,
  BacktestFundingPoint,
  BacktestResults,
  StrategyMode,
  DailyReturn,
  SymbolPerformance,
  DEFAULT_BACKTEST_CONFIG,
} from './types';
import { BacktestDataLoader, LoadedBacktestData } from './BacktestDataLoader';
import { CostModel } from './CostModel';
import { PositionManager } from './PositionManager';
import { BacktestPredictionService } from './PredictionService';
import { createStrategy, IBacktestStrategy, PredictiveStrategy, HybridStrategy } from './Strategy';

/**
 * Simulation progress callback
 */
export type ProgressCallback = (percent: number, message: string) => void;

/**
 * SimulationEngine - Runs the backtest simulation
 */
export class SimulationEngine {
  private readonly config: BacktestConfig;
  private readonly costModel: CostModel;
  private readonly dataLoader: BacktestDataLoader;
  
  constructor(config: Partial<BacktestConfig> = {}, baseDir?: string) {
    this.config = { ...DEFAULT_BACKTEST_CONFIG, ...config };
    this.costModel = new CostModel(this.config);
    this.dataLoader = new BacktestDataLoader(baseDir);
  }
  
  /**
   * Run backtest simulation
   */
  async runBacktest(
    mode: StrategyMode,
    onProgress?: ProgressCallback,
  ): Promise<BacktestResults> {
    onProgress?.(0, 'Loading historical data...');
    
    // Load data
    const data = await this.dataLoader.loadData({
      symbolWhitelist: this.config.symbolWhitelist,
      symbolBlacklist: this.config.symbolBlacklist,
    });
    
    if (data.warnings.length > 0) {
      console.log(`Data warnings: ${data.warnings.length}`);
      for (const warn of data.warnings.slice(0, 5)) {
        console.log(`  - ${warn}`);
      }
    }
    
    onProgress?.(10, `Loaded ${data.symbols.length} symbols, ${data.totalDataPoints} data points`);
    
    // Initialize components
    const predictionService = new BacktestPredictionService();
    const strategy = createStrategy(mode, this.config, this.costModel, predictionService);
    const positionManager = new PositionManager(this.config, this.costModel);
    
    // Build unified timeline of all data points
    const timeline = this.buildTimeline(data);
    onProgress?.(15, `Built timeline with ${timeline.length} hourly snapshots`);
    
    // Warm up prediction service with initial data
    const warmupPeriod = Math.min(168, Math.floor(timeline.length * 0.1)); // 7 days or 10%
    for (let i = 0; i < warmupPeriod; i++) {
      const snapshot = timeline[i];
      for (const point of snapshot.points.values()) {
        strategy.updateState(point);
      }
    }
    onProgress?.(20, `Warmed up prediction model with ${warmupPeriod} hours of data`);
    
    // Run simulation
    for (let i = warmupPeriod; i < timeline.length; i++) {
      const snapshot = timeline[i];
      const timestamp = snapshot.timestamp;
      
      // 1. Update strategy state
      for (const point of snapshot.points.values()) {
        strategy.updateState(point);
      }
      
      // 2. Accrue funding to active positions
      for (const [symbol, point] of snapshot.points) {
        if (point.hyperliquidRate !== null && point.lighterRate !== null) {
          positionManager.accrueFunding(
            symbol,
            timestamp,
            point.hyperliquidRate,
            point.lighterRate,
          );
        }
      }
      
      // 3. Check for position exits
      for (const position of positionManager.getActivePositions()) {
        const point = snapshot.points.get(position.symbol);
        if (!point) continue;
        
        const { shouldClose, reason } = positionManager.shouldClosePosition(
          position.symbol,
          timestamp,
          point.spread ?? 0,
        );
        
        if (shouldClose && reason) {
          positionManager.closePosition(
            position.symbol,
            timestamp,
            point.spread ?? 0,
            reason,
            point.hyperliquidMarkPrice,
            point.lighterMarkPrice,
          );
        }
      }
      
      // 4. Evaluate new entry signals
      const signals = strategy.evaluateEntries(timestamp, snapshot.points, positionManager);
      
      for (const signal of signals) {
        if (!signal.shouldEnter) continue;
        
        const point = snapshot.points.get(signal.symbol);
        if (!point) continue;
        
        const leverage = strategy.calculateLeverage(signal.symbol);
        
        positionManager.openPosition(
          {
            symbol: signal.symbol,
            timestamp,
            currentSpread: signal.currentSpread,
            predictedSpread: signal.predictedSpread,
            confidence: signal.confidence,
            regime: signal.regime,
            hyperliquidRate: point.hyperliquidRate ?? 0,
            lighterRate: point.lighterRate ?? 0,
            hyperliquidMarkPrice: point.hyperliquidMarkPrice,
            lighterMarkPrice: point.lighterMarkPrice,
          },
          leverage,
        );
      }
      
      // 5. Record equity curve (every hour)
      positionManager.recordEquityPoint(timestamp);
      
      // Progress update every 5%
      if (i % Math.floor(timeline.length / 20) === 0) {
        const percent = 20 + Math.floor((i - warmupPeriod) / (timeline.length - warmupPeriod) * 75);
        onProgress?.(percent, `Processed ${i - warmupPeriod}/${timeline.length - warmupPeriod} hours...`);
      }
    }
    
    // Close remaining positions at end
    const lastSnapshot = timeline[timeline.length - 1];
    const lastTimestamp = lastSnapshot.timestamp;
    
    // Pass last prices for final P&L calculation
    const symbols = positionManager.getActivePositions().map(p => p.symbol);
    for (const symbol of symbols) {
      const point = lastSnapshot.points.get(symbol);
      positionManager.closePosition(
        symbol,
        lastTimestamp,
        point?.spread ?? 0,
        'end_of_backtest',
        point?.hyperliquidMarkPrice,
        point?.lighterMarkPrice,
      );
    }
    
    onProgress?.(95, 'Calculating metrics...');
    
    // Calculate results
    const results = this.calculateResults(
      mode,
      strategy,
      positionManager,
      data,
      warmupPeriod,
    );
    
    onProgress?.(100, 'Backtest complete!');
    
    return results;
  }
  
  /**
   * Build unified timeline from multi-symbol data
   */
  private buildTimeline(data: LoadedBacktestData): Array<{
    timestamp: Date;
    points: Map<string, BacktestFundingPoint>;
  }> {
    // Collect all unique timestamps
    const timestampSet = new Set<number>();
    
    for (const points of data.dataBySymbol.values()) {
      for (const point of points) {
        // Round to hour
        const hourTs = Math.floor(point.timestamp.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000);
        timestampSet.add(hourTs);
      }
    }
    
    // Sort timestamps
    const sortedTimestamps = Array.from(timestampSet).sort((a, b) => a - b);
    
    // Build timeline with all symbols at each timestamp
    const timeline: Array<{ timestamp: Date; points: Map<string, BacktestFundingPoint> }> = [];
    
    // Create index for each symbol's data
    const symbolIndices = new Map<string, number>();
    for (const symbol of data.symbols) {
      symbolIndices.set(symbol, 0);
    }
    
    for (const ts of sortedTimestamps) {
      const timestamp = new Date(ts);
      const points = new Map<string, BacktestFundingPoint>();
      
      for (const [symbol, symbolData] of data.dataBySymbol) {
        let idx = symbolIndices.get(symbol) || 0;
        
        // Find the point closest to this timestamp
        while (idx < symbolData.length - 1 && symbolData[idx + 1].timestamp.getTime() <= ts) {
          idx++;
        }
        
        if (idx < symbolData.length) {
          const point = symbolData[idx];
          // Only include if within 2 hours of target timestamp
          if (Math.abs(point.timestamp.getTime() - ts) <= 2 * 60 * 60 * 1000) {
            points.set(symbol, point);
          }
        }
        
        symbolIndices.set(symbol, idx);
      }
      
      if (points.size > 0) {
        timeline.push({ timestamp, points });
      }
    }
    
    return timeline;
  }
  
  /**
   * Calculate final backtest results
   */
  private calculateResults(
    mode: StrategyMode,
    strategy: IBacktestStrategy,
    positionManager: PositionManager,
    data: LoadedBacktestData,
    warmupPeriod: number,
  ): BacktestResults {
    const closedPositions = positionManager.getClosedPositions();
    const equityCurve = positionManager.getEquityCurve();
    
    // Calculate daily returns for Sharpe/Sortino
    const dailyReturns = this.calculateDailyReturns(equityCurve);
    
    // Calculate symbol performance
    const symbolPerformance = this.calculateSymbolPerformance(closedPositions);
    
    // Trade metrics
    const winningTrades = closedPositions.filter(p => (p.realizedPnL || 0) > 0);
    const losingTrades = closedPositions.filter(p => (p.realizedPnL || 0) <= 0);
    
    const totalPnL = closedPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
    const totalFundingPnL = closedPositions.reduce((sum, p) => sum + p.cumulativeFundingPnL, 0);
    const totalPricePnL = closedPositions.reduce((sum, p) => sum + p.cumulativePricePnL, 0);
    const totalTradingCosts = closedPositions.reduce(
      (sum, p) => sum + p.entryFees + p.exitFees + p.estimatedSlippage,
      0,
    );
    
    const avgWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, p) => sum + (p.realizedPnL || 0), 0) / winningTrades.length
      : 0;
    const avgLoss = losingTrades.length > 0
      ? Math.abs(losingTrades.reduce((sum, p) => sum + (p.realizedPnL || 0), 0) / losingTrades.length)
      : 0;
    
    const profitFactor = avgLoss > 0
      ? (winningTrades.reduce((sum, p) => sum + (p.realizedPnL || 0), 0)) /
        Math.abs(losingTrades.reduce((sum, p) => sum + (p.realizedPnL || 0), 0) || 1)
      : winningTrades.length > 0 ? Infinity : 0;
    
    // Time metrics
    const totalHours = (data.endDate.getTime() - data.startDate.getTime()) / (1000 * 60 * 60);
    const backtestedHours = totalHours - warmupPeriod;
    
    // APY calculation
    const finalCapital = positionManager.getCapital();
    const returnPercent = (finalCapital - this.config.initialCapital) / this.config.initialCapital;
    const annualizedReturn = (1 + returnPercent) ** (8760 / backtestedHours) - 1;
    const grossAPY = annualizedReturn * 100;
    
    // Net APY (accounting for costs)
    const netReturn = totalPnL / this.config.initialCapital;
    const netAnnualized = (1 + netReturn) ** (8760 / backtestedHours) - 1;
    const netAPY = netAnnualized * 100;
    
    // Risk metrics
    const sharpeRatio = this.calculateSharpeRatio(dailyReturns);
    const sortinoRatio = this.calculateSortinoRatio(dailyReturns);
    const maxDrawdown = positionManager.getMaxDrawdown();
    const calmarRatio = maxDrawdown > 0 ? netAPY / (maxDrawdown * 100) : 0;
    
    // Capacity metrics
    const avgPositionSize = closedPositions.length > 0
      ? closedPositions.reduce((sum, p) => sum + p.notionalSize, 0) / closedPositions.length
      : 0;
    const maxPositionSize = closedPositions.length > 0
      ? Math.max(...closedPositions.map(p => p.notionalSize))
      : 0;
    const avgLeverage = closedPositions.length > 0
      ? closedPositions.reduce((sum, p) => sum + p.leverage, 0) / closedPositions.length
      : this.config.defaultLeverage;
    
    // Estimate market share (assuming ~$50M typical OI for medium assets)
    const estimatedTotalOI = 50_000_000;
    const estimatedMarketSharePercent = (this.config.initialCapital / estimatedTotalOI) * 100;
    
    // Holding period
    const avgHoldingPeriodHours = closedPositions.length > 0
      ? closedPositions.reduce((sum, p) => {
          const holdingMs = (p.exitTimestamp?.getTime() || 0) - p.entryTimestamp.getTime();
          return sum + holdingMs / (1000 * 60 * 60);
        }, 0) / closedPositions.length
      : 0;
    
    // Prediction metrics (for predictive/hybrid strategies)
    let predictionAccuracy: number | undefined;
    let avgPredictionError: number | undefined;
    let directionAccuracy: number | undefined;
    
    if (mode === 'predictive' || mode === 'hybrid') {
      const predStrategy = strategy as PredictiveStrategy | HybridStrategy;
      if ('getPredictionMetrics' in predStrategy) {
        const metrics = predStrategy.getPredictionMetrics();
        predictionAccuracy = metrics.directionAccuracy * 100;
        avgPredictionError = metrics.mae;
        directionAccuracy = metrics.directionAccuracy * 100;
      }
    }
    
    return {
      config: this.config,
      strategyMode: mode,
      
      startDate: data.startDate,
      endDate: data.endDate,
      totalHours: backtestedHours,
      
      initialCapital: this.config.initialCapital,
      finalCapital,
      peakCapital: positionManager.getPeakCapital(),
      
      totalPnL,
      totalFundingPnL,
      totalPricePnL,
      totalTradingCosts,
      grossAPY,
      netAPY,
      
      maxDrawdown: maxDrawdown * this.config.initialCapital,
      maxDrawdownPercent: maxDrawdown * 100,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      
      totalTrades: closedPositions.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: closedPositions.length > 0 ? (winningTrades.length / closedPositions.length) * 100 : 0,
      avgTradeProfit: closedPositions.length > 0 ? totalPnL / closedPositions.length : 0,
      avgWin,
      avgLoss,
      profitFactor,
      avgHoldingPeriodHours,
      
      predictionAccuracy,
      avgPredictionError,
      directionAccuracy,
      
      avgPositionSize,
      maxPositionSize,
      avgLeverage,
      estimatedMarketSharePercent,
      
      positions: closedPositions,
      equityCurve,
      dailyReturns,
      symbolPerformance,
    };
  }
  
  /**
   * Calculate daily returns from equity curve
   */
  private calculateDailyReturns(equityCurve: Array<{ timestamp: Date; equity: number }>): DailyReturn[] {
    if (equityCurve.length === 0) return [];
    
    const dailyReturns: DailyReturn[] = [];
    const byDay = new Map<string, { start: number; end: number }>();
    
    for (const point of equityCurve) {
      const day = point.timestamp.toISOString().split('T')[0];
      const existing = byDay.get(day);
      
      if (!existing) {
        byDay.set(day, { start: point.equity, end: point.equity });
      } else {
        existing.end = point.equity;
      }
    }
    
    let prevEnd = this.config.initialCapital;
    for (const [date, { start, end }] of byDay) {
      const dailyReturn = end - prevEnd;
      const returnPercent = prevEnd > 0 ? (dailyReturn / prevEnd) * 100 : 0;
      
      dailyReturns.push({
        date,
        return: dailyReturn,
        returnPercent,
      });
      
      prevEnd = end;
    }
    
    return dailyReturns;
  }
  
  /**
   * Calculate Sharpe ratio (annualized)
   */
  private calculateSharpeRatio(dailyReturns: DailyReturn[]): number {
    if (dailyReturns.length < 7) return 0;
    
    const returns = dailyReturns.map(d => d.returnPercent);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev === 0) return 0;
    
    // Annualize: multiply by sqrt(365)
    return (mean / stdDev) * Math.sqrt(365);
  }
  
  /**
   * Calculate Sortino ratio (only penalizes downside volatility)
   */
  private calculateSortinoRatio(dailyReturns: DailyReturn[]): number {
    if (dailyReturns.length < 7) return 0;
    
    const returns = dailyReturns.map(d => d.returnPercent);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    
    const negativeReturns = returns.filter(r => r < 0);
    if (negativeReturns.length === 0) return mean > 0 ? Infinity : 0;
    
    const downsideVariance = negativeReturns.reduce((a, b) => a + b ** 2, 0) / negativeReturns.length;
    const downsideStdDev = Math.sqrt(downsideVariance);
    
    if (downsideStdDev === 0) return 0;
    
    // Annualize
    return (mean / downsideStdDev) * Math.sqrt(365);
  }
  
  /**
   * Calculate per-symbol performance
   */
  private calculateSymbolPerformance(
    positions: Array<{
      symbol: string;
      realizedPnL?: number;
      cumulativeFundingPnL: number;
      entryFees: number;
      exitFees: number;
      estimatedSlippage: number;
      entryTimestamp: Date;
      exitTimestamp?: Date;
      entrySpread: number;
    }>,
  ): Map<string, SymbolPerformance> {
    const bySymbol = new Map<string, typeof positions>();
    
    for (const pos of positions) {
      const existing = bySymbol.get(pos.symbol) || [];
      existing.push(pos);
      bySymbol.set(pos.symbol, existing);
    }
    
    const result = new Map<string, SymbolPerformance>();
    
    for (const [symbol, symbolPositions] of bySymbol) {
      const totalPnL = symbolPositions.reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
      const wins = symbolPositions.filter(p => (p.realizedPnL || 0) > 0).length;
      const fundingReceived = symbolPositions.reduce((sum, p) => sum + p.cumulativeFundingPnL, 0);
      const tradingCosts = symbolPositions.reduce(
        (sum, p) => sum + p.entryFees + p.exitFees + p.estimatedSlippage,
        0,
      );
      const avgSpread = symbolPositions.reduce((sum, p) => sum + Math.abs(p.entrySpread), 0) / symbolPositions.length;
      const avgHoldingHours = symbolPositions.reduce((sum, p) => {
        const holdingMs = (p.exitTimestamp?.getTime() || 0) - p.entryTimestamp.getTime();
        return sum + holdingMs / (1000 * 60 * 60);
      }, 0) / symbolPositions.length;
      
      result.set(symbol, {
        symbol,
        totalTrades: symbolPositions.length,
        totalPnL,
        winRate: symbolPositions.length > 0 ? (wins / symbolPositions.length) * 100 : 0,
        avgSpread,
        avgHoldingHours,
        fundingReceived,
        tradingCosts,
      });
    }
    
    return result;
  }
  
  /**
   * Get data summary
   */
  async getDataSummary(): Promise<ReturnType<BacktestDataLoader['getSummaryStats']>> {
    const data = await this.dataLoader.loadData({
      symbolWhitelist: this.config.symbolWhitelist,
      symbolBlacklist: this.config.symbolBlacklist,
    });
    return this.dataLoader.getSummaryStats(data);
  }
}

