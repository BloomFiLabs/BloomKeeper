import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { CostCalculator } from './CostCalculator';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import type {
  IFundingRatePredictionService,
  EnsemblePredictionResult,
} from '../../ports/IFundingRatePredictor';

/**
 * Configuration for prediction-based break-even calculation
 */
const PREDICTION_CONFIG = {
  /** Minimum confidence threshold to trust prediction */
  MIN_CONFIDENCE_THRESHOLD: 0.6,
  /** Default reliable prediction horizon (hours) */
  DEFAULT_RELIABLE_HORIZON: 24,
  /** Confidence decay factor per hour of prediction horizon */
  CONFIDENCE_DECAY_PER_HOUR: 0.01,
  /** Minimum spread to consider (prevents division by near-zero) */
  MIN_SPREAD_THRESHOLD: 0.00001,
  /** Periods per year for APY calculation */
  PERIODS_PER_YEAR: 24 * 365,
} as const;

/**
 * Result of predicted break-even calculation
 */
export interface PredictedBreakEven {
  /** Break-even time using predicted spread */
  predictedBreakEvenHours: number;
  /** Confidence in the prediction (0-1) */
  confidence: number;
  /** Predicted funding rate spread (long - short) */
  predictedSpread: number;
  /** Break-even using worst-case (lower bound) spread */
  worstCaseBreakEvenHours: number;
  /** Break-even using best-case (upper bound) spread */
  bestCaseBreakEvenHours: number;
  /** How many hours ahead the prediction is reliable */
  reliableHorizonHours: number;
  /** Confidence-adjusted break-even (penalized for low confidence) */
  confidenceAdjustedBreakEvenHours: number;
  /** Whether the prediction meets minimum confidence threshold */
  isPredictionReliable: boolean;
  /** Individual prediction results */
  longPrediction: EnsemblePredictionResult | null;
  shortPrediction: EnsemblePredictionResult | null;
}

/**
 * Opportunity scoring result
 */
export interface OpportunityScore {
  /** Overall score (higher = better) */
  score: number;
  /** Component scores for debugging */
  components: {
    spreadScore: number;
    confidenceScore: number;
    breakEvenScore: number;
    liquidityScore: number;
  };
  /** Recommendation */
  recommendation: 'strong_buy' | 'buy' | 'hold' | 'skip';
  /** Reason for recommendation */
  reason: string;
}

/**
 * PredictedBreakEvenCalculator - Calculates break-even using predicted funding rates
 *
 * Key improvements over current-rate-based calculation:
 * 1. Uses ensemble prediction for future rates, not just current snapshot
 * 2. Provides confidence-weighted estimates
 * 3. Calculates reliable prediction horizon
 * 4. Returns worst-case and best-case scenarios
 */
@Injectable()
export class PredictedBreakEvenCalculator {
  private readonly logger = new Logger(PredictedBreakEvenCalculator.name);

  constructor(
    private readonly costCalculator: CostCalculator,
    private readonly config: StrategyConfig,
    @Optional()
    @Inject('IFundingRatePredictionService')
    private readonly predictionService?: IFundingRatePredictionService,
  ) {}

  /**
   * Calculate predicted break-even for an arbitrage opportunity
   */
  async calculatePredictedBreakEven(
    opportunity: ArbitrageOpportunity,
    positionSizeUsd: number,
    totalCosts: number,
  ): Promise<PredictedBreakEven> {
    // Get predictions for both legs
    const { longPrediction, shortPrediction, confidence } =
      await this.getPredictions(opportunity);

    // Calculate predicted spread
    const predictedSpread = this.calculatePredictedSpread(
      longPrediction,
      shortPrediction,
      opportunity,
    );

    // Calculate reliable horizon based on confidence
    const reliableHorizonHours = this.calculateReliableHorizon(confidence);

    // Calculate hourly return from predicted spread
    const predictedHourlyReturn = this.calculateHourlyReturn(
      predictedSpread,
      positionSizeUsd,
    );

    // Calculate break-even hours
    const predictedBreakEvenHours = this.calculateBreakEvenHours(
      totalCosts,
      predictedHourlyReturn,
    );

    // Calculate worst-case (lower bound spread)
    const worstCaseSpread = this.calculateWorstCaseSpread(
      longPrediction,
      shortPrediction,
      opportunity,
    );
    const worstCaseHourlyReturn = this.calculateHourlyReturn(
      worstCaseSpread,
      positionSizeUsd,
    );
    const worstCaseBreakEvenHours = this.calculateBreakEvenHours(
      totalCosts,
      worstCaseHourlyReturn,
    );

    // Calculate best-case (upper bound spread)
    const bestCaseSpread = this.calculateBestCaseSpread(
      longPrediction,
      shortPrediction,
      opportunity,
    );
    const bestCaseHourlyReturn = this.calculateHourlyReturn(
      bestCaseSpread,
      positionSizeUsd,
    );
    const bestCaseBreakEvenHours = this.calculateBreakEvenHours(
      totalCosts,
      bestCaseHourlyReturn,
    );

    // Calculate confidence-adjusted break-even
    const confidenceAdjustedBreakEvenHours =
      this.calculateConfidenceAdjustedBreakEven(
        predictedBreakEvenHours,
        confidence,
      );

    const isPredictionReliable =
      confidence >= PREDICTION_CONFIG.MIN_CONFIDENCE_THRESHOLD;

    return {
      predictedBreakEvenHours,
      confidence,
      predictedSpread,
      worstCaseBreakEvenHours,
      bestCaseBreakEvenHours,
      reliableHorizonHours,
      confidenceAdjustedBreakEvenHours,
      isPredictionReliable,
      longPrediction,
      shortPrediction,
    };
  }

  /**
   * Score an opportunity based on predicted break-even and confidence
   */
  async scoreOpportunity(
    opportunity: ArbitrageOpportunity,
    positionSizeUsd: number,
    totalCosts: number,
  ): Promise<OpportunityScore> {
    const breakEven = await this.calculatePredictedBreakEven(
      opportunity,
      positionSizeUsd,
      totalCosts,
    );

    // Calculate component scores (0-1 scale)
    const spreadScore = this.calculateSpreadScore(breakEven.predictedSpread);
    const confidenceScore = breakEven.confidence;
    const breakEvenScore = this.calculateBreakEvenScore(
      breakEven.confidenceAdjustedBreakEvenHours,
    );
    const liquidityScore = this.calculateLiquidityScore(opportunity);

    // Weighted combination
    const score =
      spreadScore * 0.3 +
      confidenceScore * 0.25 +
      breakEvenScore * 0.3 +
      liquidityScore * 0.15;

    // Determine recommendation
    const { recommendation, reason } = this.getRecommendation(
      score,
      breakEven,
      opportunity,
    );

    return {
      score,
      components: {
        spreadScore,
        confidenceScore,
        breakEvenScore,
        liquidityScore,
      },
      recommendation,
      reason,
    };
  }

  /**
   * Get predictions for both legs of the arbitrage
   */
  private async getPredictions(opportunity: ArbitrageOpportunity): Promise<{
    longPrediction: EnsemblePredictionResult | null;
    shortPrediction: EnsemblePredictionResult | null;
    confidence: number;
  }> {
    if (!this.predictionService || !opportunity.shortExchange) {
      return {
        longPrediction: null,
        shortPrediction: null,
        confidence: 0.5, // Default confidence when no prediction available
      };
    }

    try {
      const spreadPrediction = await this.predictionService.getSpreadPrediction(
        opportunity.symbol,
        opportunity.longExchange,
        opportunity.shortExchange,
      );

      return {
        longPrediction: spreadPrediction.longPrediction,
        shortPrediction: spreadPrediction.shortPrediction,
        confidence: spreadPrediction.confidence,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(
        `Failed to get predictions for ${opportunity.symbol}: ${message}`,
      );
      return {
        longPrediction: null,
        shortPrediction: null,
        confidence: 0.5,
      };
    }
  }

  /**
   * Calculate predicted spread from predictions
   */
  private calculatePredictedSpread(
    longPrediction: EnsemblePredictionResult | null,
    shortPrediction: EnsemblePredictionResult | null,
    opportunity: ArbitrageOpportunity,
  ): number {
    if (longPrediction && shortPrediction) {
      // Use predicted rates
      return longPrediction.predictedRate - shortPrediction.predictedRate;
    }

    // Fallback to current rates
    const longRate = opportunity.longRate?.toDecimal() ?? 0;
    const shortRate = opportunity.shortRate?.toDecimal() ?? 0;
    return longRate - shortRate;
  }

  /**
   * Calculate worst-case spread (lower bound)
   */
  private calculateWorstCaseSpread(
    longPrediction: EnsemblePredictionResult | null,
    shortPrediction: EnsemblePredictionResult | null,
    opportunity: ArbitrageOpportunity,
  ): number {
    if (
      longPrediction?.lowerBound !== undefined &&
      shortPrediction?.upperBound !== undefined
    ) {
      // Worst case: long at lower bound, short at upper bound
      return longPrediction.lowerBound - shortPrediction.upperBound;
    }

    // Fallback: use current spread with 30% haircut
    const currentSpread = this.calculatePredictedSpread(
      null,
      null,
      opportunity,
    );
    return currentSpread * 0.7;
  }

  /**
   * Calculate best-case spread (upper bound)
   */
  private calculateBestCaseSpread(
    longPrediction: EnsemblePredictionResult | null,
    shortPrediction: EnsemblePredictionResult | null,
    opportunity: ArbitrageOpportunity,
  ): number {
    if (
      longPrediction?.upperBound !== undefined &&
      shortPrediction?.lowerBound !== undefined
    ) {
      // Best case: long at upper bound, short at lower bound
      return longPrediction.upperBound - shortPrediction.lowerBound;
    }

    // Fallback: use current spread with 30% bonus
    const currentSpread = this.calculatePredictedSpread(
      null,
      null,
      opportunity,
    );
    return currentSpread * 1.3;
  }

  /**
   * Calculate reliable prediction horizon based on confidence
   */
  private calculateReliableHorizon(confidence: number): number {
    // Higher confidence = longer reliable horizon
    // At 100% confidence: 24h reliable
    // At 60% confidence: ~14h reliable
    const baseHorizon = PREDICTION_CONFIG.DEFAULT_RELIABLE_HORIZON;
    const confidenceFactor = Math.max(0.5, confidence);
    return Math.round(baseHorizon * confidenceFactor);
  }

  /**
   * Calculate hourly return from spread
   */
  private calculateHourlyReturn(
    spread: number,
    positionSizeUsd: number,
  ): number {
    // Hourly return = spread * position size
    // Spread is already hourly (funding rate per hour)
    return Math.abs(spread) * positionSizeUsd;
  }

  /**
   * Calculate break-even hours
   */
  private calculateBreakEvenHours(
    totalCosts: number,
    hourlyReturn: number,
  ): number {
    if (hourlyReturn <= PREDICTION_CONFIG.MIN_SPREAD_THRESHOLD * 1000) {
      return Infinity; // Never breaks even
    }

    if (totalCosts <= 0) {
      return 0; // Already profitable
    }

    return totalCosts / hourlyReturn;
  }

  /**
   * Calculate confidence-adjusted break-even
   * Penalizes low-confidence predictions by extending expected break-even
   */
  private calculateConfidenceAdjustedBreakEven(
    breakEvenHours: number,
    confidence: number,
  ): number {
    if (breakEvenHours === Infinity) {
      return Infinity;
    }

    // Low confidence = longer adjusted break-even
    // At 100% confidence: no adjustment
    // At 60% confidence: ~1.67x longer
    // At 50% confidence: 2x longer
    const confidenceFactor = Math.max(0.5, confidence);
    return breakEvenHours / confidenceFactor;
  }

  /**
   * Calculate spread score (0-1)
   */
  private calculateSpreadScore(spread: number): number {
    // Normalize spread to 0-1 score
    // 0.01% spread = 0.5 score, 0.05% = 1.0 score
    const absSpread = Math.abs(spread);
    return Math.min(1, absSpread / 0.0005);
  }

  /**
   * Calculate break-even score (0-1)
   */
  private calculateBreakEvenScore(breakEvenHours: number): number {
    if (breakEvenHours === Infinity) return 0;
    if (breakEvenHours <= 0) return 1;

    // Faster break-even = higher score
    // 0h = 1.0, 24h = 0.5, 168h (7 days) = ~0.1
    return Math.max(0, 1 - breakEvenHours / (24 * 7));
  }

  /**
   * Calculate liquidity score (0-1)
   */
  private calculateLiquidityScore(opportunity: ArbitrageOpportunity): number {
    const longOI = opportunity.longOpenInterest ?? 0;
    const shortOI = opportunity.shortOpenInterest ?? 0;
    const minOI = Math.min(longOI, shortOI);

    if (minOI <= 0) return 0.1; // Low score if no OI data

    // Higher OI = higher liquidity score
    // $1M OI = 0.5 score, $10M = 0.8, $100M = 1.0
    return Math.min(1, Math.log10(Math.max(minOI / 100000, 1)) / 3);
  }

  /**
   * Get recommendation based on score and break-even
   */
  private getRecommendation(
    score: number,
    breakEven: PredictedBreakEven,
    opportunity: ArbitrageOpportunity,
  ): { recommendation: OpportunityScore['recommendation']; reason: string } {
    // Skip if prediction unreliable
    if (!breakEven.isPredictionReliable) {
      return {
        recommendation: 'skip',
        reason: `Prediction confidence ${(breakEven.confidence * 100).toFixed(0)}% below threshold`,
      };
    }

    // Skip if break-even longer than reliable horizon
    if (
      breakEven.confidenceAdjustedBreakEvenHours >
      breakEven.reliableHorizonHours
    ) {
      return {
        recommendation: 'skip',
        reason: `Break-even ${breakEven.confidenceAdjustedBreakEvenHours.toFixed(1)}h exceeds reliable horizon ${breakEven.reliableHorizonHours}h`,
      };
    }

    // Skip if break-even too long
    const maxBreakEvenDays = this.config.maxWorstCaseBreakEvenDays ?? 7;
    if (breakEven.worstCaseBreakEvenHours / 24 > maxBreakEvenDays) {
      return {
        recommendation: 'skip',
        reason: `Worst-case break-even ${(breakEven.worstCaseBreakEvenHours / 24).toFixed(1)} days exceeds max ${maxBreakEvenDays} days`,
      };
    }

    // Strong buy: high score, fast break-even, high confidence
    if (
      score >= 0.7 &&
      breakEven.predictedBreakEvenHours < 24 &&
      breakEven.confidence >= 0.8
    ) {
      return {
        recommendation: 'strong_buy',
        reason: `High score ${score.toFixed(2)}, fast break-even ${breakEven.predictedBreakEvenHours.toFixed(1)}h, high confidence ${(breakEven.confidence * 100).toFixed(0)}%`,
      };
    }

    // Buy: good score, reasonable break-even
    if (score >= 0.5 && breakEven.confidenceAdjustedBreakEvenHours < 72) {
      return {
        recommendation: 'buy',
        reason: `Good score ${score.toFixed(2)}, break-even ${breakEven.confidenceAdjustedBreakEvenHours.toFixed(1)}h`,
      };
    }

    // Hold: marginal opportunity
    if (score >= 0.3) {
      return {
        recommendation: 'hold',
        reason: `Marginal score ${score.toFixed(2)}, consider if no better options`,
      };
    }

    return {
      recommendation: 'skip',
      reason: `Low score ${score.toFixed(2)}`,
    };
  }

  /**
   * Check if prediction service is available
   */
  isPredictionServiceAvailable(): boolean {
    return this.predictionService !== undefined;
  }
}
