import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OptimalLeverageService } from '../infrastructure/services/OptimalLeverageService';
import { GarchService } from '../domain/services/GarchService';
import { ExchangeType } from '../domain/value-objects/ExchangeConfig';
import { RealFundingPaymentsService } from '../infrastructure/services/RealFundingPaymentsService';
import { HistoricalFundingRateService } from '../infrastructure/services/HistoricalFundingRateService';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Script to backtest different K-factors for Sigma-Distance leverage model
 */
async function runBacktest() {
  console.log('🚀 Starting Leverage K-Factor Backtest...');

  const symbols = ['MOODENG'];
  const kFactors = [3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
  const lookbackHours = 24 * 30; // 30 days of test data
  
  const results: any[] = [];

  for (const symbol of symbols) {
    console.log(`\n📊 Testing ${symbol}...`);
    
    // 1. Fetch historical candles (hourly)
    const candles = await fetchCandles(symbol, lookbackHours);
    if (candles.length < 100) {
      console.warn(`⚠️ Insufficient data for ${symbol}, skipping.`);
      continue;
    }

    // 2. Run simulation for each K
    for (const k of kFactors) {
      const stats = simulateKFactor(symbol, candles, k);
      results.push({
        symbol,
        k,
        ...stats
      });
    }
  }

  // 3. Print Summary Table
  console.log('\n' + '='.repeat(150));
  console.log('📈 BACKTEST RESULTS SUMMARY (Starting Capital: $1000)');
  console.log('='.repeat(150));
  console.log('Symbol | K-Factor | Avg Lev | Max Drawdown | Would Liquidate | Buffer % | Final Capital | Max Move Time');
  console.log('-'.repeat(150));

  for (const res of results) {
    console.log(
      `${res.symbol.padEnd(6)} | ` +
      `${res.k.toFixed(1).padEnd(8)} | ` +
      `${res.avgLeverage.toFixed(1).padEnd(7)} | ` +
      `${(res.maxDrawdown * 100).toFixed(2).padStart(11)}% | ` +
      `${(res.wouldLiquidate ? '🚨 YES' : '✅ NO').padEnd(15)} | ` +
      `${(res.avgBuffer * 100).toFixed(1).padStart(7)}% | ` +
      `$${res.finalCapital.toFixed(2).padStart(8)} | ` +
      `${res.maxDrawdownTime ? res.maxDrawdownTime.toISOString() : 'N/A'}`
    );
  }
  console.log('='.repeat(150));
}

async function fetchCandles(symbol: string, hours: number): Promise<any[]> {
  const endTime = Date.now();
  const startTime = endTime - hours * 60 * 60 * 1000;

  try {
    const response = await axios.post(
      'https://api.hyperliquid.xyz/info',
      {
        type: 'candleSnapshot',
        req: {
          coin: symbol,
          interval: '15m',
          startTime,
          endTime,
        },
      },
      { timeout: 10000 },
    );

    return Array.isArray(response.data) ? response.data : [];
  } catch (error: any) {
    return [];
  }
}

function simulateKFactor(symbol: string, candles: any[], k: number) {
  let wouldLiquidate = false;
  let totalLeverage = 0;
  let totalBuffer = 0;
  let maxDrawdown = 0;
  let maxDrawdownTime: Date | null = null;
  let maxDrawdownType: string = '';
  
  const extremeMoves: { time: Date, move: number, type: string }[] = [];
  
  const windowSize = 672; // 7 day lookback for volatility (672 * 15m)
  const fundingRate = symbol === 'BTC' || symbol === 'ETH' ? 0.00005 : 0.00015;
  let capital = 1000;
  
  for (let i = windowSize; i < candles.length; i++) {
    const window = candles.slice(i - windowSize, i);
    const returns: number[] = [];
    for (let j = 1; j < window.length; j++) {
      returns.push((parseFloat(window[j].c) - parseFloat(window[j - 1].c)) / parseFloat(window[j - 1].c));
    }
    
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const intervalVol = Math.sqrt(variance);
    const dailyVol = intervalVol * Math.sqrt(96);

    const leverage = Math.min(10, 1 / (k * dailyVol));
    totalLeverage += leverage;

    if (!wouldLiquidate) {
      capital += capital * leverage * fundingRate;
    }

    const currentPrice = parseFloat(candles[i-1].c);
    const lowPrice = parseFloat(candles[i].l);
    const highPrice = parseFloat(candles[i].h);
    
    const liqDistance = 1 / leverage;
    totalBuffer += liqDistance;

    const moveDown = (currentPrice - lowPrice) / currentPrice;
    const moveUp = (highPrice - currentPrice) / currentPrice;
    
    const worstMove = Math.max(moveDown, moveUp);
    
    // Log any move over 20%
    if (worstMove > 0.20) {
      extremeMoves.push({
        time: new Date(candles[i].t),
        move: worstMove,
        type: moveDown > moveUp ? 'DOWN' : 'UP'
      });
    }

    if (worstMove > maxDrawdown) {
      maxDrawdown = worstMove;
      maxDrawdownTime = new Date(candles[i].t);
      maxDrawdownType = moveDown > moveUp ? 'DOWN' : 'UP';
    }

    if (!wouldLiquidate && worstMove >= liqDistance * 0.9) {
      wouldLiquidate = true;
      capital = 0;
    }
  }

  // Print extreme moves if this is the first K-factor iteration (to avoid duplicate logs)
  if (k === 3.0 && extremeMoves.length > 0) {
    console.log(`\n🚨 Extreme Moves (>20%) for ${symbol}:`);
    extremeMoves.forEach(m => {
      console.log(`   - ${m.time.toISOString()}: ${(m.move * 100).toFixed(2)}% ${m.type}`);
    });
  }

  const count = candles.length - windowSize;
  return {
    avgLeverage: totalLeverage / count,
    avgBuffer: totalBuffer / count,
    maxDrawdown,
    maxDrawdownTime,
    maxDrawdownType,
    wouldLiquidate,
    finalCapital: capital
  };
}

runBacktest().catch(err => console.error(err));

