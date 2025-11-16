import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '@domain/entities/Strategy';
import { APR, IV } from '@domain/value-objects';
import { Position } from '@domain/entities/Position';
import { Trade } from '@domain/entities/Trade';

export interface OptionsOverlayConfig extends StrategyConfig {
  pair: string;
  lpRangeWidth: number; // e.g., 0.03 for ±3%
  optionStrikeDistance: number; // e.g., 0.05 for ±5% outside LP band
  optionTenor?: number; // Days, default 7
  overlaySizing?: number; // Fraction of LP notional, default 0.4
  allocation?: number;
}

export class OptionsOverlayStrategy extends BaseStrategy {
  constructor(id: string, name: string = 'Options Overlay Strategy') {
    super(id, name);
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const optionsConfig = config as OptionsOverlayConfig;
    this.validateConfigOrThrow(optionsConfig);

    const trades: Trade[] = [];
    const positions: Position[] = [];
    let shouldRebalance = false;

    const allocation = optionsConfig.allocation || 0.2;
    const totalValue = portfolio.totalValue();
    const allocatedAmount = totalValue.multiply(allocation);

    const existingPosition = portfolio.positions.find(
      (p) => p.strategyId === this.id && p.asset === optionsConfig.pair
    );

    if (!existingPosition && allocatedAmount.value > 0) {
      // Create LP position
      const lpPosition = Position.create({
        id: `${this.id}-lp-${Date.now()}`,
        strategyId: this.id,
        asset: `${optionsConfig.pair}-LP`,
        amount: allocatedAmount,
        entryPrice: marketData.price,
        currentPrice: marketData.price,
      });

      positions.push(lpPosition);

      // Create options overlay (simplified - would sell OTM options)
      const overlaySizing = optionsConfig.overlaySizing || 0.4;
      const optionNotional = allocatedAmount.multiply(overlaySizing);

      // Simulate option premium collection
      const iv = marketData.iv || IV.create(50);
      const weeklyPremium = optionNotional.multiply(iv.toDecimal() * 0.01); // Simplified premium calc

      trades.push(
        this.createTradeForStrategy(
          `${optionsConfig.pair}-OPTIONS`,
          'sell',
          optionNotional,
          marketData.price,
          marketData.timestamp,
          weeklyPremium
        )
      );
    } else if (existingPosition) {
      positions.push(existingPosition.updatePrice(marketData.price));
    }

    return { trades, positions, shouldRebalance };
  }

  calculateExpectedYield(config: StrategyConfig, marketData: MarketData): APR {
    const optionsConfig = config as OptionsOverlayConfig;
    const lpFeeAPR = 15; // Base LP fees
    const iv = marketData.iv || IV.create(50);
    const weeklyPremiumRate = iv.toDecimal() * 0.01;
    const optionsAPR = weeklyPremiumRate * 52 * 100; // Annualized
    const overlaySizing = optionsConfig.overlaySizing || 0.4;

    return APR.create(lpFeeAPR + optionsAPR * overlaySizing);
  }

  validateConfig(config: StrategyConfig): boolean {
    const optionsConfig = config as OptionsOverlayConfig;
    return (
      !!optionsConfig.pair &&
      typeof optionsConfig.lpRangeWidth === 'number' &&
      typeof optionsConfig.optionStrikeDistance === 'number' &&
      optionsConfig.optionStrikeDistance > optionsConfig.lpRangeWidth
    );
  }

  private validateConfigOrThrow(config: OptionsOverlayConfig): void {
    if (!this.validateConfig(config)) {
      throw new Error(`Invalid OptionsOverlayStrategy config`);
    }
  }
}

