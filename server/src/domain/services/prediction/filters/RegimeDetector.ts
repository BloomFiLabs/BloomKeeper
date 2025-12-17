import { Injectable, Logger } from '@nestjs/common';
import {
  MarketRegime,
  RegimeDetectionResult,
  HistoricalRatePoint,
  PredictionContext,
} from '../../../ports/IFundingRatePredictor';
import { KalmanFilterEstimator } from './KalmanFilterEstimator';

/**
 * Configuration for regime detection
 */
const REGIME_CONFIG = {
  /** Minimum data points for regime detection */
  MIN_DATA_POINTS: 24,
  /** Volatility ratio threshold for high volatility regime */
  HIGH_VOLATILITY_THRESHOLD: 2.0,
  /** Volatility ratio threshold for extreme dislocation */
  EXTREME_DISLOCATION_THRESHOLD: 4.0,
  /** Trend strength threshold for trending regime */
  TREND_THRESHOLD: 0.6,
  /** Mean reversion score threshold */
  MEAN_REVERSION_THRESHOLD: 0.5,
  /** Rolling window size for volatility calculation (hours) */
  VOLATILITY_WINDOW: 24,
  /** Long-term window for baseline statistics (hours) */
  BASELINE_WINDOW: 168, // 7 days
  /** Exponential smoothing factor for regime transitions */
  REGIME_SMOOTHING: 0.3,
} as const;

/**
 * Cached regime state for smooth transitions
 */
interface RegimeState {
  currentRegime: MarketRegime;
  confidence: number;
  lastUpdated: Date;
  regimeProbabilities: Record<MarketRegime, number>;
}

/**
 * RegimeDetector - Classifies market into behavioral regimes
 *
 * Regimes:
 * - MEAN_REVERTING: Normal conditions, rates oscillate around mean
 * - TRENDING: Sustained directional movement in funding
 * - HIGH_VOLATILITY: Elevated volatility, predictions less reliable
 * - EXTREME_DISLOCATION: Rates > 4x normal, arbitrage capacity exhausted
 *
 * The detected regime is used to adjust predictor weights in the ensemble.
 *
 * @see PDF Section III - Regime Detection
 */
@Injectable()
export class RegimeDetector {
  private readonly logger = new Logger(RegimeDetector.name);

  /** Cached regime states by symbol-exchange key */
  private readonly regimeStates: Map<string, RegimeState> = new Map();

  constructor(private readonly kalmanFilter: KalmanFilterEstimator) {}

  /**
   * Detect current market regime
   */
  detectRegime(context: PredictionContext): RegimeDetectionResult {
    const key = this.getKey(context.symbol, context.exchange);

    // Calculate regime metrics
    const metrics = this.calculateRegimeMetrics(context);

    // Calculate regime probabilities
    const probabilities = this.calculateRegimeProbabilities(metrics);

    // Select regime with highest probability
    const selectedRegime = this.selectRegime(probabilities);

    // Apply smoothing for regime stability
    const smoothedResult = this.applyRegimeSmoothing(
      key,
      selectedRegime,
      probabilities,
      metrics,
    );

    return smoothedResult;
  }

  /**
   * Calculate all metrics needed for regime classification
   */
  private calculateRegimeMetrics(context: PredictionContext): {
    volatilityRatio: number;
    trendStrength: number;
    meanReversionScore: number;
    dislocationLevel: number;
  } {
    const rates = context.historicalRates.map((r) => r.rate);

    if (rates.length < REGIME_CONFIG.MIN_DATA_POINTS) {
      return {
        volatilityRatio: 1,
        trendStrength: 0,
        meanReversionScore: 0.5,
        dislocationLevel: 1,
      };
    }

    // Split into recent and baseline windows
    const recentRates = rates.slice(0, REGIME_CONFIG.VOLATILITY_WINDOW);
    const baselineRates = rates.slice(0, REGIME_CONFIG.BASELINE_WINDOW);

    // Calculate volatility ratio
    const recentVolatility = this.calculateVolatility(recentRates);
    const baselineVolatility = this.calculateVolatility(baselineRates);
    const volatilityRatio =
      baselineVolatility > 1e-8 ? recentVolatility / baselineVolatility : 1;

    // Calculate trend strength using linear regression
    const trendStrength = this.calculateTrendStrength(recentRates);

    // Calculate mean reversion score using autocorrelation
    const meanReversionScore = this.calculateMeanReversionScore(recentRates);

    // Calculate dislocation level
    const baselineMean = this.calculateMean(baselineRates);
    const dislocationLevel =
      baselineMean !== 0
        ? Math.abs(context.currentRate / baselineMean)
        : Math.abs(context.currentRate) / 0.0001 + 1;

    return {
      volatilityRatio: Math.min(10, volatilityRatio),
      trendStrength: Math.max(-1, Math.min(1, trendStrength)),
      meanReversionScore: Math.max(0, Math.min(1, meanReversionScore)),
      dislocationLevel: Math.min(10, dislocationLevel),
    };
  }

  /**
   * Calculate regime probabilities using fuzzy logic
   */
  private calculateRegimeProbabilities(metrics: {
    volatilityRatio: number;
    trendStrength: number;
    meanReversionScore: number;
    dislocationLevel: number;
  }): Record<MarketRegime, number> {
    const {
      volatilityRatio,
      trendStrength,
      meanReversionScore,
      dislocationLevel,
    } = metrics;

    // Calculate membership scores for each regime
    const extremeScore = this.sigmoidMembership(
      dislocationLevel,
      REGIME_CONFIG.EXTREME_DISLOCATION_THRESHOLD,
      1,
    );

    const highVolScore = this.sigmoidMembership(
      volatilityRatio,
      REGIME_CONFIG.HIGH_VOLATILITY_THRESHOLD,
      0.5,
    );

    const trendingScore = this.sigmoidMembership(
      Math.abs(trendStrength),
      REGIME_CONFIG.TREND_THRESHOLD,
      0.3,
    );

    const meanRevertingScore = this.sigmoidMembership(
      meanReversionScore,
      REGIME_CONFIG.MEAN_REVERSION_THRESHOLD,
      0.3,
    );

    // Priority-based probabilities (extreme > high_vol > trending > mean_reverting)
    const rawProbabilities = {
      [MarketRegime.EXTREME_DISLOCATION]: extremeScore,
      [MarketRegime.HIGH_VOLATILITY]: highVolScore * (1 - extremeScore),
      [MarketRegime.TRENDING]:
        trendingScore * (1 - extremeScore) * (1 - highVolScore),
      [MarketRegime.MEAN_REVERTING]:
        meanRevertingScore *
        (1 - extremeScore) *
        (1 - highVolScore) *
        (1 - trendingScore),
    };

    // Normalize to sum to 1
    const total = Object.values(rawProbabilities).reduce((a, b) => a + b, 0);
    const normalized: Record<MarketRegime, number> = {} as Record<
      MarketRegime,
      number
    >;

    for (const regime of Object.values(MarketRegime)) {
      normalized[regime] = total > 0 ? rawProbabilities[regime] / total : 0.25;
    }

    return normalized;
  }

  /**
   * Sigmoid membership function for fuzzy logic
   */
  private sigmoidMembership(
    value: number,
    threshold: number,
    steepness: number,
  ): number {
    return 1 / (1 + Math.exp(-steepness * (value - threshold)));
  }

  /**
   * Select regime with highest probability
   */
  private selectRegime(
    probabilities: Record<MarketRegime, number>,
  ): MarketRegime {
    let maxProb = 0;
    let selectedRegime = MarketRegime.MEAN_REVERTING;

    for (const [regime, prob] of Object.entries(probabilities)) {
      if (prob > maxProb) {
        maxProb = prob;
        selectedRegime = regime as MarketRegime;
      }
    }

    return selectedRegime;
  }

  /**
   * Apply temporal smoothing to prevent rapid regime switching
   */
  private applyRegimeSmoothing(
    key: string,
    newRegime: MarketRegime,
    newProbabilities: Record<MarketRegime, number>,
    metrics: RegimeDetectionResult['metrics'],
  ): RegimeDetectionResult {
    const existingState = this.regimeStates.get(key);
    const alpha = REGIME_CONFIG.REGIME_SMOOTHING;

    let smoothedProbabilities: Record<MarketRegime, number>;

    if (existingState) {
      // Exponential smoothing of probabilities
      smoothedProbabilities = {} as Record<MarketRegime, number>;
      for (const regime of Object.values(MarketRegime)) {
        smoothedProbabilities[regime] =
          alpha * newProbabilities[regime] +
          (1 - alpha) * existingState.regimeProbabilities[regime];
      }
    } else {
      smoothedProbabilities = newProbabilities;
    }

    // Select regime from smoothed probabilities
    const finalRegime = this.selectRegime(smoothedProbabilities);
    const confidence = smoothedProbabilities[finalRegime];

    // Update state
    const newState: RegimeState = {
      currentRegime: finalRegime,
      confidence,
      lastUpdated: new Date(),
      regimeProbabilities: smoothedProbabilities,
    };
    this.regimeStates.set(key, newState);

    return {
      regime: finalRegime,
      confidence,
      metrics,
    };
  }

  /**
   * Calculate volatility (standard deviation)
   */
  private calculateVolatility(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = this.calculateMean(values);
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Calculate trend strength using linear regression slope
   * Returns value between -1 and 1
   */
  private calculateTrendStrength(values: number[]): number {
    if (values.length < 3) return 0;

    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = this.calculateMean(values);

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      const x = i;
      const y = values[i];
      numerator += (x - xMean) * (y - yMean);
      denominator += (x - xMean) ** 2;
    }

    const slope = denominator !== 0 ? numerator / denominator : 0;

    // Normalize slope by volatility
    const volatility = this.calculateVolatility(values);
    if (volatility < 1e-8) return 0;

    // Scale slope to -1 to 1 range
    const normalizedSlope = slope / volatility;
    return Math.max(-1, Math.min(1, normalizedSlope * 10));
  }

  /**
   * Calculate mean reversion score using lag-1 autocorrelation
   * Negative autocorrelation indicates mean reversion
   */
  private calculateMeanReversionScore(values: number[]): number {
    if (values.length < 10) return 0.5;

    // Calculate lag-1 autocorrelation
    const mean = this.calculateMean(values);
    let numerator = 0;
    let denominator = 0;

    for (let i = 1; i < values.length; i++) {
      numerator += (values[i] - mean) * (values[i - 1] - mean);
      denominator += (values[i - 1] - mean) ** 2;
    }

    const autocorr = denominator !== 0 ? numerator / denominator : 0;

    // Convert autocorrelation to mean reversion score
    // Negative autocorrelation = mean reverting (score close to 1)
    // Positive autocorrelation = trending (score close to 0)
    return Math.max(0, Math.min(1, 0.5 - autocorr));
  }

  /**
   * Calculate mean of values
   */
  private calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Get cached regime state
   */
  getCachedRegime(symbol: string, exchange: string): RegimeState | null {
    return this.regimeStates.get(this.getKey(symbol, exchange)) ?? null;
  }

  /**
   * Get cache key
   */
  private getKey(symbol: string, exchange: unknown): string {
    return `${symbol}_${String(exchange)}`;
  }

  /**
   * Clear all cached regime states
   */
  clearCache(): void {
    this.regimeStates.clear();
  }
}
