import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { ArbitrageOpportunity, FundingRateAggregator } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { PerpSpotExecutionPlan } from './PerpSpotExecutionPlanBuilder';
import { PerpPosition } from '../../entities/PerpPosition';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import type { IPositionLossTracker } from '../../ports/IPositionLossTracker';

/**
 * Opportunity with execution plan
 */
export interface OpportunityWithPlan {
  opportunity: ArbitrageOpportunity;
  plan: ArbitrageExecutionPlan | PerpSpotExecutionPlan | null;
  maxPortfolioFor35APY: number | null;
}

/**
 * PerformanceMetricsLogger - Logs comprehensive performance metrics
 * 
 * Generates detailed reports on:
 * - Position details (long/short pairs)
 * - Break-even analysis
 * - Cost breakdown
 * - P&L summary
 * - Portfolio totals
 */
@Injectable()
export class PerformanceMetricsLogger {
  private readonly logger = new Logger(PerformanceMetricsLogger.name);

  constructor(
    private readonly aggregator: FundingRateAggregator,
    private readonly lossTracker: IPositionLossTracker,
  ) {}

  /**
   * Log comprehensive performance metrics for all positions
   */
  async logComprehensivePerformanceMetrics(
    opportunities: OpportunityWithPlan[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    successfulExecutions: number,
    leverage: number,
  ): Promise<void> {
    if (successfulExecutions === 0) {
      return;
    }

    this.logger.log(
      '\n═══════════════════════════════════════════════════════════════════════════════',
    );
    this.logger.log('📊 COMPREHENSIVE PERFORMANCE METRICS');
    this.logger.log(
      '═══════════════════════════════════════════════════════════════════════════════\n',
    );

    // Get all current positions
    const allPositions = await this.getAllPositions(adapters);

    if (allPositions.length === 0) {
      this.logger.log(
        '⚠️ No positions found - metrics will be available after positions are opened',
      );
      return;
    }

    // Get funding rates for all symbols
    const symbols = new Set<string>();
    allPositions.forEach((pos) => symbols.add(pos.symbol));
    const allFundingRates = await this.getFundingRatesForSymbols(symbols);

    // Group positions by symbol
    const positionsBySymbol = this.groupPositionsBySymbol(allPositions);

    // Calculate and log metrics
    const totals = await this.calculateAndLogPositionMetrics(
      positionsBySymbol,
      opportunities,
      allFundingRates,
      leverage,
    );

    // Log portfolio summary
    this.logPortfolioSummary(totals, positionsBySymbol.size, allPositions.length, leverage);
  }

  /**
   * Get all positions from all adapters
   */
  private async getAllPositions(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<PerpPosition[]> {
    const allPositions: PerpPosition[] = [];

    for (const [exchange, adapter] of adapters) {
      try {
        const positions = await adapter.getPositions();
        allPositions.push(...positions);
      } catch (error: any) {
        this.logger.debug(`Failed to get positions from ${exchange}: ${error.message}`);
      }
    }

    return allPositions;
  }

  /**
   * Get funding rates for all symbols
   */
  private async getFundingRatesForSymbols(
    symbols: Set<string>,
  ): Promise<Map<string, Map<ExchangeType, number>>> {
    const allFundingRates = new Map<string, Map<ExchangeType, number>>();

    for (const symbol of symbols) {
      try {
        const rates = await this.aggregator.getFundingRates(symbol);
        const rateMap = new Map<ExchangeType, number>();
        rates.forEach((rate) => {
          rateMap.set(rate.exchange, rate.currentRate);
        });
        allFundingRates.set(symbol, rateMap);
      } catch (error: any) {
        this.logger.debug(`Failed to get funding rates for ${symbol}: ${error.message}`);
      }
    }

    return allFundingRates;
  }

  /**
   * Group positions by symbol
   */
  private groupPositionsBySymbol(
    positions: PerpPosition[],
  ): Map<string, { long?: PerpPosition; short?: PerpPosition }> {
    const positionsBySymbol = new Map<string, { long?: PerpPosition; short?: PerpPosition }>();

    for (const position of positions) {
      if (!positionsBySymbol.has(position.symbol)) {
        positionsBySymbol.set(position.symbol, {});
      }
      const pair = positionsBySymbol.get(position.symbol)!;
      if (position.side === 'LONG') {
        pair.long = position;
      } else if (position.side === 'SHORT') {
        pair.short = position;
      }
    }

    return positionsBySymbol;
  }

  /**
   * Calculate and log metrics for each position pair
   */
  private async calculateAndLogPositionMetrics(
    positionsBySymbol: Map<string, { long?: PerpPosition; short?: PerpPosition }>,
    opportunities: OpportunityWithPlan[],
    allFundingRates: Map<string, Map<ExchangeType, number>>,
    leverage: number,
  ): Promise<{
    totalPositionValue: number;
    totalEntryCosts: number;
    totalExpectedHourlyReturn: number;
    totalBreakEvenHours: number;
    totalEstimatedAPY: number;
    totalUnrealizedPnl: number;
  }> {
    let totalPositionValue = 0;
    let totalEntryCosts = 0;
    let totalExpectedHourlyReturn = 0;
    let totalBreakEvenHours = 0;
    let totalEstimatedAPY = 0;
    let totalUnrealizedPnl = 0;

    this.logger.log('📈 POSITION DETAILS:\n');

    let positionIndex = 0;
    for (const [symbol, pair] of positionsBySymbol.entries()) {
      positionIndex++;

      const longPosition = pair.long;
      const shortPosition = pair.short;

      if (!longPosition || !shortPosition) {
        continue; // Skip incomplete pairs
      }

      const metrics = this.calculatePairMetrics(
        symbol,
        longPosition,
        shortPosition,
        opportunities,
        allFundingRates,
        leverage,
      );

      totalPositionValue += metrics.totalPairValue;
      totalEntryCosts += metrics.totalEntryCost;
      totalExpectedHourlyReturn += metrics.hourlyReturn;
      totalEstimatedAPY += metrics.estimatedAPY * (metrics.totalPairValue / (totalPositionValue || 1));
      totalUnrealizedPnl += metrics.currentPnl;

      if (metrics.combinedBreakEvenHours !== Infinity) {
        totalBreakEvenHours += metrics.combinedBreakEvenHours;
      }

      this.logPositionPairMetrics(positionIndex, symbol, longPosition, shortPosition, metrics, opportunities);
    }

    return {
      totalPositionValue,
      totalEntryCosts,
      totalExpectedHourlyReturn,
      totalBreakEvenHours,
      totalEstimatedAPY,
      totalUnrealizedPnl,
    };
  }

  /**
   * Calculate metrics for a position pair
   */
  private calculatePairMetrics(
    symbol: string,
    longPosition: PerpPosition,
    shortPosition: PerpPosition,
    opportunities: OpportunityWithPlan[],
    allFundingRates: Map<string, Map<ExchangeType, number>>,
    leverage: number,
  ): {
    totalPairValue: number;
    longRate: number;
    shortRate: number;
    spread: number;
    hourlyReturn: number;
    estimatedAPY: number;
    totalEntryCost: number;
    combinedBreakEvenHours: number;
    feesEarnedSoFar: number;
    currentPnl: number;
  } {
    const longValue = longPosition.getPositionValue();
    const shortValue = shortPosition.getPositionValue();
    const totalPairValue = longValue + shortValue;

    // Get funding rates
    const opportunity = opportunities.find((item) => item.opportunity.symbol === symbol);
    let longRate = 0;
    let shortRate = 0;

    if (opportunity) {
      longRate = opportunity.opportunity.longRate?.toDecimal() || 0;
      shortRate = opportunity.opportunity.shortRate?.toDecimal() || 0;
    } else {
      const fundingRates = allFundingRates.get(symbol);
      if (fundingRates) {
        longRate = fundingRates.get(longPosition.exchangeType) || 0;
        shortRate = fundingRates.get(shortPosition.exchangeType) || 0;
      }
    }

    const spread = Math.abs(longRate - shortRate);
    const periodsPerYear = 24 * 365;

    // Calculate hourly return
    let hourlyReturn = 0;
    if (opportunity) {
      const oppSpread = Math.abs(
        (opportunity.opportunity.longRate?.toDecimal() || 0) -
        (opportunity.opportunity.shortRate?.toDecimal() || 0),
      );
      hourlyReturn = (oppSpread * totalPairValue) / periodsPerYear;
    } else {
      hourlyReturn = (spread * totalPairValue) / periodsPerYear;
    }

    // Calculate estimated APY
    const estimatedAPY = opportunity
      ? opportunity.opportunity.expectedReturn?.toPercent() || 0
      : ((hourlyReturn * periodsPerYear) / totalPairValue) * 100;

    // Get entry costs
    const longEntry = (this.lossTracker as any)['currentPositions']?.get(
      `${symbol}_${longPosition.exchangeType}`,
    );
    const shortEntry = (this.lossTracker as any)['currentPositions']?.get(
      `${symbol}_${shortPosition.exchangeType}`,
    );
    const longEntryCost = longEntry?.entry.entryCost || 0;
    const shortEntryCost = shortEntry?.entry.entryCost || 0;
    const totalEntryCost = longEntryCost + shortEntryCost;

    // Calculate break-even
    const longBreakEvenData = this.lossTracker.getRemainingBreakEvenHours(
      longPosition,
      -longRate,
      longValue,
    );
    const shortBreakEvenData = this.lossTracker.getRemainingBreakEvenHours(
      shortPosition,
      shortRate,
      shortValue,
    );

    const combinedBreakEvenHours = Math.max(
      longBreakEvenData.remainingBreakEvenHours,
      shortBreakEvenData.remainingBreakEvenHours,
    );
    const feesEarnedSoFar =
      longBreakEvenData.feesEarnedSoFar + shortBreakEvenData.feesEarnedSoFar;

    const totalCosts = totalEntryCost * 2;
    const currentPnl = feesEarnedSoFar - totalCosts;

    return {
      totalPairValue,
      longRate,
      shortRate,
      spread,
      hourlyReturn,
      estimatedAPY,
      totalEntryCost,
      combinedBreakEvenHours,
      feesEarnedSoFar,
      currentPnl,
    };
  }

  /**
   * Log metrics for a position pair
   */
  private logPositionPairMetrics(
    index: number,
    symbol: string,
    longPosition: PerpPosition,
    shortPosition: PerpPosition,
    metrics: {
      totalPairValue: number;
      longRate: number;
      shortRate: number;
      hourlyReturn: number;
      estimatedAPY: number;
      totalEntryCost: number;
      combinedBreakEvenHours: number;
      feesEarnedSoFar: number;
      currentPnl: number;
    },
    opportunities: OpportunityWithPlan[],
  ): void {
    const longValue = longPosition.getPositionValue();
    const shortValue = shortPosition.getPositionValue();
    const periodsPerYear = 24 * 365;

    // Format break-even time
    const breakEvenStr = this.formatBreakEvenTime(metrics.combinedBreakEvenHours);

    // Status indicator
    const status =
      metrics.combinedBreakEvenHours === 0
        ? '✅ PROFITABLE'
        : metrics.combinedBreakEvenHours === Infinity
          ? '❌ UNPROFITABLE'
          : metrics.combinedBreakEvenHours < 24
            ? '🟡 BREAKING EVEN SOON'
            : '🟠 IN PROGRESS';

    this.logger.log(`Position Pair ${index}: ${symbol}`);
    this.logger.log(`   ───────────────────────────────────────────────────────────────────────────`);
    this.logger.log(
      `   LONG: ${longPosition.exchangeType} | Size: $${longValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    this.logger.log(
      `   SHORT: ${shortPosition.exchangeType} | Size: $${shortValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    this.logger.log(
      `   Total Pair Value: $${metrics.totalPairValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    this.logger.log(`   Status: ${status}`);

    this.logger.log(`   💰 CURRENT REAL APY: ${metrics.estimatedAPY.toFixed(2)}%`);
    this.logger.log(`      Hourly Return: $${metrics.hourlyReturn.toFixed(4)}`);
    this.logger.log(`      Daily Return: $${(metrics.hourlyReturn * 24).toFixed(2)}`);
    this.logger.log(`      Annual Return: $${(metrics.hourlyReturn * periodsPerYear).toFixed(2)}`);

    this.logger.log(`   ⏱️  BREAK-EVEN ANALYSIS:`);
    this.logger.log(`      Time Until Break-Even: ${breakEvenStr}`);
    this.logger.log(`      Fees Earned So Far: $${metrics.feesEarnedSoFar.toFixed(4)}`);

    this.logger.log(`   💸 COST BREAKDOWN:`);
    this.logger.log(`      Total Entry Cost: $${metrics.totalEntryCost.toFixed(4)}`);

    this.logger.log(`   📈 PROFIT/LOSS:`);
    this.logger.log(`      Fees Earned: $${metrics.feesEarnedSoFar.toFixed(4)}`);
    this.logger.log(
      `      Current P&L: $${metrics.currentPnl.toFixed(4)} ${metrics.currentPnl >= 0 ? '✅' : '❌'}`,
    );

    // Allocation info
    const opportunity = opportunities.find((item) => item.opportunity.symbol === symbol);
    if (opportunity && opportunity.maxPortfolioFor35APY) {
      this.logger.log(`   🎯 ALLOCATION:`);
      this.logger.log(
        `      Max Portfolio (35% APY): $${opportunity.maxPortfolioFor35APY.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      );
      const allocationPercent = (metrics.totalPairValue / opportunity.maxPortfolioFor35APY) * 100;
      this.logger.log(`      Allocation %: ${allocationPercent.toFixed(1)}%`);
    }

    this.logger.log('');
  }

  /**
   * Log portfolio summary
   */
  private logPortfolioSummary(
    totals: {
      totalPositionValue: number;
      totalEntryCosts: number;
      totalExpectedHourlyReturn: number;
      totalBreakEvenHours: number;
      totalEstimatedAPY: number;
      totalUnrealizedPnl: number;
    },
    positionPairsCount: number,
    totalPositions: number,
    leverage: number,
  ): void {
    this.logger.log(
      '═══════════════════════════════════════════════════════════════════════════════',
    );
    this.logger.log('📊 PORTFOLIO SUMMARY');
    this.logger.log(
      '═══════════════════════════════════════════════════════════════════════════════\n',
    );

    this.logger.log(`   Total Position Pairs: ${positionPairsCount}`);
    this.logger.log(`   Total Individual Positions: ${totalPositions}`);
    this.logger.log(
      `   Total Position Value: $${totals.totalPositionValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    this.logger.log(`   Total Entry Costs: $${totals.totalEntryCosts.toFixed(4)}`);

    this.logger.log(`   💰 EXPECTED RETURNS:`);
    this.logger.log(`      Weighted Avg APY: ${totals.totalEstimatedAPY.toFixed(2)}%`);
    this.logger.log(`      Total Hourly Return: $${totals.totalExpectedHourlyReturn.toFixed(4)}`);
    this.logger.log(`      Total Daily Return: $${(totals.totalExpectedHourlyReturn * 24).toFixed(2)}`);
    this.logger.log(
      `      Total Annual Return: $${(totals.totalExpectedHourlyReturn * 8760).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );

    this.logger.log(`   ⏱️  BREAK-EVEN:`);
    const avgBreakEvenHours = positionPairsCount > 0 ? totals.totalBreakEvenHours / positionPairsCount : 0;
    const avgBreakEvenStr = this.formatBreakEvenTime(avgBreakEvenHours);
    this.logger.log(`      Average Time to Break-Even: ${avgBreakEvenStr}`);

    this.logger.log(`   📈 PROFIT/LOSS:`);
    this.logger.log(
      `      Total Unrealized P&L: $${totals.totalUnrealizedPnl.toFixed(4)} ${totals.totalUnrealizedPnl >= 0 ? '✅' : '❌'}`,
    );

    const cumulativeLoss = this.lossTracker.getCumulativeLoss();
    this.logger.log(`      Cumulative Loss: $${cumulativeLoss.toFixed(4)}`);

    this.logger.log(`   📊 EFFICIENCY:`);
    const totalCapital = totals.totalPositionValue / leverage;
    const capitalEfficiency =
      totalCapital > 0
        ? ((totals.totalExpectedHourlyReturn * 8760) / totalCapital) * 100
        : 0;
    this.logger.log(
      `      Capital Deployed: $${totalCapital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    this.logger.log(`      Capital Efficiency: ${capitalEfficiency.toFixed(2)}% APY`);
    this.logger.log(`      Leverage: ${leverage}x`);

    this.logger.log(
      '\n═══════════════════════════════════════════════════════════════════════════════\n',
    );
  }

  /**
   * Format break-even time for display
   */
  private formatBreakEvenTime(hours: number): string {
    if (hours === Infinity) {
      return 'N/A (unprofitable)';
    }
    if (hours < 1) {
      return `${(hours * 60).toFixed(0)} minutes`;
    }
    if (hours < 24) {
      return `${hours.toFixed(1)} hours`;
    }
    return `${(hours / 24).toFixed(1)} days (${hours.toFixed(1)}h)`;
  }
}

