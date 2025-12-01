import { Injectable } from '@nestjs/common';
import { Candle } from '../entities/Candle';
import { HurstExponent } from '../value-objects/HurstExponent';
import { Volatility } from '../value-objects/Volatility';
import { DriftVelocity } from '../value-objects/DriftVelocity';
import { MACD } from '../value-objects/MACD';
import { GarchService } from './GarchService';

@Injectable()
export class StatisticalAnalyst {
  constructor(private readonly garchService: GarchService) {}

  /**
   * Calculates rolling statistics for the given window of candles.
   * Assumes candles are sorted by timestamp (oldest first).
   */
  analyze(candles: Candle[]): {
    hurst: HurstExponent;
    volatility: Volatility;
    garchVolatility: Volatility;
    drift: DriftVelocity;
    macd: MACD;
  } {
    if (candles.length < 10) {
      throw new Error('Insufficient data for analysis (min 10 candles)');
    }

    const prices = candles.map((c) => c.close);
    const returns = this.calculateLogReturns(prices);

    const hurstValue = this.calculateHurst(returns);
    const volatilityValue = this.calculateVolatility(returns);
    
    let garchVol: Volatility;
    try {
      garchVol = this.garchService.calculateVolatility(returns);
    } catch (e) {
      // Fallback if not enough data for GARCH or convergence issues
      garchVol = new Volatility(volatilityValue);
    }
    
    const driftValue = this.calculateDrift(prices, candles.length);
    const macd = this.calculateMACD(prices);

    return {
      hurst: new HurstExponent(hurstValue),
      volatility: new Volatility(volatilityValue),
      garchVolatility: garchVol,
      drift: new DriftVelocity(driftValue),
      macd,
    };
  }

  private calculateLogReturns(prices: number[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
    return returns;
  }

  private calculateHurst(returns: number[]): number {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const deviations = returns.map((r) => r - mean);

    let sum = 0;
    const cumulativeDeviations = deviations.map((d) => {
      sum += d;
      return sum;
    });

    const maxDev = Math.max(...cumulativeDeviations);
    const minDev = Math.min(...cumulativeDeviations);
    const R = maxDev - minDev;

    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
      returns.length;
    const S = Math.sqrt(variance);

    if (S === 0) return 0.5;

    const RS = R / S;
    const N = returns.length;
    // H = log(R/S) / log(N)
    return Math.log(RS) / Math.log(N);
  }

  private calculateVolatility(returns: number[]): number {
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
      returns.length;

    // Annualized Volatility (assuming hourly candles -> 365 * 24)
    const annualizationFactor = 365 * 24;
    return Math.sqrt(variance) * Math.sqrt(annualizationFactor);
  }

  private calculateDrift(prices: number[], hours: number): number {
    const startPrice = prices[0];
    const endPrice = prices[prices.length - 1];
    
    if (startPrice === 0 || endPrice === 0) return 0;
    
    const totalRet = Math.abs(Math.log(endPrice / startPrice));
    
    // FIXED: The issue is that we're extrapolating short-term moves to annual drift
    // A 8.84% move over 7 days doesn't mean 441% annual drift - it's just noise
    // Instead, calculate drift as the average hourly return, then annualize
    // But cap it aggressively to prevent absurd values
    
    // Calculate average hourly return (more stable than total return)
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i-1] > 0) {
        returns.push(Math.abs(Math.log(prices[i] / prices[i-1])));
      }
    }
    
    if (returns.length === 0) return 0;
    
    const avgHourlyReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const annualizedDrift = avgHourlyReturn * 365 * 24;
    
    // CRITICAL FIX: Cap drift to reasonable maximum (20% annual)
    // Most crypto assets don't have >20% annual drift in practice
    // This prevents the optimizer from choosing absurdly wide ranges
    // The previous 5.0 (500%) clamp was way too high
    return Math.min(annualizedDrift, 0.20); // Cap at 20% annual
  }

  /**
   * Calculates MACD (Moving Average Convergence Divergence)
   * Standard parameters: fast=12, slow=26, signal=9 periods
   * For hourly data, we use: fast=12h, slow=26h, signal=9h
   */
  private calculateMACD(prices: number[]): MACD {
    if (prices.length < 26) {
      // Not enough data, return neutral MACD
      return new MACD(0, 0, 0);
    }

    const fastPeriod = 12;
    const slowPeriod = 26;
    const signalPeriod = 9;

    // Calculate EMAs
    const fastEMA = this.calculateEMA(prices, fastPeriod);
    const slowEMA = this.calculateEMA(prices, slowPeriod);

    // MACD Line = Fast EMA - Slow EMA
    const macdLine = fastEMA - slowEMA;

    // For Signal Line, we need historical MACD values
    // We'll calculate MACD for the last signalPeriod+1 points to get the signal line
    const macdValues: number[] = [];
    for (let i = slowPeriod - 1; i < prices.length; i++) {
      const windowPrices = prices.slice(0, i + 1);
      const fast = this.calculateEMA(windowPrices, fastPeriod);
      const slow = this.calculateEMA(windowPrices, slowPeriod);
      macdValues.push(fast - slow);
    }

    // Signal Line = EMA of MACD Line
    const signalLine = this.calculateEMA(macdValues, signalPeriod);

    // Histogram = MACD Line - Signal Line
    const histogram = macdLine - signalLine;

    return new MACD(macdLine, signalLine, histogram);
  }

  /**
   * Calculates Exponential Moving Average (EMA)
   */
  private calculateEMA(data: number[], period: number): number {
    if (data.length < period) {
      // Fallback to SMA if not enough data
      const sum = data.reduce((a, b) => a + b, 0);
      return sum / data.length;
    }

    // Multiplier = 2 / (period + 1)
    const multiplier = 2 / (period + 1);

    // Start with SMA of first 'period' values
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    // Calculate EMA for remaining values
    for (let i = period; i < data.length; i++) {
      ema = (data[i] - ema) * multiplier + ema;
    }

    return ema;
  }
}
