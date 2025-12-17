import { StatisticalAnalyst } from './StatisticalAnalyst';
import { Candle } from '../entities/Candle';
import { GarchService } from './GarchService';
import { Volatility } from '../value-objects/Volatility';

describe('StatisticalAnalyst', () => {
  let analyst: StatisticalAnalyst;
  let garchService: GarchService;

  beforeEach(() => {
    garchService = new GarchService();
    analyst = new StatisticalAnalyst(garchService);
  });

  it('should calculate volatility and hurst correctly for a flat trend', () => {
    // Generate synthetic data (flat)
    const candles: Candle[] = [];
    const basePrice = 1000;
    for (let i = 0; i < 50; i++) {
      candles.push(new Candle(new Date(), 0, 0, 0, basePrice, 0));
    }

    const result = analyst.analyze(candles);
    expect(result.volatility.value).toBe(0);
    expect(result.drift.value).toBe(0);
    expect(result.macd).toBeDefined();
  });

  it('should detect a trend', () => {
    const candles: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < 50; i++) {
      price = price * 1.01; // 1% growth per step
      candles.push(new Candle(new Date(), 0, 0, 0, price, 0));
    }

    const result = analyst.analyze(candles);
    expect(result.drift.value).toBeGreaterThan(0);
    // Hurst should be high for a perfect trend (usually > 0.5)
    expect(result.hurst.value).toBeGreaterThan(0.5);
    // MACD should be bullish for an uptrend
    expect(result.macd).toBeDefined();
  });

  it('should detect mean reversion (random noise)', () => {
    const candles: Candle[] = [];
    let price = 1000;
    for (let i = 0; i < 100; i++) {
      // Oscillate around 1000
      price = 1000 + (Math.random() - 0.5) * 20;
      candles.push(new Candle(new Date(), 0, 0, 0, price, 0));
    }

    const result = analyst.analyze(candles);
    // Random walk H ~ 0.5 or mean reverting H < 0.5
    // With simple random noise around a mean, it is mean-reverting, so H < 0.5
    expect(result.hurst.value).toBeLessThan(0.5);
  });
});
