import { Injectable, Logger } from '@nestjs/common';
import type { PortfolioRiskMetrics } from '../../../infrastructure/services/PortfolioRiskAnalyzer';

/**
 * Optimal portfolio allocation result
 */
export interface OptimalPortfolioAllocation {
  allocations: Map<string, number>;
  totalPortfolio: number;
  aggregateAPY: number;
  opportunityCount: number;
}

/**
 * InvestorReportGenerator - Generates comprehensive investor reports
 * 
 * Creates detailed risk analysis reports including:
 * - Expected returns and confidence intervals
 * - Risk metrics (VaR, drawdown, Sharpe ratio)
 * - Historical validation
 * - Stress test scenarios
 * - Concentration and correlation risks
 * - Volatility breakdown
 */
@Injectable()
export class InvestorReportGenerator {
  private readonly logger = new Logger(InvestorReportGenerator.name);

  /**
   * Log comprehensive investor report with all risk metrics
   */
  logInvestorReport(
    riskMetrics: PortfolioRiskMetrics & { dataQuality?: any },
    optimalPortfolio: OptimalPortfolioAllocation,
  ): void {
    this.logger.log('\n📊 PORTFOLIO RISK ANALYSIS (Investor Report):');
    this.logger.log('='.repeat(100));

    this.logDataQualityWarnings(riskMetrics.dataQuality);
    this.logExpectedReturns(riskMetrics);
    this.logRiskMetrics(riskMetrics);
    this.logHistoricalValidation(riskMetrics);
    this.logStressTests(riskMetrics);
    this.logConcentrationRisk(riskMetrics, optimalPortfolio);
    this.logCorrelationRisk(riskMetrics);
    this.logVolatilityBreakdown(riskMetrics);

    this.logger.log('\n' + '='.repeat(100));
  }

  /**
   * Log data quality warnings
   */
  private logDataQualityWarnings(dataQuality?: any): void {
    if (dataQuality?.hasIssues) {
      this.logger.warn('\n⚠️  DATA QUALITY WARNINGS:');
      dataQuality.warnings.forEach((warning: string) =>
        this.logger.warn(`  - ${warning}`),
      );
    }
  }

  /**
   * Log expected returns section
   */
  private logExpectedReturns(riskMetrics: PortfolioRiskMetrics & { dataQuality?: any }): void {
    this.logger.log('\nEXPECTED RETURNS:');
    this.logger.log(`  Expected APY: ${(riskMetrics.expectedAPY * 100).toFixed(2)}%`);

    if (riskMetrics.dataQuality?.hasSufficientDataForConfidenceInterval) {
      this.logger.log(
        `  ${(riskMetrics.expectedAPYConfidenceInterval.confidence * 100).toFixed(0)}% Confidence Interval: ` +
        `${(riskMetrics.expectedAPYConfidenceInterval.lower * 100).toFixed(2)}% - ` +
        `${(riskMetrics.expectedAPYConfidenceInterval.upper * 100).toFixed(2)}%`,
      );
    } else {
      this.logger.log(
        `  ${(riskMetrics.expectedAPYConfidenceInterval.confidence * 100).toFixed(0)}% Confidence Interval: ` +
        `N/A (insufficient historical data)`,
      );
    }
  }

  /**
   * Log risk metrics section
   */
  private logRiskMetrics(riskMetrics: PortfolioRiskMetrics & { dataQuality?: any }): void {
    this.logger.log('\nRISK METRICS:');
    this.logger.log(
      `  Worst-Case APY: ${(riskMetrics.worstCaseAPY * 100).toFixed(2)}% (if all spreads reverse)`,
    );

    if (riskMetrics.dataQuality?.hasSufficientDataForVaR && riskMetrics.valueAtRisk95 !== 0) {
      this.logger.log(
        `  Value at Risk (95%): -$${(Math.abs(riskMetrics.valueAtRisk95) / 1000).toFixed(1)}k (worst month loss)`,
      );
    } else {
      this.logger.log(
        `  Value at Risk (95%): N/A (insufficient historical data - need 2+ months)`,
      );
    }

    if (riskMetrics.dataQuality?.hasSufficientDataForDrawdown && riskMetrics.maximumDrawdown !== 0) {
      this.logger.log(
        `  Maximum Drawdown: -$${(Math.abs(riskMetrics.maximumDrawdown) / 1000).toFixed(1)}k (estimated)`,
      );
    } else {
      this.logger.log(
        `  Maximum Drawdown: N/A (insufficient historical data - need 1+ month)`,
      );
    }

    this.logger.log(`  Sharpe Ratio: ${riskMetrics.sharpeRatio.toFixed(2)} (risk-adjusted return)`);
  }

  /**
   * Log historical validation section
   */
  private logHistoricalValidation(riskMetrics: PortfolioRiskMetrics & { dataQuality?: any }): void {
    this.logger.log('\nHISTORICAL VALIDATION:');

    if (riskMetrics.dataQuality?.hasSufficientDataForBacktest) {
      this.logger.log(
        `  Last 30 Days: ${(riskMetrics.historicalBacktest.last30Days.apy * 100).toFixed(2)}% APY ` +
        `${riskMetrics.historicalBacktest.last30Days.realized ? '(realized)' : '(estimated)'}`,
      );
      this.logger.log(
        `  Last 90 Days: ${(riskMetrics.historicalBacktest.last90Days.apy * 100).toFixed(2)}% APY ` +
        `${riskMetrics.historicalBacktest.last90Days.realized ? '(realized)' : '(estimated)'}`,
      );

      if (riskMetrics.historicalBacktest.worstMonth.month !== 'N/A') {
        this.logger.log(
          `  Worst Month: ${(riskMetrics.historicalBacktest.worstMonth.apy * 100).toFixed(2)}% APY ` +
          `(${riskMetrics.historicalBacktest.worstMonth.month})`,
        );
        this.logger.log(
          `  Best Month: ${(riskMetrics.historicalBacktest.bestMonth.apy * 100).toFixed(2)}% APY ` +
          `(${riskMetrics.historicalBacktest.bestMonth.month})`,
        );
      } else {
        this.logger.log(`  Worst/Best Month: N/A (insufficient monthly data)`);
      }
    } else {
      this.logger.log(
        `  Historical Backtest: N/A (insufficient historical data - need 2+ months)`,
      );
    }
  }

  /**
   * Log stress test scenarios
   */
  private logStressTests(riskMetrics: PortfolioRiskMetrics): void {
    this.logger.log('\nSTRESS TEST SCENARIOS:');

    riskMetrics.stressTests.forEach((scenario, index) => {
      const riskEmoji = this.getRiskEmoji(scenario.riskLevel);
      this.logger.log(
        `  ${index + 1}. ${scenario.scenario}: ${(scenario.apy * 100).toFixed(2)}% APY → ` +
        `${riskEmoji} ${scenario.riskLevel} risk, ${scenario.timeToRecover} to recover`,
      );
      this.logger.log(`     ${scenario.description}`);
    });
  }

  /**
   * Log concentration risk section
   */
  private logConcentrationRisk(
    riskMetrics: PortfolioRiskMetrics,
    optimalPortfolio: OptimalPortfolioAllocation,
  ): void {
    this.logger.log('\nCONCENTRATION RISK:');

    const concentrationEmoji = this.getRiskEmoji(riskMetrics.concentrationRisk.riskLevel);
    const exceedsThreshold = riskMetrics.concentrationRisk.maxAllocationPercent > 25;

    this.logger.log(
      `  Max Allocation: ${riskMetrics.concentrationRisk.maxAllocationPercent.toFixed(1)}% ` +
      `${concentrationEmoji} ${riskMetrics.concentrationRisk.riskLevel} RISK` +
      `${exceedsThreshold ? ' - exceeds 25% threshold' : ''}`,
    );
    this.logger.log(
      `  Top 3 Allocations: ${riskMetrics.concentrationRisk.top3AllocationPercent.toFixed(1)}%`,
    );

    const herfindahlLevel =
      riskMetrics.concentrationRisk.herfindahlIndex > 0.25
        ? 'HIGH'
        : riskMetrics.concentrationRisk.herfindahlIndex > 0.15
          ? 'MODERATE'
          : 'LOW';
    this.logger.log(
      `  Herfindahl Index: ${riskMetrics.concentrationRisk.herfindahlIndex.toFixed(3)} (${herfindahlLevel} concentration)`,
    );

    if (exceedsThreshold) {
      // Find which symbol has the max allocation
      let maxSymbol = 'N/A';
      let maxAmount = 0;
      optimalPortfolio.allocations.forEach((amount, symbol) => {
        if (amount > maxAmount) {
          maxAmount = amount;
          maxSymbol = symbol;
        }
      });
      this.logger.log(`  Recommendation: Reduce ${maxSymbol} allocation to <25%`);
    }
  }

  /**
   * Log correlation risk section
   */
  private logCorrelationRisk(riskMetrics: PortfolioRiskMetrics & { dataQuality?: any }): void {
    this.logger.log('\nCORRELATION RISK:');

    if (
      riskMetrics.dataQuality?.hasSufficientDataForCorrelation &&
      riskMetrics.correlationRisk.correlatedPairs.length >= 0
    ) {
      const correlationEmoji =
        riskMetrics.correlationRisk.maxCorrelation > 0.7
          ? '🟠'
          : riskMetrics.correlationRisk.maxCorrelation > 0.5
            ? '🟡'
            : '🟢';

      const correlationLevel =
        Math.abs(riskMetrics.correlationRisk.averageCorrelation) < 0.3
          ? 'LOW'
          : 'MODERATE';
      const independenceDesc =
        Math.abs(riskMetrics.correlationRisk.averageCorrelation) < 0.3
          ? 'independent'
          : 'correlated';

      this.logger.log(
        `  Average Correlation: ${riskMetrics.correlationRisk.averageCorrelation.toFixed(3)} ` +
        `(${correlationLevel} - opportunities are mostly ${independenceDesc})`,
      );
      this.logger.log(
        `  Max Correlation: ${riskMetrics.correlationRisk.maxCorrelation.toFixed(3)} ${correlationEmoji}`,
      );

      if (riskMetrics.correlationRisk.correlatedPairs.length > 0) {
        this.logger.log(
          `  Highly Correlated Pairs (|correlation| > 0.7): ${riskMetrics.correlationRisk.correlatedPairs.length} pairs`,
        );
        riskMetrics.correlationRisk.correlatedPairs.slice(0, 5).forEach((pair) => {
          this.logger.log(`    - ${pair.pair1} / ${pair.pair2}: ${pair.correlation.toFixed(3)}`);
        });
      } else {
        this.logger.log(
          `  Highly Correlated Pairs: None (all pairs have |correlation| ≤ 0.7)`,
        );
      }
    } else {
      this.logger.log(
        `  Correlation Analysis: N/A (insufficient historical data - need 10+ matched pairs)`,
      );
    }
  }

  /**
   * Log volatility breakdown section
   */
  private logVolatilityBreakdown(riskMetrics: PortfolioRiskMetrics): void {
    this.logger.log('\nVOLATILITY BREAKDOWN:');

    riskMetrics.volatilityBreakdown.forEach((item) => {
      const riskEmoji = this.getRiskEmoji(item.riskLevel);
      this.logger.log(
        `  ${item.symbol}: $${(item.allocation / 1000).toFixed(1)}k (${item.allocationPercent.toFixed(1)}%) | ` +
        `Stability: ${(item.stabilityScore * 100).toFixed(0)}% | Risk: ${riskEmoji} ${item.riskLevel}`,
      );
    });
  }

  /**
   * Get emoji for risk level
   */
  private getRiskEmoji(riskLevel: string): string {
    switch (riskLevel) {
      case 'CRITICAL':
        return '🔴';
      case 'HIGH':
        return '🟠';
      case 'MEDIUM':
        return '🟡';
      case 'LOW':
      default:
        return '🟢';
    }
  }
}

