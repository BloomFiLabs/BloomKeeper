import { Portfolio } from '../entities/Portfolio';
import { Amount, HealthFactor } from '../value-objects';
import { Position } from '../entities/Position';

export interface RiskMetrics {
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  currentDrawdown: number;
  var95: number; // Value at Risk 95%
  healthFactor: number;
  totalExposure: number;
  leverage: number;
}

export class RiskCalculator {
  calculateSharpeRatio(returns: number[], riskFreeRate: number = 0): number {
    if (returns.length === 0) return 0;

    const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const excessReturn = meanReturn - riskFreeRate;

    const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;
    return excessReturn / stdDev;
  }

  calculateSortinoRatio(returns: number[], riskFreeRate: number = 0): number {
    if (returns.length === 0) return 0;

    const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const excessReturn = meanReturn - riskFreeRate;

    const negativeReturns = returns.filter((r) => r < 0);
    if (negativeReturns.length === 0) return excessReturn > 0 ? Infinity : 0;

    const downsideVariance =
      negativeReturns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
    const downsideStdDev = Math.sqrt(downsideVariance);

    if (downsideStdDev === 0) return 0;
    return excessReturn / downsideStdDev;
  }

  calculateMaxDrawdown(values: number[]): number {
    if (values.length === 0) return 0;

    let maxDrawdown = 0;
    let peak = values[0];

    for (const value of values) {
      if (value > peak) {
        peak = value;
      }
      const drawdown = (peak - value) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown * 100; // Return as percentage
  }

  calculateCurrentDrawdown(values: number[]): number {
    if (values.length === 0) return 0;

    const peak = Math.max(...values);
    const current = values[values.length - 1];
    return ((peak - current) / peak) * 100;
  }

  calculateVaR(returns: number[], confidenceLevel: number = 0.95): number {
    if (returns.length === 0) return 0;

    const sorted = [...returns].sort((a, b) => a - b);
    const index = Math.floor((1 - confidenceLevel) * sorted.length);
    return Math.abs(sorted[index] || 0) * 100;
  }

  calculateHealthFactor(position: Position): HealthFactor {
    if (!position.isLeveraged()) {
      return HealthFactor.create(Infinity);
    }

    const collateralValue = position.collateralAmount.multiply(position.currentPrice.value);
    const debtValue = position.borrowedAmount.multiply(position.currentPrice.value);

    if (debtValue.value === 0) {
      return HealthFactor.create(Infinity);
    }

    const hf = collateralValue.value / debtValue.value;
    return HealthFactor.create(hf);
  }

  calculatePortfolioHealthFactor(portfolio: Portfolio): number {
    const leveragedPositions = portfolio.positions.filter((p) => p.isLeveraged());
    if (leveragedPositions.length === 0) return Infinity;

    let totalCollateral = Amount.zero();
    let totalDebt = Amount.zero();

    for (const position of leveragedPositions) {
      totalCollateral = totalCollateral.add(position.collateralAmount);
      totalDebt = totalDebt.add(position.borrowedAmount);
    }

    if (totalDebt.value === 0) return Infinity;
    return totalCollateral.value / totalDebt.value;
  }

  calculateRiskMetrics(
    portfolio: Portfolio,
    historicalValues: number[],
    historicalReturns: number[]
  ): RiskMetrics {
    const totalExposure = portfolio.positions.reduce(
      (sum, pos) => sum.add(pos.marketValue()),
      Amount.zero()
    );

    const totalValue = portfolio.totalValue();
    const leverage = totalValue.value > 0 ? totalExposure.value / totalValue.value : 1;

    return {
      sharpeRatio: this.calculateSharpeRatio(historicalReturns),
      sortinoRatio: this.calculateSortinoRatio(historicalReturns),
      maxDrawdown: this.calculateMaxDrawdown(historicalValues),
      currentDrawdown: this.calculateCurrentDrawdown(historicalValues),
      var95: this.calculateVaR(historicalReturns, 0.95),
      healthFactor: this.calculatePortfolioHealthFactor(portfolio),
      totalExposure: totalExposure.value,
      leverage,
    };
  }
}

