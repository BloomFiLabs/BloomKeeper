import { Injectable, Logger } from '@nestjs/common';
import {
  IFundingRatePredictor,
  PredictionContext,
  PredictionResult,
} from '../../../ports/IFundingRatePredictor';

/**
 * Configuration for premium index predictor
 */
const PI_CONFIG = {
  /** Base interest rate component (typically 0.01% per 8h = 0.00125% per hour) */
  BASE_INTEREST_RATE: 0.0000125,
  /** Maximum premium clamp (prevents extreme predictions) */
  MAX_PREMIUM: 0.0005,
  /** Minimum premium clamp */
  MIN_PREMIUM: -0.0005,
  /** Premium dampening factor (accounts for arbitrage pressure) */
  DAMPENING_FACTOR: 0.7,
  /** Base confidence when premium data is available */
  BASE_CONFIDENCE: 0.75,
  /** Confidence reduction when index price unavailable */
  NO_INDEX_PENALTY: 0.3,
  /** Prediction horizon in hours */
  HORIZON_HOURS: 1,
} as const;

/**
 * PremiumIndexPredictor - Uses mark/index price basis for prediction
 *
 * Funding Rate = Premium Index + Interest Rate
 *
 * Where:
 * - Premium Index = (Mark Price - Index Price) / Index Price
 * - Interest Rate is a fixed component (typically 0.01% per 8h)
 *
 * The premium reflects the cost of carry and market imbalance.
 * When perp trades at premium, longs pay shorts (positive funding).
 * When perp trades at discount, shorts pay longs (negative funding).
 *
 * @see PDF Section II.B - Premium Index Calculation
 */
@Injectable()
export class PremiumIndexPredictor implements IFundingRatePredictor {
  readonly name = 'PremiumIndex';
  private readonly logger = new Logger(PremiumIndexPredictor.name);

  /**
   * Check if we can make predictions (need mark price at minimum)
   */
  canPredict(context: PredictionContext): boolean {
    return context.markPrice > 0;
  }

  /**
   * Get base confidence for this predictor
   */
  getBaseConfidence(): number {
    return PI_CONFIG.BASE_CONFIDENCE;
  }

  /**
   * Generate prediction based on premium index
   */
  predict(context: PredictionContext): PredictionResult {
    if (!this.canPredict(context)) {
      return this.createFailedPrediction('No mark price available');
    }

    const { premium, confidence, hasIndexPrice } = this.calculatePremium(context);

    // Funding Rate = Premium Index + Interest Rate
    const rawPrediction = premium + PI_CONFIG.BASE_INTEREST_RATE;

    // Apply dampening to account for arbitrage that will reduce the premium
    const dampenedPrediction = rawPrediction * PI_CONFIG.DAMPENING_FACTOR;

    // Clamp to reasonable bounds
    const predictedRate = this.clampPrediction(dampenedPrediction);

    // Calculate bounds based on historical volatility if available
    const bounds = this.calculateBounds(context, predictedRate);

    return {
      predictedRate,
      confidence,
      horizonHours: PI_CONFIG.HORIZON_HOURS,
      upperBound: bounds.upper,
      lowerBound: bounds.lower,
      metadata: {
        rawPremium: premium,
        dampenedPremium: dampenedPrediction,
        interestRate: PI_CONFIG.BASE_INTEREST_RATE,
        hasIndexPrice,
        markPrice: context.markPrice,
        indexPrice: context.indexPrice,
      },
    };
  }

  /**
   * Calculate premium index from mark and index prices
   */
  private calculatePremium(context: PredictionContext): {
    premium: number;
    confidence: number;
    hasIndexPrice: boolean;
  } {
    const hasIndexPrice = context.indexPrice !== undefined && context.indexPrice > 0;

    if (hasIndexPrice) {
      // Direct calculation: Premium = (Mark - Index) / Index
      const premium = (context.markPrice - context.indexPrice!) / context.indexPrice!;
      return {
        premium: this.clampPremium(premium),
        confidence: PI_CONFIG.BASE_CONFIDENCE,
        hasIndexPrice: true,
      };
    }

    // Fallback: Estimate premium from historical rate behavior
    return this.estimatePremiumFromHistory(context);
  }

  /**
   * Estimate premium when index price is unavailable
   * Uses historical rates to infer the premium component
   */
  private estimatePremiumFromHistory(context: PredictionContext): {
    premium: number;
    confidence: number;
    hasIndexPrice: boolean;
  } {
    if (context.historicalRates.length === 0) {
      // No data - assume neutral premium
      return {
        premium: 0,
        confidence: PI_CONFIG.BASE_CONFIDENCE - PI_CONFIG.NO_INDEX_PENALTY,
        hasIndexPrice: false,
      };
    }

    // Use recent rate as proxy for premium (subtract interest rate)
    const recentRates = context.historicalRates
      .slice(0, 8) // Last 8 hours
      .map((r) => r.rate);

    const avgRate = recentRates.reduce((a, b) => a + b, 0) / recentRates.length;
    const estimatedPremium = avgRate - PI_CONFIG.BASE_INTEREST_RATE;

    return {
      premium: this.clampPremium(estimatedPremium),
      confidence: PI_CONFIG.BASE_CONFIDENCE - PI_CONFIG.NO_INDEX_PENALTY,
      hasIndexPrice: false,
    };
  }

  /**
   * Calculate prediction bounds
   */
  private calculateBounds(
    context: PredictionContext,
    predictedRate: number,
  ): { upper: number; lower: number } {
    // Base uncertainty
    let uncertainty = Math.abs(predictedRate) * 0.3 + 0.0001;

    // Increase uncertainty based on historical volatility
    if (context.historicalRates.length > 10) {
      const rates = context.historicalRates.slice(0, 24).map((r) => r.rate);
      const stdDev = this.calculateStdDev(rates);
      uncertainty = Math.max(uncertainty, stdDev * 2);
    }

    return {
      upper: Math.min(PI_CONFIG.MAX_PREMIUM, predictedRate + uncertainty),
      lower: Math.max(PI_CONFIG.MIN_PREMIUM, predictedRate - uncertainty),
    };
  }

  /**
   * Clamp premium to configured bounds
   */
  private clampPremium(premium: number): number {
    return Math.max(PI_CONFIG.MIN_PREMIUM, Math.min(PI_CONFIG.MAX_PREMIUM, premium));
  }

  /**
   * Clamp final prediction
   */
  private clampPrediction(rate: number): number {
    // Slightly wider bounds for total rate (premium + interest)
    const maxRate = PI_CONFIG.MAX_PREMIUM * 1.2;
    const minRate = PI_CONFIG.MIN_PREMIUM * 1.2;
    return Math.max(minRate, Math.min(maxRate, rate));
  }

  /**
   * Create failed prediction result
   */
  private createFailedPrediction(reason: string): PredictionResult {
    return {
      predictedRate: 0,
      confidence: 0,
      horizonHours: PI_CONFIG.HORIZON_HOURS,
      metadata: { error: reason },
    };
  }

  /**
   * Calculate standard deviation
   */
  private calculateStdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }
}

