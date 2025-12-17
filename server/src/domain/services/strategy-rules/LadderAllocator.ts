import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { PerpSpotExecutionPlan } from './PerpSpotExecutionPlanBuilder';
import { PerpPosition } from '../../entities/PerpPosition';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';

/**
 * Evaluated opportunity with calculated metrics
 */
export interface EvaluatedOpportunity {
  opportunity: ArbitrageOpportunity;
  plan: ArbitrageExecutionPlan | PerpSpotExecutionPlan | null;
  netReturn: number;
  positionValueUsd: number;
  breakEvenHours: number | null;
  maxPortfolioFor35APY: number | null;
  optimalLeverage: number | null;
  longBidAsk: { bestBid: number; bestAsk: number } | null;
  shortBidAsk: { bestBid: number; bestAsk: number } | null;
}

/**
 * Selected opportunity for execution
 */
export interface SelectedOpportunity {
  opportunity: ArbitrageOpportunity;
  plan: ArbitrageExecutionPlan | PerpSpotExecutionPlan | null;
  maxPortfolioFor35APY: number | null;
  isExisting: boolean;
  currentValue?: number;
  currentCollateral?: number;
  additionalCollateralNeeded?: number;
}

/**
 * Existing position pair info
 */
export interface ExistingPositionPair {
  long?: PerpPosition;
  short?: PerpPosition;
  currentValue: number;
  currentCollateral: number;
}

/**
 * Ladder allocation result
 */
export interface LadderAllocationResult {
  selectedOpportunities: SelectedOpportunity[];
  remainingCapital: number;
  cumulativeCapitalUsed: number;
}

/**
 * LadderAllocator - Handles ladder-style portfolio allocation
 *
 * Implements greedy allocation strategy:
 * 1. Top up existing positions first
 * 2. Fill new positions sequentially until capital exhausted
 * 3. Each position is maxed out before moving to next
 */
@Injectable()
export class LadderAllocator {
  private readonly logger = new Logger(LadderAllocator.name);

  constructor(private readonly strategyConfig: StrategyConfig) {}

  /**
   * Filter opportunities for ladder execution
   * Removes filtered opportunities and ensures minimum balance requirements
   */
  filterOpportunitiesForLadder(
    evaluatedOpportunities: EvaluatedOpportunity[],
    exchangeBalances: Map<ExchangeType, number>,
    filteredOpportunities: Map<string, Date>,
    filterExpiryMs: number,
    maxBreakEvenHours: number,
    leverage: number,
  ): EvaluatedOpportunity[] {
    const now = Date.now();

    return evaluatedOpportunities
      .filter((item) => {
        // Filter out opportunities that are marked as filtered (failed after retries)
        const filterKey = this.getFilterKey(
          item.opportunity.symbol,
          item.opportunity.longExchange,
          item.opportunity.shortExchange!,
        );
        const filteredTime = filteredOpportunities.get(filterKey);
        if (filteredTime) {
          const timeSinceFilter = now - filteredTime.getTime();
          if (timeSinceFilter < filterExpiryMs) {
            const remainingMinutes = Math.ceil(
              (filterExpiryMs - timeSinceFilter) / 60000,
            );
            this.logger.debug(
              `Skipping filtered opportunity ${item.opportunity.symbol} - retry in ${remainingMinutes}m`,
            );
            return false;
          }
        }

        // Must have a valid execution plan OR acceptable break-even time
        const hasValidPlan = item.plan !== null;
        const hasAcceptableBreakEven =
          item.plan === null &&
          item.breakEvenHours !== null &&
          isFinite(item.breakEvenHours) &&
          item.breakEvenHours <= maxBreakEvenHours &&
          item.netReturn > -Infinity;

        if (!hasValidPlan && !hasAcceptableBreakEven) {
          return false;
        }

        // Check if we have ANY balance on BOTH exchanges
        const minPositionCollateral =
          this.strategyConfig.minPositionSizeUsd / leverage;
        const longBalance =
          exchangeBalances.get(item.opportunity.longExchange) ?? 0;
        const shortBalance = item.opportunity.shortExchange
          ? (exchangeBalances.get(item.opportunity.shortExchange) ?? 0)
          : 0;

        return (
          longBalance >= minPositionCollateral &&
          shortBalance >= minPositionCollateral
        );
      })
      .sort((a, b) => {
        // Sort by expected return (highest APY first)
        const returnDiff =
          (b.opportunity.expectedReturn?.toAPY() || 0) -
          (a.opportunity.expectedReturn?.toAPY() || 0);
        if (Math.abs(returnDiff) > 0.001) return returnDiff;
        // Then by maxPortfolio as tiebreaker
        const aMax = a.maxPortfolioFor35APY ?? Infinity;
        const bMax = b.maxPortfolioFor35APY ?? Infinity;
        return bMax - aMax;
      });
  }

  /**
   * Allocate capital using ladder strategy
   *
   * Ladder allocation fills positions sequentially:
   * - Position 1: $0 to position1Max
   * - Position 2: position1Max+1 to position2Max
   * - etc.
   */
  allocateLadder(
    ladderOpportunities: EvaluatedOpportunity[],
    existingPositionsBySymbol: Map<string, ExistingPositionPair>,
    totalAvailableCapital: number,
    leverage: number,
  ): Result<LadderAllocationResult, DomainException> {
    const selectedOpportunities: SelectedOpportunity[] = [];
    let remainingCapital = totalAvailableCapital;
    let cumulativeCapitalUsed = 0;

    this.logger.log(
      `\n📊 Ladder Allocation: $${totalAvailableCapital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} capital, ` +
        `${existingPositionsBySymbol.size} existing position(s)`,
    );

    for (let i = 0; i < ladderOpportunities.length; i++) {
      const item = ladderOpportunities[i];
      const symbol = item.opportunity.symbol;
      const existingPair = existingPositionsBySymbol.get(symbol);

      // If maxPortfolioFor35APY is null, use remaining capital as the cap
      const maxPortfolio =
        item.maxPortfolioFor35APY ?? remainingCapital * leverage;
      const maxCollateral = maxPortfolio / leverage;

      // Check if existing positions match the opportunity's exchange pair
      const existingMatchesOpportunity =
        existingPair &&
        existingPair.currentCollateral > 0 &&
        existingPair.long?.exchangeType === item.opportunity.longExchange &&
        existingPair.short?.exchangeType === item.opportunity.shortExchange;

      if (existingMatchesOpportunity) {
        // Top up existing position
        const result = this.handleExistingPosition(
          item,
          existingPair,
          maxCollateral,
          remainingCapital,
          cumulativeCapitalUsed,
          leverage,
        );

        if (result.selected) {
          selectedOpportunities.push(result.selected);
          remainingCapital = result.remainingCapital;
          cumulativeCapitalUsed = result.cumulativeCapitalUsed;

          if (!result.continueToNext) {
            break;
          }
        } else {
          cumulativeCapitalUsed += maxCollateral;
        }
      } else if (existingPair && existingPair.currentCollateral > 0) {
        // Existing positions don't match - skip to avoid third leg
        this.logger.warn(
          `⚠️ Skipping ${symbol}: Existing positions don't match opportunity's exchange pair`,
        );
        cumulativeCapitalUsed += maxCollateral;
      } else {
        // New position
        const result = this.handleNewPosition(
          item,
          maxCollateral,
          remainingCapital,
          cumulativeCapitalUsed,
          leverage,
        );

        if (result.selected) {
          selectedOpportunities.push(result.selected);
          remainingCapital = result.remainingCapital;
          cumulativeCapitalUsed = result.cumulativeCapitalUsed;

          if (!result.continueToNext) {
            break;
          }
        } else {
          break;
        }
      }
    }

    return Result.success({
      selectedOpportunities,
      remainingCapital,
      cumulativeCapitalUsed,
    });
  }

  /**
   * Handle allocation for existing position (top-up)
   */
  private handleExistingPosition(
    item: EvaluatedOpportunity,
    existingPair: ExistingPositionPair,
    maxCollateral: number,
    remainingCapital: number,
    cumulativeCapitalUsed: number,
    leverage: number,
  ): {
    selected: SelectedOpportunity | null;
    remainingCapital: number;
    cumulativeCapitalUsed: number;
    continueToNext: boolean;
  } {
    const symbol = item.opportunity.symbol;
    const currentCollateral = existingPair.currentCollateral;
    const additionalCollateralNeeded = maxCollateral - currentCollateral;

    if (additionalCollateralNeeded <= 0.01) {
      // Position is already at or above max
      return {
        selected: null,
        remainingCapital,
        cumulativeCapitalUsed: cumulativeCapitalUsed + maxCollateral,
        continueToNext: true,
      };
    }

    const topUpAmount = Math.min(additionalCollateralNeeded, remainingCapital);

    if (topUpAmount < 0.01) {
      // Can't top up even $0.01
      return {
        selected: null,
        remainingCapital,
        cumulativeCapitalUsed,
        continueToNext: false,
      };
    }

    const scaledMaxPortfolio = (currentCollateral + topUpAmount) * leverage;
    const isFullyFilled = topUpAmount >= additionalCollateralNeeded - 0.01;

    this.logger.log(
      `   🔼 ${symbol}: Adding $${topUpAmount.toFixed(2)} ` +
        `(${isFullyFilled ? 'FULL' : 'PARTIAL'}) | Remaining: $${(remainingCapital - topUpAmount).toFixed(2)}`,
    );

    return {
      selected: {
        opportunity: item.opportunity,
        plan: item.plan,
        maxPortfolioFor35APY: scaledMaxPortfolio,
        isExisting: true,
        currentValue: existingPair.currentValue,
        currentCollateral,
        additionalCollateralNeeded: topUpAmount,
      },
      remainingCapital: remainingCapital - topUpAmount,
      cumulativeCapitalUsed: isFullyFilled
        ? cumulativeCapitalUsed + maxCollateral
        : cumulativeCapitalUsed + topUpAmount,
      continueToNext: isFullyFilled,
    };
  }

  /**
   * Handle allocation for new position
   */
  private handleNewPosition(
    item: EvaluatedOpportunity,
    maxCollateral: number,
    remainingCapital: number,
    cumulativeCapitalUsed: number,
    leverage: number,
  ): {
    selected: SelectedOpportunity | null;
    remainingCapital: number;
    cumulativeCapitalUsed: number;
    continueToNext: boolean;
  } {
    const symbol = item.opportunity.symbol;

    if (remainingCapital <= 0.01) {
      return {
        selected: null,
        remainingCapital,
        cumulativeCapitalUsed,
        continueToNext: false,
      };
    }

    const partialCollateral = Math.min(remainingCapital, maxCollateral);
    const partialMaxPortfolio = partialCollateral * leverage;
    const isFullyFilled = partialCollateral >= maxCollateral - 0.01;

    this.logger.log(
      `   ${isFullyFilled ? '✅' : '🔄'} ${symbol}: NEW $${partialMaxPortfolio.toFixed(2)} ` +
        `($${partialCollateral.toFixed(2)}/${maxCollateral.toFixed(2)} collateral, ${isFullyFilled ? 'FULL' : 'PARTIAL'}) | ` +
        `Remaining: $${(remainingCapital - partialCollateral).toFixed(2)}`,
    );

    return {
      selected: {
        opportunity: item.opportunity,
        plan: item.plan,
        maxPortfolioFor35APY: partialMaxPortfolio,
        isExisting: false,
        additionalCollateralNeeded: partialCollateral,
      },
      remainingCapital: remainingCapital - partialCollateral,
      cumulativeCapitalUsed: cumulativeCapitalUsed + partialCollateral,
      continueToNext: isFullyFilled,
    };
  }

  /**
   * Get filter key for opportunity tracking
   */
  private getFilterKey(
    symbol: string,
    exchange1: ExchangeType,
    exchange2: ExchangeType,
  ): string {
    const exchanges = [exchange1, exchange2].sort();
    return `${symbol}-${exchanges[0]}-${exchanges[1]}`;
  }
}
