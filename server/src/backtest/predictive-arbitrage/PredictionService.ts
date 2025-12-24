/**
 * PredictionService - Wraps prediction logic for backtest use
 * 
 * Provides walk-forward prediction without requiring full NestJS DI
 */

import { MarketRegime, PredictionContext, HistoricalRatePoint } from '../../domain/ports/IFundingRatePredictor';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { BacktestFundingPoint } from './types';

/**
 * Prediction result for backtest
 */
export interface BacktestPrediction {
  predictedSpread: number;
  confidence: number;
  regime: MarketRegime;
  
  // Individual exchange predictions
  predictedHyperliquidRate: number;
  predictedLighterRate: number;
  
  // Prediction metadata
  horizonHours: number;
  upperBound: number;
  lowerBound: number;
}

/**
 * Simple prediction model for backtesting
 * Uses mean reversion with regime detection - mirrors production ensemble approach
 */
export class BacktestPredictionService {
  private readonly historyCache: Map<string, BacktestFundingPoint[]> = new Map();
  
  // Configuration
  private readonly lookbackHours = 168; // 7 days
  private readonly minDataPoints = 24; // 1 day minimum
  private readonly meanReversionSpeed = 0.15; // How fast we expect reversion
  
  /**
   * Update history cache with new data point
   */
  updateHistory(point: BacktestFundingPoint): void {
    const key = point.symbol;
    const history = this.historyCache.get(key) || [];
    
    history.push(point);
    
    // Keep only lookback period
    const cutoff = new Date(point.timestamp.getTime() - this.lookbackHours * 60 * 60 * 1000);
    const filtered = history.filter(p => p.timestamp >= cutoff);
    
    this.historyCache.set(key, filtered);
  }
  
  /**
   * Generate prediction for next funding period
   */
  predict(symbol: string, currentPoint: BacktestFundingPoint): BacktestPrediction | null {
    const history = this.historyCache.get(symbol);
    
    if (!history || history.length < this.minDataPoints) {
      return null;
    }
    
    // Detect regime
    const regime = this.detectRegime(history);
    
    // Calculate base predictions using mean reversion + regime adjustment
    const hlRates = history.map(p => p.hyperliquidRate).filter(r => r !== null) as number[];
    const lighterRates = history.map(p => p.lighterRate).filter(r => r !== null) as number[];
    const spreads = history.map(p => p.spread).filter(s => s !== null) as number[];
    
    if (hlRates.length < this.minDataPoints || lighterRates.length < this.minDataPoints) {
      return null;
    }
    
    // Calculate means
    const hlMean = this.calculateMean(hlRates);
    const lighterMean = this.calculateMean(lighterRates);
    const spreadMean = this.calculateMean(spreads);
    
    // Calculate volatilities
    const hlVol = this.calculateVolatility(hlRates);
    const lighterVol = this.calculateVolatility(lighterRates);
    const spreadVol = this.calculateVolatility(spreads);
    
    // Current values
    const currentHL = currentPoint.hyperliquidRate ?? hlMean;
    const currentLighter = currentPoint.lighterRate ?? lighterMean;
    const currentSpread = currentPoint.spread ?? spreadMean;
    
    // Predict using regime-adjusted mean reversion
    const reversionFactor = this.getReversionFactor(regime);
    
    const predictedHL = currentHL + reversionFactor * (hlMean - currentHL);
    const predictedLighter = currentLighter + reversionFactor * (lighterMean - currentLighter);
    const predictedSpread = predictedHL - predictedLighter;
    
    // Calculate confidence based on:
    // 1. How consistent the spread has been
    // 2. Current volatility
    // 3. Distance from mean (extreme values less confident)
    const consistency = this.calculateConsistency(spreads);
    const volatilityPenalty = Math.min(1, spreadVol / 0.001); // Higher vol = lower confidence
    const extremePenalty = Math.min(1, Math.abs(currentSpread - spreadMean) / (2 * spreadVol));
    
    let confidence = 0.5 + 0.2 * consistency - 0.1 * volatilityPenalty - 0.1 * extremePenalty;
    confidence = Math.max(0.3, Math.min(0.85, confidence));
    
    // Adjust confidence by regime
    if (regime === MarketRegime.HIGH_VOLATILITY || regime === MarketRegime.EXTREME_DISLOCATION) {
      confidence *= 0.8;
    }
    
    // Calculate bounds (1 standard deviation)
    const uncertainty = spreadVol * (1 + 0.5 * (1 - confidence));
    
    return {
      predictedSpread,
      confidence,
      regime,
      predictedHyperliquidRate: predictedHL,
      predictedLighterRate: predictedLighter,
      horizonHours: 1,
      upperBound: predictedSpread + uncertainty,
      lowerBound: predictedSpread - uncertainty,
    };
  }
  
  /**
   * Detect market regime from historical data
   */
  private detectRegime(history: BacktestFundingPoint[]): MarketRegime {
    if (history.length < this.minDataPoints) {
      return MarketRegime.MEAN_REVERTING;
    }
    
    const spreads = history.map(p => p.spread).filter(s => s !== null) as number[];
    if (spreads.length === 0) return MarketRegime.MEAN_REVERTING;
    
    const recentSpreads = spreads.slice(-24); // Last 24 hours
    const olderSpreads = spreads.slice(0, -24);
    
    if (olderSpreads.length < 24) {
      return MarketRegime.MEAN_REVERTING;
    }
    
    // Calculate metrics
    const recentVol = this.calculateVolatility(recentSpreads);
    const baselineVol = this.calculateVolatility(olderSpreads);
    const volatilityRatio = baselineVol > 0 ? recentVol / baselineVol : 1;
    
    const recentMean = this.calculateMean(recentSpreads);
    const baselineMean = this.calculateMean(olderSpreads);
    const meanShift = Math.abs(recentMean - baselineMean) / (baselineVol + 0.0001);
    
    // Trend detection
    const trendStrength = this.calculateTrendStrength(recentSpreads);
    
    // Classify regime
    if (volatilityRatio > 4.0 || meanShift > 3.0) {
      return MarketRegime.EXTREME_DISLOCATION;
    }
    
    if (volatilityRatio > 2.0) {
      return MarketRegime.HIGH_VOLATILITY;
    }
    
    if (Math.abs(trendStrength) > 0.6) {
      return MarketRegime.TRENDING;
    }
    
    return MarketRegime.MEAN_REVERTING;
  }
  
  /**
   * Get mean reversion factor based on regime
   */
  private getReversionFactor(regime: MarketRegime): number {
    switch (regime) {
      case MarketRegime.MEAN_REVERTING:
        return this.meanReversionSpeed * 1.5; // Strong reversion
      case MarketRegime.TRENDING:
        return this.meanReversionSpeed * 0.5; // Weak reversion
      case MarketRegime.HIGH_VOLATILITY:
        return this.meanReversionSpeed * 0.8; // Moderate reversion
      case MarketRegime.EXTREME_DISLOCATION:
        return this.meanReversionSpeed * 2.0; // Expect snap-back
      default:
        return this.meanReversionSpeed;
    }
  }
  
  /**
   * Calculate mean of array
   */
  private calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  
  /**
   * Calculate standard deviation
   */
  private calculateVolatility(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = this.calculateMean(values);
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }
  
  /**
   * Calculate consistency score (0-1, higher = more consistent)
   */
  private calculateConsistency(values: number[]): number {
    if (values.length < 10) return 0.5;
    
    // Calculate percentage of values with same sign
    const positive = values.filter(v => v > 0).length;
    const negative = values.filter(v => v < 0).length;
    const dominant = Math.max(positive, negative);
    
    return dominant / values.length;
  }
  
  /**
   * Calculate trend strength (-1 to 1)
   */
  private calculateTrendStrength(values: number[]): number {
    if (values.length < 3) return 0;
    
    // Linear regression slope normalized by volatility
    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = this.calculateMean(values);
    
    let numerator = 0;
    let denominator = 0;
    
    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (values[i] - yMean);
      denominator += (i - xMean) ** 2;
    }
    
    const slope = denominator !== 0 ? numerator / denominator : 0;
    const vol = this.calculateVolatility(values);
    
    if (vol === 0) return 0;
    
    // Normalize slope to -1 to 1
    const normalized = slope / vol * 10;
    return Math.max(-1, Math.min(1, normalized));
  }
  
  /**
   * Clear history cache
   */
  clearHistory(): void {
    this.historyCache.clear();
  }
  
  /**
   * Get history for a symbol
   */
  getHistory(symbol: string): BacktestFundingPoint[] {
    return this.historyCache.get(symbol) || [];
  }
}


