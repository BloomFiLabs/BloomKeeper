import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '@domain/entities/Strategy';
import { Amount, Price, APR, FundingRate, HealthFactor } from '@domain/value-objects';
import { Position } from '@domain/entities/Position';
import { Trade } from '@domain/entities/Trade';

export interface FundingRateConfig extends StrategyConfig {
  asset: string;
  fundingThreshold?: number; // Default 0.0001 (0.01% per 8h)
  leverage?: number; // 1.5-3x
  healthFactorThreshold?: number;
  allocation?: number;
}

export class FundingRateCaptureStrategy extends BaseStrategy {
  constructor(id: string, name: string = 'Funding Rate Capture Strategy') {
    super(id, name);
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const fundingConfig = config as FundingRateConfig;
    this.validateConfigOrThrow(fundingConfig);

    const trades: Trade[] = [];
    const positions: Position[] = [];
    let shouldRebalance = false;

    const threshold = fundingConfig.fundingThreshold || 0.0001;
    const fundingRate = marketData.fundingRate;

    // Only execute if funding is positive
    if (!fundingRate || !fundingRate.isPositive() || fundingRate.value < threshold) {
      return { trades, positions, shouldRebalance };
    }

    const allocation = fundingConfig.allocation || 0.15;
    const leverage = fundingConfig.leverage || 2.0;
    const totalValue = portfolio.totalValue();
    const baseAmount = totalValue.multiply(allocation);
    const notionalAmount = baseAmount.multiply(leverage);
    const borrowedAmount = notionalAmount.subtract(baseAmount);

    // Check health factor
    const healthFactor = HealthFactor.create(leverage / 0.8);
    if (healthFactor.isAtRisk(fundingConfig.healthFactorThreshold || 1.5)) {
      shouldRebalance = true;
    }

    const existingPosition = portfolio.positions.find(
      (p) => p.strategyId === this.id && p.asset === fundingConfig.asset
    );

    if (!existingPosition && baseAmount.value > 0) {
      // Long spot + short perp (delta neutral)
      const spotTrade = this.createTradeForStrategy(
        fundingConfig.asset,
        'buy',
        notionalAmount,
        marketData.price,
        marketData.timestamp
      );

      trades.push(spotTrade);

      const position = Position.create({
        id: `${this.id}-${fundingConfig.asset}-${Date.now()}`,
        strategyId: this.id,
        asset: fundingConfig.asset,
        amount: notionalAmount,
        entryPrice: marketData.price,
        currentPrice: marketData.price,
        collateralAmount: baseAmount,
        borrowedAmount,
      });

      positions.push(position);
    } else if (existingPosition && fundingRate && !fundingRate.isPositive()) {
      // Close position if funding turns negative
      shouldRebalance = true;
    } else if (existingPosition) {
      positions.push(existingPosition.updatePrice(marketData.price));
    }

    return { trades, positions, shouldRebalance };
  }

  calculateExpectedYield(config: StrategyConfig, marketData: MarketData): APR {
    const fundingConfig = config as FundingRateConfig;
    const fundingRate = marketData.fundingRate;
    const leverage = fundingConfig.leverage || 2.0;

    if (!fundingRate || !fundingRate.isPositive()) {
      return APR.zero();
    }

    const fundingAPR = fundingRate.toAPR();
    return APR.create(fundingAPR * leverage);
  }

  validateConfig(config: StrategyConfig): boolean {
    const fundingConfig = config as FundingRateConfig;
    return (
      !!fundingConfig.asset &&
      (fundingConfig.leverage === undefined ||
        (fundingConfig.leverage >= 1.0 && fundingConfig.leverage <= 3.0))
    );
  }

  private validateConfigOrThrow(config: FundingRateConfig): void {
    if (!this.validateConfig(config)) {
      throw new Error(`Invalid FundingRateCaptureStrategy config`);
    }
  }
}

