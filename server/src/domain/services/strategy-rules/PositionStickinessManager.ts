import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { PerpPosition } from '../../entities/PerpPosition';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { FundingRateAggregator } from '../FundingRateAggregator';

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
 * Position stickiness evaluation result
 */
export interface StickinessEvaluationResult {
  shouldKeep: boolean;
  reason: string;
}

/**
 * Filter result for positions to close
 */
export interface PositionFilterResult {
  toClose: PerpPosition[];
  toKeep: PerpPosition[];
  reasons: Map<string, string>;
}

/**
 * PositionStickinessManager - Prevents unnecessary position churn
 *
 * Evaluates whether existing positions should be kept vs closed and replaced.
 * Considers:
 * - Current funding rate spread
 * - Position age (minimum hold time)
 * - Cost of churning (fees to close + open)
 * - Alternative opportunity quality
 */
@Injectable()
export class PositionStickinessManager {
  private readonly logger = new Logger(PositionStickinessManager.name);

  // Position open time tracking
  private readonly positionOpenTimes: Map<string, Date> = new Map();

  // Default stickiness parameters
  private readonly closeThreshold = -0.0005; // Close if spread drops below -0.05%
  private readonly minHoldHours = 4; // Minimum 4 hours before considering close
  private readonly churnCostMultiplier = 2.0; // Require 2x the churn cost to justify switching

  constructor(
    private readonly strategyConfig: StrategyConfig,
    private readonly aggregator: FundingRateAggregator,
  ) {}

  /**
   * Record when a position pair was opened
   */
  recordPositionOpenTime(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): void {
    const key = this.getPositionKey(symbol, longExchange, shortExchange);
    this.positionOpenTimes.set(key, new Date());
    this.logger.debug(`📝 Recorded position open time for ${key}`);
  }

  /**
   * Remove position open time tracking when position is closed
   */
  removePositionOpenTime(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): void {
    const key = this.getPositionKey(symbol, longExchange, shortExchange);
    this.positionOpenTimes.delete(key);
    this.logger.debug(`🗑️ Removed position open time for ${key}`);
  }

  /**
   * Get hours since position was opened
   * Returns null if position open time is not tracked
   */
  getPositionAgeHours(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): number | null {
    const key = this.getPositionKey(symbol, longExchange, shortExchange);
    const openTime = this.positionOpenTimes.get(key);
    if (!openTime) {
      return null;
    }
    const ageMs = Date.now() - openTime.getTime();
    return ageMs / (1000 * 60 * 60);
  }

  /**
   * Get the current funding rate spread for an existing position pair
   */
  async getCurrentSpreadForPosition(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Promise<number | null> {
    try {
      const rates = await this.aggregator.getFundingRates(symbol);

      const longRate = rates.find((r) => r.exchange === longExchange);
      const shortRate = rates.find((r) => r.exchange === shortExchange);

      if (!longRate || !shortRate) {
        this.logger.debug(
          `Cannot get current spread for ${symbol}: ` +
            `longRate=${longRate?.currentRate ?? 'missing'}, shortRate=${shortRate?.currentRate ?? 'missing'}`,
        );
        return null;
      }

      // Spread = shortRate - longRate
      return shortRate.currentRate - longRate.currentRate;
    } catch (error: any) {
      this.logger.debug(
        `Error getting current spread for ${symbol}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Determine if an existing position should be kept vs closed
   */
  async shouldKeepPosition(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    bestNewOpportunitySpread: number | null,
  ): Promise<StickinessEvaluationResult> {
    const currentSpread = await this.getCurrentSpreadForPosition(
      symbol,
      longExchange,
      shortExchange,
    );
    const positionAgeHours = this.getPositionAgeHours(
      symbol,
      longExchange,
      shortExchange,
    );

    // Calculate churn cost
    const longFeeRate = this.strategyConfig.getExchangeFeeRate(longExchange);
    const shortFeeRate = this.strategyConfig.getExchangeFeeRate(shortExchange);
    const churnCost = (longFeeRate + shortFeeRate) * 2;

    this.logger.debug(
      `🔍 Evaluating position ${symbol} (${longExchange}/${shortExchange}): ` +
        `spread=${currentSpread !== null ? (currentSpread * 100).toFixed(4) + '%' : 'unknown'}, ` +
        `age=${positionAgeHours !== null ? positionAgeHours.toFixed(1) + 'h' : 'unknown'}`,
    );

    // Case 1: Can't get current spread - be conservative and keep
    if (currentSpread === null) {
      return {
        shouldKeep: true,
        reason: `Cannot determine current spread for ${symbol} - keeping position (conservative)`,
      };
    }

    // Case 2: Severely negative spread - CLOSE regardless of age
    const severelyNegativeThreshold = this.closeThreshold * 2;
    if (currentSpread < severelyNegativeThreshold) {
      return {
        shouldKeep: false,
        reason: `${symbol} spread (${(currentSpread * 100).toFixed(4)}%) is severely negative - closing`,
      };
    }

    // Case 3: Below minimum hold time - keep unless spread is negative
    if (positionAgeHours !== null && positionAgeHours < this.minHoldHours) {
      if (currentSpread > 0) {
        return {
          shouldKeep: true,
          reason: `${symbol} is young (${positionAgeHours.toFixed(1)}h) and profitable - keeping`,
        };
      } else if (currentSpread > this.closeThreshold) {
        return {
          shouldKeep: true,
          reason: `${symbol} is young and spread > close threshold - keeping`,
        };
      }
    }

    // Case 4: Spread is above close threshold - keep unless better opportunity
    if (currentSpread > this.closeThreshold) {
      if (bestNewOpportunitySpread !== null) {
        const spreadImprovement = bestNewOpportunitySpread - currentSpread;
        const requiredImprovement = churnCost * this.churnCostMultiplier;

        if (spreadImprovement > requiredImprovement) {
          return {
            shouldKeep: false,
            reason: `${symbol} - new opportunity is ${(spreadImprovement * 100).toFixed(4)}% better, exceeding churn threshold - replacing`,
          };
        }
      }

      return {
        shouldKeep: true,
        reason: `${symbol} spread (${(currentSpread * 100).toFixed(4)}%) > close threshold - keeping`,
      };
    }

    // Case 5: Spread at or below close threshold - close
    return {
      shouldKeep: false,
      reason: `${symbol} spread (${(currentSpread * 100).toFixed(4)}%) <= close threshold - closing`,
    };
  }

  /**
   * Filter positions to close based on stickiness rules
   */
  async filterPositionsToCloseWithStickiness(
    positionsToClose: PerpPosition[],
    existingPositionsBySymbol: Map<string, ExistingPositionPair>,
    bestOpportunitySpread: number | null,
  ): Promise<PositionFilterResult> {
    const toClose: PerpPosition[] = [];
    const toKeep: PerpPosition[] = [];
    const reasons = new Map<string, string>();

    // Group positions by symbol
    const symbolsToEvaluate = new Set<string>();
    for (const position of positionsToClose) {
      symbolsToEvaluate.add(position.symbol);
    }

    for (const symbol of symbolsToEvaluate) {
      const pair = existingPositionsBySymbol.get(symbol);
      if (!pair || !pair.long || !pair.short) {
        // Single-leg position - handled separately
        const positions = positionsToClose.filter((p) => p.symbol === symbol);
        toClose.push(...positions);
        reasons.set(symbol, 'Single-leg position - handled separately');
        continue;
      }

      const { shouldKeep, reason } = await this.shouldKeepPosition(
        symbol,
        pair.long.exchangeType,
        pair.short.exchangeType,
        bestOpportunitySpread,
      );

      reasons.set(symbol, reason);

      const positionsForSymbol = positionsToClose.filter(
        (p) => p.symbol === symbol,
      );
      if (shouldKeep) {
        toKeep.push(...positionsForSymbol);
        this.logger.log(`🔒 KEEPING position ${symbol}: ${reason}`);
      } else {
        toClose.push(...positionsForSymbol);
        this.logger.log(`🔓 CLOSING position ${symbol}: ${reason}`);
      }
    }

    return { toClose, toKeep, reasons };
  }

  /**
   * Get position key for tracking
   */
  private getPositionKey(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): string {
    return `${symbol}-${longExchange}-${shortExchange}`;
  }
}
