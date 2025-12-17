import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { IOpportunityEvaluator } from './IOpportunityEvaluator';
import type { IHistoricalFundingRateService } from '../../ports/IHistoricalFundingRateService';
import { HistoricalMetrics } from '../../ports/IHistoricalFundingRateService';
import { FundingRateAggregator } from '../FundingRateAggregator';
import type { IPositionLossTracker } from '../../ports/IPositionLossTracker';
import type { IFundingRatePredictionService, EnsemblePredictionResult, MarketRegime } from '../../ports/IFundingRatePredictor';
import { CostCalculator } from './CostCalculator';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { PerpPosition } from '../../entities/PerpPosition';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';
import { OrderSide } from '../../value-objects/PerpOrder';
import { PredictedBreakEvenCalculator, PredictedBreakEven, OpportunityScore } from './PredictedBreakEvenCalculator';
import { Percentage } from '../../value-objects/Percentage';

/**
 * Prediction-enhanced opportunity evaluation result
 */
export interface PredictionEnhancedEvaluation {
  /** Standard historical evaluation */
  historicalEvaluation: {
    breakEvenHours: number | null;
    historicalMetrics: { long: HistoricalMetrics | null; short: HistoricalMetrics | null };
    worstCaseBreakEvenHours: number | null;
    consistencyScore: number;
  };
  /** Prediction-based evaluation */
  predictionEvaluation: {
    predictedSpread: number;
    predictionConfidence: number;
    predictedBreakEvenHours: number | null;
    regime: MarketRegime;
    regimeConfidence: number;
  } | null;
  /** Combined score using both historical and prediction data */
  combinedScore: number;
}

/**
 * Opportunity evaluator for funding arbitrage strategy
 * Handles opportunity evaluation with historical data, worst-case selection, and rebalancing decisions
 * Enhanced with ensemble prediction capabilities
 */
@Injectable()
export class OpportunityEvaluator implements IOpportunityEvaluator {
  private readonly logger = new Logger(OpportunityEvaluator.name);

  constructor(
    @Inject('IHistoricalFundingRateService')
    private readonly historicalService: IHistoricalFundingRateService,
    private readonly aggregator: FundingRateAggregator,
    @Inject('IPositionLossTracker')
    private readonly lossTracker: IPositionLossTracker,
    private readonly costCalculator: CostCalculator,
    private readonly config: StrategyConfig,
    @Optional()
    @Inject('IFundingRatePredictionService')
    private readonly predictionService?: IFundingRatePredictionService,
    @Optional()
    private readonly breakEvenCalculator?: PredictedBreakEvenCalculator,
  ) {}

  /**
   * Enrich an opportunity with prediction-based break-even data
   * This is the main entry point for integrating predictions into opportunity discovery
   */
  async enrichOpportunityWithPredictions(
    opportunity: ArbitrageOpportunity,
    positionSizeUsd: number,
    totalCosts: number,
  ): Promise<ArbitrageOpportunity> {
    if (!this.breakEvenCalculator) {
      return opportunity;
    }

    try {
      const [breakEven, score] = await Promise.all([
        this.breakEvenCalculator.calculatePredictedBreakEven(
          opportunity,
          positionSizeUsd,
          totalCosts,
        ),
        this.breakEvenCalculator.scoreOpportunity(
          opportunity,
          positionSizeUsd,
          totalCosts,
        ),
      ]);

      // Enrich opportunity with prediction data
      return {
        ...opportunity,
        predictedSpread: Percentage.fromDecimal(breakEven.predictedSpread),
        predictionConfidence: breakEven.confidence,
        predictedBreakEvenHours: breakEven.confidenceAdjustedBreakEvenHours,
        reliableHorizonHours: breakEven.reliableHorizonHours,
        predictionScore: score.score,
        predictionRecommendation: score.recommendation,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(
        `Failed to enrich ${opportunity.symbol} with predictions: ${message}`,
      );
      return opportunity;
    }
  }

  /**
   * Filter opportunities based on prediction reliability and break-even
   * Returns only opportunities that meet prediction confidence and break-even thresholds
   */
  filterByPredictionQuality(
    opportunities: ArbitrageOpportunity[],
    minConfidence: number = 0.6,
    maxBreakEvenHours: number = 168, // 7 days default
  ): ArbitrageOpportunity[] {
    return opportunities.filter((opp) => {
      // If no prediction data, include opportunity (fallback to historical)
      if (opp.predictionConfidence === undefined) {
        return true;
      }

      // Filter by confidence threshold
      if (opp.predictionConfidence < minConfidence) {
        this.logger.debug(
          `Filtering ${opp.symbol}: confidence ${(opp.predictionConfidence * 100).toFixed(0)}% < ${(minConfidence * 100).toFixed(0)}%`,
        );
        return false;
      }

      // Filter by break-even threshold
      if (
        opp.predictedBreakEvenHours !== undefined &&
        opp.predictedBreakEvenHours > maxBreakEvenHours
      ) {
        this.logger.debug(
          `Filtering ${opp.symbol}: break-even ${opp.predictedBreakEvenHours.toFixed(1)}h > ${maxBreakEvenHours}h`,
        );
        return false;
      }

      // Filter by prediction recommendation
      if (opp.predictionRecommendation === 'skip') {
        this.logger.debug(
          `Filtering ${opp.symbol}: recommendation is 'skip'`,
        );
        return false;
      }

      return true;
    });
  }

  /**
   * Rank opportunities by prediction score
   * Returns opportunities sorted by prediction quality (best first)
   */
  rankByPredictionScore(
    opportunities: ArbitrageOpportunity[],
  ): ArbitrageOpportunity[] {
    return [...opportunities].sort((a, b) => {
      // If both have prediction scores, sort by score
      if (a.predictionScore !== undefined && b.predictionScore !== undefined) {
        return b.predictionScore - a.predictionScore;
      }

      // If only one has prediction score, prefer that one
      if (a.predictionScore !== undefined) return -1;
      if (b.predictionScore !== undefined) return 1;

      // Fallback: sort by current spread
      return b.spread.toDecimal() - a.spread.toDecimal();
    });
  }

  /**
   * Get detailed prediction breakdown for logging/debugging
   */
  async getPredictionBreakdown(
    opportunity: ArbitrageOpportunity,
    positionSizeUsd: number,
    totalCosts: number,
  ): Promise<{
    breakEven: PredictedBreakEven | null;
    score: OpportunityScore | null;
  }> {
    if (!this.breakEvenCalculator) {
      return { breakEven: null, score: null };
    }

    try {
      const [breakEven, score] = await Promise.all([
        this.breakEvenCalculator.calculatePredictedBreakEven(
          opportunity,
          positionSizeUsd,
          totalCosts,
        ),
        this.breakEvenCalculator.scoreOpportunity(
          opportunity,
          positionSizeUsd,
          totalCosts,
        ),
      ]);
      return { breakEven, score };
    } catch {
      return { breakEven: null, score: null };
    }
  }

  evaluateOpportunityWithHistory(
    opportunity: ArbitrageOpportunity,
    plan: ArbitrageExecutionPlan | null,
  ): Result<
    {
      breakEvenHours: number | null;
      historicalMetrics: {
        long: HistoricalMetrics | null;
        short: HistoricalMetrics | null;
      };
      worstCaseBreakEvenHours: number | null;
      consistencyScore: number;
    },
    DomainException
  > {
    const longMetrics = this.historicalService.getHistoricalMetrics(
      opportunity.symbol,
      opportunity.longExchange,
    );
    const shortMetrics = opportunity.shortExchange
      ? this.historicalService.getHistoricalMetrics(
          opportunity.symbol,
          opportunity.shortExchange,
        )
      : null;

    // Calculate consistency score (average of both exchanges)
    const consistencyScore =
      longMetrics && shortMetrics
        ? (longMetrics.consistencyScore + shortMetrics.consistencyScore) / 2
        : longMetrics?.consistencyScore || shortMetrics?.consistencyScore || 0;

    // Calculate worst-case break-even using minimum historical rates
    let worstCaseBreakEvenHours: number | null = null;
    if (plan && longMetrics && shortMetrics) {
      const periodsPerYear = 24 * 365;
      const worstCaseLongRate = longMetrics.minRate;
      const worstCaseShortRate = shortMetrics.minRate;
      const worstCaseSpread = Math.abs(worstCaseShortRate - worstCaseLongRate);
      const worstCaseAPY = worstCaseSpread * periodsPerYear;

      const avgMarkPrice =
        opportunity.longMarkPrice && opportunity.shortMarkPrice
          ? (opportunity.longMarkPrice + opportunity.shortMarkPrice) / 2
          : opportunity.longMarkPrice || opportunity.shortMarkPrice || 0;
      const positionSizeUsd = plan.positionSize.toUSD(avgMarkPrice);
      const worstCaseHourlyReturn =
        (worstCaseAPY / periodsPerYear) * positionSizeUsd;

      if (worstCaseHourlyReturn > 0) {
        const totalCosts = plan.estimatedCosts.total;
        worstCaseBreakEvenHours = totalCosts / worstCaseHourlyReturn;
      }
    }

    return Result.success({
      breakEvenHours: plan ? null : (opportunity as any).breakEvenHours || null,
      historicalMetrics: {
        long: longMetrics,
        short: shortMetrics,
      },
      worstCaseBreakEvenHours,
      consistencyScore,
    });
  }

  async selectWorstCaseOpportunity(
    allOpportunities: Array<{
      opportunity: ArbitrageOpportunity;
      plan:
        | ArbitrageExecutionPlan
        | import('./PerpSpotExecutionPlanBuilder').PerpSpotExecutionPlan
        | null;
      netReturn: number;
      positionValueUsd: number;
      breakEvenHours: number | null;
    }>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    maxPositionSizeUsd: number | undefined,
    exchangeBalances: Map<ExchangeType, number>,
  ): Promise<
    Result<
      {
        opportunity: ArbitrageOpportunity;
        plan:
          | ArbitrageExecutionPlan
          | import('./PerpSpotExecutionPlanBuilder').PerpSpotExecutionPlan;
        reason: string;
      } | null,
      DomainException
    >
  > {
    if (allOpportunities.length === 0) {
      return Result.success(null);
    }

    // Evaluate all opportunities with historical metrics
    const evaluated: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan | null;
      historical: ReturnType<typeof this.evaluateOpportunityWithHistory>;
      score: number;
    }> = [];

    for (const item of allOpportunities) {
      if (!item.plan) continue; // Skip if no plan

      // Skip perp-spot plans (not supported for worst-case selection)
      if ('perpOrder' in item.plan && 'spotOrder' in item.plan) {
        continue;
      }

      const historicalResult = this.evaluateOpportunityWithHistory(
        item.opportunity,
        item.plan as ArbitrageExecutionPlan,
      );
      if (historicalResult.isFailure) {
        this.logger.warn(
          `Failed to evaluate opportunity ${item.opportunity.symbol}: ${historicalResult.error.message}`,
        );
        continue;
      }
      const historical = historicalResult.value;

      // Calculate score: (consistencyScore * avgHistoricalRate * liquidity) / worstCaseBreakEvenHours
      // Higher score = better worst-case opportunity
      const longMetrics = historical.historicalMetrics.long;
      const shortMetrics = historical.historicalMetrics.short;
      const avgHistoricalRate =
        longMetrics && shortMetrics
          ? (longMetrics.averageRate + shortMetrics.averageRate) / 2
          : 0;

      // Use open interest as liquidity proxy
      const longOI = item.opportunity.longOpenInterest || 0;
      const shortOI = item.opportunity.shortOpenInterest || 0;
      const minOI = Math.min(longOI, shortOI);
      // Normalize liquidity score: 0-1 scale based on OI (higher OI = better liquidity)
      const liquidity =
        minOI > 0
          ? Math.min(1, Math.max(0, Math.log10(Math.max(minOI / 1000, 1)) / 10))
          : 0.1; // Default low liquidity score if OI unavailable

      const worstCaseBreakEven = historical.worstCaseBreakEvenHours || Infinity;
      const score =
        worstCaseBreakEven < Infinity && worstCaseBreakEven > 0
          ? (historical.consistencyScore *
              Math.abs(avgHistoricalRate) *
              liquidity) /
            worstCaseBreakEven
          : 0;

      evaluated.push({
        opportunity: item.opportunity,
        plan: item.plan,
        historical,
        score,
      });
    }

    if (evaluated.length === 0) {
      return Result.success(null);
    }

    // Sort by score (highest first)
    evaluated.sort((a, b) => b.score - a.score);
    const best = evaluated[0];

    // Only select if worst-case break-even is reasonable
    const worstCaseBreakEvenDays = best.historical.worstCaseBreakEvenHours
      ? best.historical.worstCaseBreakEvenHours / 24
      : Infinity;

    if (worstCaseBreakEvenDays > this.config.maxWorstCaseBreakEvenDays) {
      this.logger.warn(
        `Worst-case opportunity has break-even > ${this.config.maxWorstCaseBreakEvenDays} days, skipping`,
      );
      return Result.success(null);
    }

    const reason =
      `Worst-case scenario selection: ` +
      `Consistency: ${(best.historical.consistencyScore * 100).toFixed(1)}%, ` +
      `Worst-case break-even: ${worstCaseBreakEvenDays.toFixed(1)} days, ` +
      `Score: ${best.score.toFixed(4)}`;

    this.logger.log(
      `🎯 Selected WORST-CASE opportunity: ${best.opportunity.symbol} - ${reason}`,
    );

    return Result.success({
      opportunity: best.opportunity,
      plan: best.plan!,
      reason,
    });
  }

  async shouldRebalance(
    currentPosition: PerpPosition,
    newOpportunity: ArbitrageOpportunity,
    newPlan: ArbitrageExecutionPlan,
    cumulativeLoss: number,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<
    Result<
      {
        shouldRebalance: boolean;
        reason: string;
        currentBreakEvenHours: number | null;
        newBreakEvenHours: number | null;
      },
      DomainException
    >
  > {
    // Get current position's funding rate
    let currentFundingRate = 0;
    try {
      const rates = await this.aggregator.getFundingRates(
        currentPosition.symbol,
      );
      const currentRate = rates.find(
        (r) => r.exchange === currentPosition.exchangeType,
      );
      if (currentRate) {
        currentFundingRate =
          currentPosition.side === OrderSide.LONG
            ? currentRate.currentRate
            : -currentRate.currentRate; // Flip for SHORT
      }
    } catch (error: any) {
      this.logger.debug(
        `Failed to get funding rate for current position: ${error.message}`,
      );
    }

    const avgMarkPrice = currentPosition.markPrice || 0;
    const positionValueUsd = currentPosition.size * avgMarkPrice;

    // Get current position's remaining break-even hours
    const currentBreakEvenData = this.lossTracker.getRemainingBreakEvenHours(
      currentPosition,
      currentFundingRate,
      positionValueUsd,
    );

    // Handle case where position was already closed
    const isPositionClosed =
      currentBreakEvenData.remainingBreakEvenHours === Infinity &&
      currentBreakEvenData.remainingCost === Infinity &&
      currentBreakEvenData.hoursHeld === 0;

    const currentBreakEvenHours =
      currentBreakEvenData.remainingBreakEvenHours === Infinity
        ? Infinity
        : currentBreakEvenData.remainingBreakEvenHours;

    // If position was already closed, treat it as if we have no outstanding costs
    const p1FeesOutstanding = isPositionClosed
      ? 0
      : currentBreakEvenData.remainingCost;

    // Calculate new position's hourly return
    const periodsPerYear = 24 * 365;
    const newPositionSizeUsd = newPlan.positionSize.toUSD(avgMarkPrice);
    const newHourlyReturn =
      (newOpportunity.expectedReturn.toDecimal() / periodsPerYear) *
      newPositionSizeUsd;

    // Calculate P2 costs (entry fees + exit fees + slippage)
    const p2EntryFees = newPlan.estimatedCosts.fees / 2; // Entry is half of total fees
    const p2ExitFees = newPlan.estimatedCosts.fees / 2; // Exit is half of total fees
    const p2Slippage = newPlan.estimatedCosts.slippage; // Slippage cost

    // Total costs for P2 = P1 fees outstanding + P2 entry fees + P2 exit fees + P2 slippage
    const totalCostsP2 =
      p1FeesOutstanding + p2EntryFees + p2ExitFees + p2Slippage;

    // Note: Switching costs are calculated above (totalCostsP2)
    // This includes P1 fees outstanding + P2 entry/exit fees + P2 slippage

    // Calculate P2 time-to-break-even with all costs
    let p2TimeToBreakEven: number;
    if (newHourlyReturn <= 0) {
      p2TimeToBreakEven = Infinity;
    } else {
      p2TimeToBreakEven = totalCostsP2 / newHourlyReturn;
    }

    // Edge case 1: New position is instantly profitable
    if (newPlan.expectedNetReturn > 0) {
      this.logger.log(
        `✅ Rebalancing approved: New opportunity is instantly profitable ` +
          `(net return: $${newPlan.expectedNetReturn.toFixed(4)}/period)`,
      );
      return Result.success({
        shouldRebalance: true,
        reason: 'New opportunity is instantly profitable',
        currentBreakEvenHours:
          currentBreakEvenHours === Infinity ? null : currentBreakEvenHours,
        newBreakEvenHours: null, // Not applicable for profitable positions
      });
    }

    // Edge case 2: Current position already profitable
    if (currentBreakEvenData.remainingCost <= 0) {
      this.logger.log(
        `⏸️  Skipping rebalance: Current position already profitable ` +
          `(fees earned: $${currentBreakEvenData.feesEarnedSoFar.toFixed(4)} > costs: $${(currentBreakEvenData.remainingCost + currentBreakEvenData.feesEarnedSoFar).toFixed(4)})`,
      );
      return Result.success({
        shouldRebalance: false,
        reason:
          'Current position already profitable, new position not instantly profitable',
        currentBreakEvenHours: 0,
        newBreakEvenHours:
          p2TimeToBreakEven === Infinity ? null : p2TimeToBreakEven,
      });
    }

    // Edge case 3: Current position never breaks even
    if (currentBreakEvenHours === Infinity) {
      // Current position never breaks even, always rebalance if new one is better
      if (p2TimeToBreakEven < Infinity) {
        this.logger.log(
          `✅ Rebalancing approved: Current position never breaks even, ` +
            `new position has finite TTBE (${p2TimeToBreakEven.toFixed(2)}h)`,
        );
        return Result.success({
          shouldRebalance: true,
          reason:
            'Current position never breaks even, new position has finite break-even time',
          currentBreakEvenHours: null,
          newBreakEvenHours: p2TimeToBreakEven,
        });
      }
      // Both never break even - avoid churn
      this.logger.log(
        `⏸️  Skipping rebalance: Both positions never break even (avoiding churn)`,
      );
      return Result.success({
        shouldRebalance: false,
        reason: 'Both positions never break even',
        currentBreakEvenHours: null,
        newBreakEvenHours: null,
      });
    }

    // Edge case 4: New position never breaks even
    if (p2TimeToBreakEven === Infinity) {
      this.logger.log(
        `⏸️  Skipping rebalance: New position never breaks even ` +
          `(P1 remaining TTBE: ${currentBreakEvenHours.toFixed(2)}h)`,
      );
      return Result.success({
        shouldRebalance: false,
        reason: 'New position never breaks even',
        currentBreakEvenHours,
        newBreakEvenHours: null,
      });
    }

    // Main comparison: Compare P2 TTBE (with all costs) vs P1 remaining TTBE
    if (p2TimeToBreakEven < currentBreakEvenHours) {
      const hoursSaved = currentBreakEvenHours - p2TimeToBreakEven;
      const improvementPercent =
        ((currentBreakEvenHours - p2TimeToBreakEven) / currentBreakEvenHours) *
        100;

      this.logger.log(
        `✅ Rebalancing approved: P2 TTBE (${p2TimeToBreakEven.toFixed(2)}h) < P1 remaining TTBE (${currentBreakEvenHours.toFixed(2)}h) ` +
          `→ saves ${hoursSaved.toFixed(2)}h (${improvementPercent.toFixed(1)}% faster)`,
      );
      return Result.success({
        shouldRebalance: true,
        reason: `P2 TTBE (${p2TimeToBreakEven.toFixed(2)}h) < P1 remaining TTBE (${currentBreakEvenHours.toFixed(2)}h) - saves ${hoursSaved.toFixed(2)}h`,
        currentBreakEvenHours,
        newBreakEvenHours: p2TimeToBreakEven,
      });
    }

    // Not worth switching - P1 will break even faster
    const hoursLost = p2TimeToBreakEven - currentBreakEvenHours;
    this.logger.log(
      `⏸️  Skipping rebalance: P1 remaining TTBE (${currentBreakEvenHours.toFixed(2)}h) < P2 TTBE (${p2TimeToBreakEven.toFixed(2)}h) ` +
        `→ would lose ${hoursLost.toFixed(2)}h`,
    );
    return Result.success({
      shouldRebalance: false,
      reason: `P1 remaining TTBE (${currentBreakEvenHours.toFixed(2)}h) < P2 TTBE (${p2TimeToBreakEven.toFixed(2)}h)`,
      currentBreakEvenHours,
      newBreakEvenHours: p2TimeToBreakEven,
    });
  }

  /**
   * Evaluate opportunity using ensemble predictions
   * Combines historical analysis with forward-looking predictions
   */
  async evaluateWithPredictions(
    opportunity: ArbitrageOpportunity,
    plan: ArbitrageExecutionPlan | null,
  ): Promise<Result<PredictionEnhancedEvaluation, DomainException>> {
    // Get standard historical evaluation
    const historicalResult = this.evaluateOpportunityWithHistory(opportunity, plan);
    if (historicalResult.isFailure) {
      return Result.failure(historicalResult.error);
    }
    const historicalEvaluation = historicalResult.value;

    // Get prediction evaluation if service is available
    let predictionEvaluation: PredictionEnhancedEvaluation['predictionEvaluation'] = null;

    if (this.predictionService && opportunity.shortExchange) {
      try {
        const spreadPrediction = await this.predictionService.getSpreadPrediction(
          opportunity.symbol,
          opportunity.longExchange,
          opportunity.shortExchange,
        );

        // Calculate predicted break-even hours
        let predictedBreakEvenHours: number | null = null;
        if (plan && spreadPrediction.predictedSpread !== 0) {
          const periodsPerYear = 24 * 365;
          const predictedAPY = Math.abs(spreadPrediction.predictedSpread) * periodsPerYear;

          const avgMarkPrice =
            opportunity.longMarkPrice && opportunity.shortMarkPrice
              ? (opportunity.longMarkPrice + opportunity.shortMarkPrice) / 2
              : opportunity.longMarkPrice || opportunity.shortMarkPrice || 0;
          const positionSizeUsd = plan.positionSize.toUSD(avgMarkPrice);
          const predictedHourlyReturn = (predictedAPY / periodsPerYear) * positionSizeUsd;

          if (predictedHourlyReturn > 0) {
            predictedBreakEvenHours = plan.estimatedCosts.total / predictedHourlyReturn;
          }
        }

        predictionEvaluation = {
          predictedSpread: spreadPrediction.predictedSpread,
          predictionConfidence: spreadPrediction.confidence,
          predictedBreakEvenHours,
          regime: spreadPrediction.longPrediction.regime,
          regimeConfidence: spreadPrediction.longPrediction.regimeConfidence,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.debug(
          `Prediction service unavailable for ${opportunity.symbol}: ${message}`,
        );
      }
    }

    // Calculate combined score
    const combinedScore = this.calculateCombinedScore(
      historicalEvaluation,
      predictionEvaluation,
    );

    return Result.success({
      historicalEvaluation,
      predictionEvaluation,
      combinedScore,
    });
  }

  /**
   * Calculate combined score from historical and prediction data
   * Weights prediction more heavily when confidence is high
   */
  private calculateCombinedScore(
    historical: PredictionEnhancedEvaluation['historicalEvaluation'],
    prediction: PredictionEnhancedEvaluation['predictionEvaluation'],
  ): number {
    // Base score from historical consistency
    let score = historical.consistencyScore;

    // Adjust for worst-case break-even (lower is better)
    if (historical.worstCaseBreakEvenHours && historical.worstCaseBreakEvenHours < Infinity) {
      const breakEvenFactor = Math.max(0, 1 - historical.worstCaseBreakEvenHours / (24 * 7));
      score *= 0.7 + 0.3 * breakEvenFactor;
    }

    // Incorporate prediction if available and confident
    if (prediction && prediction.predictionConfidence > 0.5) {
      const predictionWeight = prediction.predictionConfidence * 0.4;
      const historicalWeight = 1 - predictionWeight;

      // Prediction score based on predicted spread magnitude and break-even
      let predictionScore = Math.min(1, Math.abs(prediction.predictedSpread) * 10000);
      if (prediction.predictedBreakEvenHours && prediction.predictedBreakEvenHours < Infinity) {
        const predBreakEvenFactor = Math.max(0, 1 - prediction.predictedBreakEvenHours / (24 * 7));
        predictionScore *= 0.7 + 0.3 * predBreakEvenFactor;
      }

      // Regime adjustment
      if (prediction.regime === 'mean_reverting') {
        predictionScore *= 1.1; // Boost for favorable regime
      } else if (prediction.regime === 'extreme_dislocation') {
        predictionScore *= 0.8; // Reduce for risky regime
      }

      score = historicalWeight * score + predictionWeight * predictionScore;
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Select best opportunity using prediction-enhanced evaluation
   */
  async selectBestOpportunityWithPredictions(
    allOpportunities: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan | null;
      netReturn: number;
      positionValueUsd: number;
      breakEvenHours: number | null;
    }>,
  ): Promise<
    Result<
      {
        opportunity: ArbitrageOpportunity;
        plan: ArbitrageExecutionPlan;
        evaluation: PredictionEnhancedEvaluation;
        reason: string;
      } | null,
      DomainException
    >
  > {
    if (allOpportunities.length === 0) {
      return Result.success(null);
    }

    const evaluated: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan;
      evaluation: PredictionEnhancedEvaluation;
    }> = [];

    // Evaluate all opportunities with predictions
    for (const item of allOpportunities) {
      if (!item.plan) continue;
      if ('perpOrder' in item.plan && 'spotOrder' in item.plan) continue;

      const evalResult = await this.evaluateWithPredictions(
        item.opportunity,
        item.plan as ArbitrageExecutionPlan,
      );

      if (evalResult.isSuccess) {
        evaluated.push({
          opportunity: item.opportunity,
          plan: item.plan as ArbitrageExecutionPlan,
          evaluation: evalResult.value,
        });
      }
    }

    if (evaluated.length === 0) {
      return Result.success(null);
    }

    // Sort by combined score (highest first)
    evaluated.sort((a, b) => b.evaluation.combinedScore - a.evaluation.combinedScore);
    const best = evaluated[0];

    // Build reason string
    const reason = this.buildSelectionReason(best.evaluation);

    this.logger.log(
      `🎯 Selected opportunity: ${best.opportunity.symbol} - ${reason}`,
    );

    return Result.success({
      opportunity: best.opportunity,
      plan: best.plan,
      evaluation: best.evaluation,
      reason,
    });
  }

  /**
   * Build human-readable reason for opportunity selection
   */
  private buildSelectionReason(evaluation: PredictionEnhancedEvaluation): string {
    const parts: string[] = [];

    parts.push(`Combined score: ${(evaluation.combinedScore * 100).toFixed(1)}%`);
    parts.push(`Consistency: ${(evaluation.historicalEvaluation.consistencyScore * 100).toFixed(1)}%`);

    if (evaluation.historicalEvaluation.worstCaseBreakEvenHours) {
      parts.push(
        `Worst-case BE: ${(evaluation.historicalEvaluation.worstCaseBreakEvenHours / 24).toFixed(1)}d`,
      );
    }

    if (evaluation.predictionEvaluation) {
      parts.push(
        `Predicted spread: ${(evaluation.predictionEvaluation.predictedSpread * 100).toFixed(4)}%`,
      );
      parts.push(`Regime: ${evaluation.predictionEvaluation.regime}`);
      parts.push(
        `Prediction confidence: ${(evaluation.predictionEvaluation.predictionConfidence * 100).toFixed(0)}%`,
      );
    }

    return parts.join(', ');
  }
}
