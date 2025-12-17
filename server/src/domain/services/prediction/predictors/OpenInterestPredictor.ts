import { Injectable, Logger } from '@nestjs/common';
import {
  IFundingRatePredictor,
  PredictionContext,
  PredictionResult,
  HistoricalOIPoint,
} from '../../../ports/IFundingRatePredictor';

/**
 * Configuration for open interest predictor
 */
const OI_CONFIG = {
  /** Minimum historical OI points required */
  MIN_OI_POINTS: 6,
  /** OI change threshold for signal (5% change) */
  OI_CHANGE_THRESHOLD: 0.05,
  /** Price change threshold for signal (1% change) */
  PRICE_CHANGE_THRESHOLD: 0.01,
  /** Base confidence when OI data is available */
  BASE_CONFIDENCE: 0.6,
  /** Confidence boost for strong signals */
  STRONG_SIGNAL_BOOST: 0.15,
  /** Prediction horizon in hours */
  HORIZON_HOURS: 1,
  /** Rate adjustment magnitude per signal unit */
  RATE_ADJUSTMENT_FACTOR: 0.0001,
  /** Maximum rate adjustment */
  MAX_RATE_ADJUSTMENT: 0.0003,
} as const;

/**
 * OI/Price relationship signals
 */
enum OISignal {
  /** Rising OI + Rising Price = Bullish, expect positive funding */
  BULLISH_ACCUMULATION = 'bullish_accumulation',
  /** Rising OI + Falling Price = Bearish, expect negative funding */
  BEARISH_ACCUMULATION = 'bearish_accumulation',
  /** Falling OI + Rising Price = Bullish short covering */
  BULLISH_COVERING = 'bullish_covering',
  /** Falling OI + Falling Price = Bearish liquidation */
  BEARISH_LIQUIDATION = 'bearish_liquidation',
  /** No clear signal */
  NEUTRAL = 'neutral',
}

/**
 * OpenInterestPredictor - Uses OI as leading indicator for funding
 *
 * Open Interest analysis based on the relationship between OI changes
 * and price movements to predict funding rate direction:
 *
 * - Rising OI + Rising Price → New longs entering → Expect positive funding
 * - Rising OI + Falling Price → New shorts entering → Expect negative funding
 * - Falling OI + Rising Price → Short covering → Funding reverts toward mean
 * - Falling OI + Falling Price → Long liquidation → Funding reverts toward mean
 *
 * @see PDF Section II.B - Open Interest as Leading Indicator
 */
@Injectable()
export class OpenInterestPredictor implements IFundingRatePredictor {
  readonly name = 'OpenInterest';
  private readonly logger = new Logger(OpenInterestPredictor.name);

  /**
   * Check if we can make predictions
   */
  canPredict(context: PredictionContext): boolean {
    return (
      context.openInterest !== undefined &&
      context.openInterest > 0 &&
      context.historicalOI !== undefined &&
      context.historicalOI.length >= OI_CONFIG.MIN_OI_POINTS
    );
  }

  /**
   * Get base confidence for this predictor
   */
  getBaseConfidence(): number {
    return OI_CONFIG.BASE_CONFIDENCE;
  }

  /**
   * Generate prediction based on OI analysis
   */
  predict(context: PredictionContext): PredictionResult {
    if (!this.canPredict(context)) {
      return this.createFallbackPrediction(context);
    }

    // Analyze OI/Price relationship
    const signal = this.analyzeOISignal(context);
    const signalStrength = this.calculateSignalStrength(context);

    // Calculate rate adjustment based on signal
    const rateAdjustment = this.calculateRateAdjustment(
      signal,
      signalStrength,
      context.currentRate,
    );

    const predictedRate = context.currentRate + rateAdjustment;
    const confidence = this.calculateConfidence(signal, signalStrength);

    // Calculate bounds
    const bounds = this.calculateBounds(context, predictedRate, signalStrength);

    return {
      predictedRate,
      confidence,
      horizonHours: OI_CONFIG.HORIZON_HOURS,
      upperBound: bounds.upper,
      lowerBound: bounds.lower,
      metadata: {
        signal,
        signalStrength,
        rateAdjustment,
        oiChange: this.calculateOIChange(context),
        priceChange: this.calculatePriceChange(context),
        currentOI: context.openInterest,
      },
    };
  }

  /**
   * Analyze OI/Price relationship to determine signal
   */
  private analyzeOISignal(context: PredictionContext): OISignal {
    const oiChange = this.calculateOIChange(context);
    const priceChange = this.calculatePriceChange(context);

    const oiRising = oiChange > OI_CONFIG.OI_CHANGE_THRESHOLD;
    const oiFalling = oiChange < -OI_CONFIG.OI_CHANGE_THRESHOLD;
    const priceRising = priceChange > OI_CONFIG.PRICE_CHANGE_THRESHOLD;
    const priceFalling = priceChange < -OI_CONFIG.PRICE_CHANGE_THRESHOLD;

    if (oiRising && priceRising) {
      return OISignal.BULLISH_ACCUMULATION;
    }
    if (oiRising && priceFalling) {
      return OISignal.BEARISH_ACCUMULATION;
    }
    if (oiFalling && priceRising) {
      return OISignal.BULLISH_COVERING;
    }
    if (oiFalling && priceFalling) {
      return OISignal.BEARISH_LIQUIDATION;
    }

    return OISignal.NEUTRAL;
  }

  /**
   * Calculate OI change percentage over lookback period
   */
  private calculateOIChange(context: PredictionContext): number {
    if (!context.historicalOI || context.historicalOI.length < 2) {
      return 0;
    }

    const sorted = this.sortByTime(context.historicalOI);
    const oldestOI = sorted[0].openInterest;
    const currentOI = context.openInterest ?? sorted[sorted.length - 1].openInterest;

    if (oldestOI <= 0) return 0;
    return (currentOI - oldestOI) / oldestOI;
  }

  /**
   * Calculate price change percentage over lookback period
   */
  private calculatePriceChange(context: PredictionContext): number {
    if (!context.historicalOI || context.historicalOI.length < 2) {
      return 0;
    }

    const sorted = this.sortByTime(context.historicalOI);
    const oldestPrice = sorted[0].price;
    const currentPrice = context.markPrice || sorted[sorted.length - 1].price;

    if (oldestPrice <= 0) return 0;
    return (currentPrice - oldestPrice) / oldestPrice;
  }

  /**
   * Calculate signal strength based on magnitude of OI and price changes
   */
  private calculateSignalStrength(context: PredictionContext): number {
    const oiChange = Math.abs(this.calculateOIChange(context));
    const priceChange = Math.abs(this.calculatePriceChange(context));

    // Normalize changes to 0-1 scale
    const normalizedOI = Math.min(1, oiChange / 0.2); // 20% OI change = max
    const normalizedPrice = Math.min(1, priceChange / 0.05); // 5% price change = max

    // Combined strength (geometric mean for balanced weighting)
    return Math.sqrt(normalizedOI * normalizedPrice);
  }

  /**
   * Calculate rate adjustment based on signal
   */
  private calculateRateAdjustment(
    signal: OISignal,
    strength: number,
    currentRate: number,
  ): number {
    const baseAdjustment = OI_CONFIG.RATE_ADJUSTMENT_FACTOR * strength;

    switch (signal) {
      case OISignal.BULLISH_ACCUMULATION:
        // More longs → expect higher funding (positive adjustment)
        return Math.min(baseAdjustment, OI_CONFIG.MAX_RATE_ADJUSTMENT);

      case OISignal.BEARISH_ACCUMULATION:
        // More shorts → expect lower funding (negative adjustment)
        return -Math.min(baseAdjustment, OI_CONFIG.MAX_RATE_ADJUSTMENT);

      case OISignal.BULLISH_COVERING:
      case OISignal.BEARISH_LIQUIDATION:
        // Position closing → funding reverts toward zero
        return -currentRate * strength * 0.3;

      case OISignal.NEUTRAL:
      default:
        return 0;
    }
  }

  /**
   * Calculate confidence based on signal clarity
   */
  private calculateConfidence(signal: OISignal, strength: number): number {
    let confidence = OI_CONFIG.BASE_CONFIDENCE;

    // Strong signals get confidence boost
    if (strength > 0.5) {
      confidence += OI_CONFIG.STRONG_SIGNAL_BOOST;
    }

    // Clear directional signals are more reliable
    if (
      signal === OISignal.BULLISH_ACCUMULATION ||
      signal === OISignal.BEARISH_ACCUMULATION
    ) {
      confidence += 0.05;
    }

    // Neutral signals are less informative
    if (signal === OISignal.NEUTRAL) {
      confidence -= 0.1;
    }

    return Math.max(0.2, Math.min(0.85, confidence));
  }

  /**
   * Calculate prediction bounds
   */
  private calculateBounds(
    context: PredictionContext,
    predictedRate: number,
    signalStrength: number,
  ): { upper: number; lower: number } {
    // Base uncertainty inversely proportional to signal strength
    const uncertainty =
      OI_CONFIG.RATE_ADJUSTMENT_FACTOR * 3 * (1 - signalStrength * 0.5);

    return {
      upper: predictedRate + uncertainty,
      lower: predictedRate - uncertainty,
    };
  }

  /**
   * Create fallback prediction when OI data unavailable
   */
  private createFallbackPrediction(context: PredictionContext): PredictionResult {
    // Without OI data, predict current rate continues with low confidence
    return {
      predictedRate: context.currentRate,
      confidence: 0.2,
      horizonHours: OI_CONFIG.HORIZON_HOURS,
      metadata: {
        signal: OISignal.NEUTRAL,
        reason: 'Insufficient OI data for prediction',
      },
    };
  }

  /**
   * Sort OI points by timestamp (oldest first)
   */
  private sortByTime(points: HistoricalOIPoint[]): HistoricalOIPoint[] {
    return [...points].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }
}

