import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '@domain/entities/Strategy';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Amount, APR, IV } from '@domain/value-objects';
import { OptionsOverlayStrategy } from './OptionsOverlayStrategy';
import { StablePairStrategy } from './StablePairStrategy';

export interface IVRegimeConfig extends StrategyConfig {
  lowIVThreshold?: number; // Default 30
  highIVThreshold?: number; // Default 70
  hysteresis?: number; // Default 5 IV points
  minHoldPeriod?: number; // Days, default 3
  allocation?: number;
}

export class IVRegimeSwitcherStrategy extends BaseStrategy {
  private currentRegime: 'low' | 'mid' | 'high' = 'mid';
  private lastSwitchDate: Date = new Date(0);
  private lpStrategy: StablePairStrategy;
  private optionsStrategy: OptionsOverlayStrategy;

  constructor(id: string, name: string = 'IV Regime Switcher Strategy') {
    super(id, name);
    this.lpStrategy = new StablePairStrategy(`${id}-lp`, 'LP Component');
    this.optionsStrategy = new OptionsOverlayStrategy(`${id}-options`, 'Options Component');
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const regimeConfig = config as IVRegimeConfig;
    this.validateConfigOrThrow(regimeConfig);

    const iv = marketData.iv || IV.create(50);
    const lowThreshold = regimeConfig.lowIVThreshold || 30;
    const highThreshold = regimeConfig.highIVThreshold || 70;
    const hysteresis = regimeConfig.hysteresis || 5;
    const minHoldPeriod = regimeConfig.minHoldPeriod || 3;

    // Determine regime with hysteresis
    let targetRegime: 'low' | 'mid' | 'high';
    if (iv.value < lowThreshold - hysteresis) {
      targetRegime = 'low';
    } else if (iv.value > highThreshold + hysteresis) {
      targetRegime = 'high';
    } else {
      targetRegime = 'mid';
    }

    // Check minimum hold period
    const daysSinceSwitch = (Date.now() - this.lastSwitchDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceSwitch < minHoldPeriod && targetRegime !== this.currentRegime) {
      targetRegime = this.currentRegime; // Don't switch yet
    }

    // Execute appropriate strategy based on regime
    let result: StrategyResult;
    if (targetRegime === 'low') {
      // LP only
      result = await this.lpStrategy.execute(portfolio, marketData, {
        pair: 'USDC-USDT',
        rangeWidth: 0.002,
        allocation: regimeConfig.allocation || 0.3,
      });
    } else if (targetRegime === 'high') {
      // Options only
      result = await this.optionsStrategy.execute(portfolio, marketData, {
        pair: 'ETH-USDC',
        lpRangeWidth: 0.03,
        optionStrikeDistance: 0.05,
        allocation: regimeConfig.allocation || 0.3,
      });
    } else {
      // LP + Options overlay
      const lpResult = await this.lpStrategy.execute(portfolio, marketData, {
        pair: 'USDC-USDT',
        rangeWidth: 0.002,
        allocation: (regimeConfig.allocation || 0.3) * 0.6,
      });
      const optionsResult = await this.optionsStrategy.execute(portfolio, marketData, {
        pair: 'ETH-USDC',
        lpRangeWidth: 0.03,
        optionStrikeDistance: 0.05,
        allocation: (regimeConfig.allocation || 0.3) * 0.4,
      });

      result = {
        trades: [...lpResult.trades, ...optionsResult.trades],
        positions: [...lpResult.positions, ...optionsResult.positions],
        shouldRebalance: lpResult.shouldRebalance || optionsResult.shouldRebalance,
      };
    }

    if (targetRegime !== this.currentRegime) {
      this.currentRegime = targetRegime;
      this.lastSwitchDate = new Date();
    }

    return result;
  }

  calculateExpectedYield(config: StrategyConfig, marketData: MarketData): APR {
    const iv = marketData.iv || IV.create(50);
    const lowThreshold = (config as IVRegimeConfig).lowIVThreshold || 30;
    const highThreshold = (config as IVRegimeConfig).highIVThreshold || 70;

    if (iv.value < lowThreshold) {
      return APR.create(18); // LP only
    } else if (iv.value > highThreshold) {
      return APR.create(35); // Options only
    } else {
      return APR.create(26); // LP + Options
    }
  }

  validateConfig(config: StrategyConfig): boolean {
    const regimeConfig = config as IVRegimeConfig;
    return (
      (regimeConfig.lowIVThreshold === undefined || regimeConfig.lowIVThreshold > 0) &&
      (regimeConfig.highIVThreshold === undefined ||
        regimeConfig.highIVThreshold > (regimeConfig.lowIVThreshold || 30))
    );
  }

  private validateConfigOrThrow(config: IVRegimeConfig): void {
    if (!this.validateConfig(config)) {
      throw new Error(`Invalid IVRegimeSwitcherStrategy config`);
    }
  }
}

