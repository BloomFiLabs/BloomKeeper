/**
 * Strategy - Implements reactive, predictive, and hybrid strategy modes
 */

import { BacktestConfig, BacktestFundingPoint, StrategyMode } from './types';
import { BacktestPrediction, BacktestPredictionService } from './PredictionService';
import { PositionManager, PositionEntryRequest } from './PositionManager';
import { CostModel } from './CostModel';
import { MarketRegime } from '../../domain/ports/IFundingRatePredictor';

/**
 * Entry signal from strategy
 */
export interface EntrySignal {
  symbol: string;
  shouldEnter: boolean;
  reason: string;
  currentSpread: number;
  predictedSpread?: number;
  confidence?: number;
  regime?: MarketRegime;
  expectedBreakEvenHours?: number;
}

/**
 * Strategy interface
 */
export interface IBacktestStrategy {
  readonly mode: StrategyMode;
  
  /**
   * Evaluate entry signals for all symbols at current timestamp
   */
  evaluateEntries(
    timestamp: Date,
    dataPoints: Map<string, BacktestFundingPoint>,
    positionManager: PositionManager,
  ): EntrySignal[];
  
  /**
   * Update strategy with new data (for prediction models)
   */
  updateState(point: BacktestFundingPoint): void;
  
  /**
   * Get leverage for a symbol based on volatility
   */
  calculateLeverage(symbol: string): number;
}

/**
 * Reactive Strategy - Enter when current spread exceeds threshold
 * 
 * This is the baseline strategy that only uses current market data.
 */
export class ReactiveStrategy implements IBacktestStrategy {
  readonly mode: StrategyMode = 'reactive';
  
  private readonly config: BacktestConfig;
  private readonly costModel: CostModel;
  private readonly volatilityCache: Map<string, number[]> = new Map();
  
  constructor(config: BacktestConfig, costModel: CostModel) {
    this.config = config;
    this.costModel = costModel;
  }
  
  evaluateEntries(
    timestamp: Date,
    dataPoints: Map<string, BacktestFundingPoint>,
    positionManager: PositionManager,
  ): EntrySignal[] {
    const signals: EntrySignal[] = [];
    
    for (const [symbol, point] of dataPoints) {
      if (point.spread === null) continue;
      
      // Check if we already have a position
      if (!positionManager.canOpenPosition(symbol)) {
        continue;
      }
      
      const absSpread = Math.abs(point.spread);
      
      // Reactive: only enter if current spread exceeds threshold
      if (absSpread >= this.config.minSpreadThreshold) {
        // Calculate expected break-even
        const leverage = this.calculateLeverage(symbol);
        const positionSize = positionManager.calculatePositionSize(leverage);
        const entryCosts = this.costModel.calculateEntryCosts(positionSize);
        const exitCosts = this.costModel.calculateExitCosts(positionSize);
        const hourlyReturn = positionSize * absSpread;
        const breakEvenHours = hourlyReturn > 0 
          ? (entryCosts.totalCost + exitCosts.totalCost) / hourlyReturn
          : Infinity;
        
        // Only enter if break-even is within acceptable range
        if (breakEvenHours <= this.config.maxBreakEvenHours) {
          signals.push({
            symbol,
            shouldEnter: true,
            reason: `Spread ${(absSpread * 100).toFixed(4)}% exceeds threshold`,
            currentSpread: point.spread,
            expectedBreakEvenHours: breakEvenHours,
          });
        }
      }
    }
    
    // Sort by spread magnitude (best opportunities first)
    signals.sort((a, b) => Math.abs(b.currentSpread) - Math.abs(a.currentSpread));
    
    return signals;
  }
  
  updateState(point: BacktestFundingPoint): void {
    // Track volatility for leverage calculation
    const history = this.volatilityCache.get(point.symbol) || [];
    if (point.spread !== null) {
      history.push(point.spread);
      // Keep last 168 hours (7 days)
      if (history.length > 168) {
        history.shift();
      }
      this.volatilityCache.set(point.symbol, history);
    }
  }
  
  calculateLeverage(symbol: string): number {
    if (!this.config.useDynamicLeverage) {
      return this.config.defaultLeverage;
    }
    
    const history = this.volatilityCache.get(symbol);
    if (!history || history.length < 24) {
      return this.config.defaultLeverage;
    }
    
    // Calculate daily volatility from spread changes
    const changes: number[] = [];
    for (let i = 1; i < history.length; i++) {
      changes.push(history[i] - history[i - 1]);
    }
    
    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
    const hourlyVol = Math.sqrt(variance);
    const dailyVol = hourlyVol * Math.sqrt(24);
    
    // Sigma-distance model: L = 1 / (K * σ_daily)
    const leverage = 1 / (this.config.kFactor * dailyVol);
    
    return Math.max(this.config.defaultLeverage, Math.min(this.config.maxLeverage, leverage));
  }
}

/**
 * Predictive Strategy - Enter when predicted spread exceeds threshold
 * 
 * Uses prediction model to enter positions before spreads materialize.
 */
export class PredictiveStrategy implements IBacktestStrategy {
  readonly mode: StrategyMode = 'predictive';
  
  private readonly config: BacktestConfig;
  private readonly costModel: CostModel;
  private readonly predictionService: BacktestPredictionService;
  private readonly volatilityCache: Map<string, number[]> = new Map();
  
  // Track prediction accuracy
  private predictions: Map<string, { predicted: number; timestamp: Date }> = new Map();
  private predictionErrors: number[] = [];
  private directionMatches: number = 0;
  private totalPredictions: number = 0;
  
  constructor(
    config: BacktestConfig,
    costModel: CostModel,
    predictionService: BacktestPredictionService,
  ) {
    this.config = config;
    this.costModel = costModel;
    this.predictionService = predictionService;
  }
  
  evaluateEntries(
    timestamp: Date,
    dataPoints: Map<string, BacktestFundingPoint>,
    positionManager: PositionManager,
  ): EntrySignal[] {
    const signals: EntrySignal[] = [];
    
    for (const [symbol, point] of dataPoints) {
      if (point.spread === null) continue;
      
      // Track prediction accuracy
      this.trackPredictionAccuracy(symbol, point);
      
      // Check if we already have a position
      if (!positionManager.canOpenPosition(symbol)) {
        continue;
      }
      
      // Get prediction
      const prediction = this.predictionService.predict(symbol, point);
      if (!prediction) continue;
      
      const absPredictedSpread = Math.abs(prediction.predictedSpread);
      const absCurrentSpread = Math.abs(point.spread);
      
      // Predictive: enter if PREDICTED spread exceeds threshold
      // even if current spread is below threshold
      if (absPredictedSpread >= this.config.predictedSpreadThreshold &&
          prediction.confidence >= this.config.predictionConfidenceThreshold) {
        
        // Store prediction for accuracy tracking
        this.predictions.set(symbol, {
          predicted: prediction.predictedSpread,
          timestamp: new Date(timestamp.getTime() + 60 * 60 * 1000), // 1 hour forward
        });
        
        // Calculate expected break-even based on predicted spread
        const leverage = this.calculateLeverage(symbol);
        const positionSize = positionManager.calculatePositionSize(leverage);
        const entryCosts = this.costModel.calculateEntryCosts(positionSize);
        const exitCosts = this.costModel.calculateExitCosts(positionSize);
        const hourlyReturn = positionSize * absPredictedSpread;
        const breakEvenHours = hourlyReturn > 0 
          ? (entryCosts.totalCost + exitCosts.totalCost) / hourlyReturn
          : Infinity;
        
        if (breakEvenHours <= this.config.maxBreakEvenHours) {
          signals.push({
            symbol,
            shouldEnter: true,
            reason: `Predicted spread ${(absPredictedSpread * 100).toFixed(4)}% (conf: ${(prediction.confidence * 100).toFixed(0)}%)`,
            currentSpread: point.spread,
            predictedSpread: prediction.predictedSpread,
            confidence: prediction.confidence,
            regime: prediction.regime,
            expectedBreakEvenHours: breakEvenHours,
          });
        }
      }
    }
    
    // Sort by confidence * predicted spread (best opportunities first)
    signals.sort((a, b) => {
      const scoreA = (a.confidence || 0.5) * Math.abs(a.predictedSpread || a.currentSpread);
      const scoreB = (b.confidence || 0.5) * Math.abs(b.predictedSpread || b.currentSpread);
      return scoreB - scoreA;
    });
    
    return signals;
  }
  
  updateState(point: BacktestFundingPoint): void {
    // Update prediction service
    this.predictionService.updateHistory(point);
    
    // Track volatility for leverage calculation
    const history = this.volatilityCache.get(point.symbol) || [];
    if (point.spread !== null) {
      history.push(point.spread);
      if (history.length > 168) {
        history.shift();
      }
      this.volatilityCache.set(point.symbol, history);
    }
  }
  
  calculateLeverage(symbol: string): number {
    if (!this.config.useDynamicLeverage) {
      return this.config.defaultLeverage;
    }
    
    const history = this.volatilityCache.get(symbol);
    if (!history || history.length < 24) {
      return this.config.defaultLeverage;
    }
    
    const changes: number[] = [];
    for (let i = 1; i < history.length; i++) {
      changes.push(history[i] - history[i - 1]);
    }
    
    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
    const hourlyVol = Math.sqrt(variance);
    const dailyVol = hourlyVol * Math.sqrt(24);
    
    const leverage = 1 / (this.config.kFactor * dailyVol);
    
    return Math.max(this.config.defaultLeverage, Math.min(this.config.maxLeverage, leverage));
  }
  
  /**
   * Track prediction accuracy
   */
  private trackPredictionAccuracy(symbol: string, point: BacktestFundingPoint): void {
    const pastPrediction = this.predictions.get(symbol);
    if (!pastPrediction) return;
    
    // Check if this point is the prediction target
    if (point.timestamp >= pastPrediction.timestamp) {
      const actual = point.spread ?? 0;
      const predicted = pastPrediction.predicted;
      
      const error = Math.abs(predicted - actual);
      this.predictionErrors.push(error);
      
      // Direction match
      if (Math.sign(predicted) === Math.sign(actual)) {
        this.directionMatches++;
      }
      this.totalPredictions++;
      
      // Clear the prediction
      this.predictions.delete(symbol);
    }
  }
  
  /**
   * Get prediction accuracy metrics
   */
  getPredictionMetrics(): {
    mae: number;
    directionAccuracy: number;
    totalPredictions: number;
  } {
    const mae = this.predictionErrors.length > 0
      ? this.predictionErrors.reduce((a, b) => a + b, 0) / this.predictionErrors.length
      : 0;
    
    const directionAccuracy = this.totalPredictions > 0
      ? this.directionMatches / this.totalPredictions
      : 0;
    
    return {
      mae,
      directionAccuracy,
      totalPredictions: this.totalPredictions,
    };
  }
}

/**
 * Hybrid Strategy - Combines reactive and predictive approaches
 * 
 * Enter if EITHER:
 * - Current spread exceeds reactive threshold, OR
 * - Predicted spread exceeds predictive threshold with high confidence
 */
export class HybridStrategy implements IBacktestStrategy {
  readonly mode: StrategyMode = 'hybrid';
  
  private readonly reactiveStrategy: ReactiveStrategy;
  private readonly predictiveStrategy: PredictiveStrategy;
  
  constructor(
    config: BacktestConfig,
    costModel: CostModel,
    predictionService: BacktestPredictionService,
  ) {
    this.reactiveStrategy = new ReactiveStrategy(config, costModel);
    this.predictiveStrategy = new PredictiveStrategy(config, costModel, predictionService);
  }
  
  evaluateEntries(
    timestamp: Date,
    dataPoints: Map<string, BacktestFundingPoint>,
    positionManager: PositionManager,
  ): EntrySignal[] {
    // Get signals from both strategies
    const reactiveSignals = this.reactiveStrategy.evaluateEntries(timestamp, dataPoints, positionManager);
    const predictiveSignals = this.predictiveStrategy.evaluateEntries(timestamp, dataPoints, positionManager);
    
    // Merge signals, preferring predictive if both exist for same symbol
    const signalMap = new Map<string, EntrySignal>();
    
    for (const signal of reactiveSignals) {
      signalMap.set(signal.symbol, signal);
    }
    
    for (const signal of predictiveSignals) {
      const existing = signalMap.get(signal.symbol);
      if (!existing || (signal.confidence || 0) > 0.6) {
        signalMap.set(signal.symbol, {
          ...signal,
          reason: `Hybrid: ${signal.reason}`,
        });
      }
    }
    
    // Sort by expected value (confidence * spread)
    const signals = Array.from(signalMap.values());
    signals.sort((a, b) => {
      const scoreA = (a.confidence || 0.5) * Math.abs(a.predictedSpread || a.currentSpread);
      const scoreB = (b.confidence || 0.5) * Math.abs(b.predictedSpread || b.currentSpread);
      return scoreB - scoreA;
    });
    
    return signals;
  }
  
  updateState(point: BacktestFundingPoint): void {
    this.reactiveStrategy.updateState(point);
    this.predictiveStrategy.updateState(point);
  }
  
  calculateLeverage(symbol: string): number {
    return this.predictiveStrategy.calculateLeverage(symbol);
  }
  
  /**
   * Get prediction metrics from predictive component
   */
  getPredictionMetrics() {
    return this.predictiveStrategy.getPredictionMetrics();
  }
}

/**
 * Factory function to create strategy based on mode
 */
export function createStrategy(
  mode: StrategyMode,
  config: BacktestConfig,
  costModel: CostModel,
  predictionService: BacktestPredictionService,
): IBacktestStrategy {
  switch (mode) {
    case 'reactive':
      return new ReactiveStrategy(config, costModel);
    case 'predictive':
      return new PredictiveStrategy(config, costModel, predictionService);
    case 'hybrid':
      return new HybridStrategy(config, costModel, predictionService);
    default:
      throw new Error(`Unknown strategy mode: ${mode}`);
  }
}

