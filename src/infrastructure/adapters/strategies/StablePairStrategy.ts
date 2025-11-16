import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '@domain/entities/Strategy';
import { Amount, Price, APR } from '@domain/value-objects';
import { Position } from '@domain/entities/Position';
import { Trade } from '@domain/entities/Trade';

export interface StablePairConfig extends StrategyConfig {
  pair: string;
  rangeWidth: number; // e.g., 0.002 for ±0.2%
  leverage?: number; // Default 1.0 (no leverage)
  collateralRatio?: number; // Default 1.5
  allocation?: number; // Fraction of portfolio to allocate (0-1)
  ammFeeAPR?: number;
  incentiveAPR?: number;
  borrowAPR?: number;
}

export class StablePairStrategy extends BaseStrategy {
  constructor(id: string, name: string = 'Stable Pair Strategy') {
    super(id, name);
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const stableConfig = config as StablePairConfig;
    this.validateConfigOrThrow(stableConfig);

    const trades: Trade[] = [];
    const positions: Position[] = [];
    let shouldRebalance = false;
    let rebalanceReason: string | undefined;

    const targetPrice = Price.create(1.0); // Stable pairs target 1:1
    const rangeWidth = stableConfig.rangeWidth;

    // Check if price is outside range
    const priceDeviation = marketData.price.percentageChange(targetPrice);
    if (Math.abs(priceDeviation) > rangeWidth * 100) {
      shouldRebalance = true;
      rebalanceReason = `Price ${priceDeviation.toFixed(2)}% outside range ±${(rangeWidth * 100).toFixed(2)}%`;
    }

    // Calculate allocation
    const allocation = stableConfig.allocation || 0.3;
    const totalValue = portfolio.totalValue();
    const allocatedAmount = totalValue.multiply(allocation);

    // If no position exists, create one
    const existingPosition = portfolio.positions.find(
      (p) => p.strategyId === this.id && p.asset === stableConfig.pair
    );

    if (!existingPosition && allocatedAmount.value > 0) {
      // Create LP position
      // For LP positions, price = 1.0 (LP tokens priced in USD)
      const leverage = stableConfig.leverage || 1.0;
      const positionAmount = allocatedAmount.multiply(leverage);
      const lpPrice = Price.create(1.0);

      const position = Position.create({
        id: `${this.id}-${stableConfig.pair}`,
        strategyId: this.id,
        asset: stableConfig.pair,
        amount: positionAmount, // LP token amount in USD value
        entryPrice: lpPrice,
        currentPrice: lpPrice,
        collateralAmount: allocatedAmount,
        borrowedAmount: leverage > 1 ? allocatedAmount.multiply(leverage - 1) : Amount.zero(),
      });

      positions.push(position);
      
      // Create trades for accounting
      const [asset1, asset2] = stableConfig.pair.split('-');
      const halfAmount = positionAmount.multiply(0.5);
      const trade1 = this.createTradeForStrategy(asset1, 'buy', halfAmount, marketData.price, marketData.timestamp);
      const trade2 = this.createTradeForStrategy(asset2, 'buy', halfAmount, marketData.price, marketData.timestamp);
      trades.push(trade1, trade2);
    } else if (existingPosition) {
      // Position exists - update price (keep at 1.0 for LP)
      const lpPrice = Price.create(1.0);
      positions.push(existingPosition.updatePrice(lpPrice));
    }

    return {
      trades,
      positions,
      shouldRebalance,
      rebalanceReason,
    };
  }

  calculateExpectedYield(config: StrategyConfig, _marketData: MarketData): APR {
    const stableConfig = config as StablePairConfig;
    const ammFeeAPR = stableConfig.ammFeeAPR || 10;
    const incentiveAPR = stableConfig.incentiveAPR || 15;
    const borrowAPR = stableConfig.borrowAPR || 3;
    const leverage = stableConfig.leverage || 1.0;

    // Gross yield = (AMM fees + incentives) * leverage - borrow cost
    const grossYield = (ammFeeAPR + incentiveAPR) * leverage - borrowAPR * (leverage - 1);
    return APR.create(Math.max(0, grossYield));
  }

  validateConfig(config: StrategyConfig): boolean {
    const stableConfig = config as StablePairConfig;
    return (
      !!stableConfig.pair &&
      typeof stableConfig.rangeWidth === 'number' &&
      stableConfig.rangeWidth > 0 &&
      stableConfig.rangeWidth < 0.01 && // Max 1% range
      (stableConfig.leverage === undefined ||
        (stableConfig.leverage >= 1.0 && stableConfig.leverage <= 3.0)) &&
      (stableConfig.collateralRatio === undefined ||
        (stableConfig.collateralRatio >= 1.2 && stableConfig.collateralRatio <= 2.0))
    );
  }

  private validateConfigOrThrow(config: StablePairConfig): void {
    if (!this.validateConfig(config)) {
      throw new Error(`Invalid StablePairStrategy config: ${JSON.stringify(config)}`);
    }
  }
}

