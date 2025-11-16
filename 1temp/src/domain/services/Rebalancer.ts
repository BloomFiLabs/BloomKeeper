import { Portfolio } from '../entities/Portfolio';
import { Position } from '../entities/Position';
import { Amount, HealthFactor } from '../value-objects';
import { RiskCalculator } from './RiskCalculator';

export interface RebalanceAction {
  positionId: string;
  action: 'reduce' | 'close' | 'increase';
  targetAmount?: Amount;
  reason: string;
}

export class Rebalancer {
  private riskCalculator: RiskCalculator;

  constructor() {
    this.riskCalculator = new RiskCalculator();
  }

  checkRebalanceNeeded(portfolio: Portfolio, thresholds: {
    maxLeverage?: number;
    minHealthFactor?: number;
    maxDrawdown?: number;
  }): RebalanceAction[] {
    const actions: RebalanceAction[] = [];

    // Check health factor for leveraged positions
    const healthFactor = this.riskCalculator.calculatePortfolioHealthFactor(portfolio);
    if (thresholds.minHealthFactor && healthFactor < thresholds.minHealthFactor) {
      // Need to deleverage
      for (const position of portfolio.positions) {
        if (position.isLeveraged()) {
          actions.push({
            positionId: position.id,
            action: 'reduce',
            reason: `Health factor ${healthFactor.toFixed(2)} below threshold ${thresholds.minHealthFactor}`,
          });
        }
      }
    }

    // Check leverage
    const totalValue = portfolio.totalValue();
    const totalExposure = portfolio.positions.reduce(
      (sum, pos) => sum.add(pos.marketValue()),
      Amount.zero()
    );
    const leverage = totalValue.value > 0 ? totalExposure.value / totalValue.value : 1;

    if (thresholds.maxLeverage && leverage > thresholds.maxLeverage) {
      // Reduce positions to bring leverage down
      for (const position of portfolio.positions) {
        const targetExposure = totalValue.multiply(thresholds.maxLeverage / portfolio.positions.length);
        const currentExposure = position.marketValue();
        if (currentExposure.value > targetExposure.value) {
          actions.push({
            positionId: position.id,
            action: 'reduce',
            targetAmount: targetExposure,
            reason: `Leverage ${leverage.toFixed(2)} exceeds max ${thresholds.maxLeverage}`,
          });
        }
      }
    }

    return actions;
  }

  deleverage(portfolio: Portfolio, position: Position, targetHealthFactor: number = 1.5): RebalanceAction {
    const currentHF = this.riskCalculator.calculateHealthFactor(position);
    if (currentHF.value >= targetHealthFactor) {
      return {
        positionId: position.id,
        action: 'reduce',
        reason: 'Health factor already safe',
      };
    }

    // Calculate required reduction
    const requiredHF = HealthFactor.create(targetHealthFactor);
    const targetDebt = position.collateralAmount.multiply(1 / requiredHF.value);
    const reduction = position.borrowedAmount.subtract(targetDebt);

    return {
      positionId: position.id,
      action: 'reduce',
      targetAmount: reduction,
      reason: `Deleverage to HF ${targetHealthFactor}`,
    };
  }
}

