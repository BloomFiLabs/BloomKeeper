/**
 * Multi-horizon prediction backtest
 * Tests prediction accuracy at 1h, 4h, 8h, and 24h horizons
 */

import axios from 'axios';

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

interface HistoricalRate {
  rate: number;
  timestamp: Date;
}

interface HorizonResults {
  horizon: number;
  predictions: number;
  mae: number;
  rmse: number;
  directionalAccuracy: number;
}

/**
 * Fetch historical funding rates from Hyperliquid
 */
async function fetchHyperliquidHistory(symbol: string, days: number = 30): Promise<HistoricalRate[]> {
  const endTime = Date.now();
  const startTime = endTime - (days * 24 * 60 * 60 * 1000);

  try {
    const response = await axios.post(HYPERLIQUID_API, {
      type: 'fundingHistory',
      coin: symbol,
      startTime,
      endTime,
    }, { timeout: 30000 });

    if (Array.isArray(response.data)) {
      return response.data.map((entry: any) => ({
        rate: parseFloat(entry.fundingRate),
        timestamp: new Date(entry.time),
      })).sort((a: HistoricalRate, b: HistoricalRate) => 
        a.timestamp.getTime() - b.timestamp.getTime()
      );
    }
  } catch (error: any) {
    console.error(`Failed to fetch history: ${error.message}`);
  }
  return [];
}

/**
 * Mean Reversion Predictor with configurable horizon
 */
function predictMeanReversion(
  history: HistoricalRate[], 
  windowSize: number,
  horizonHours: number
): number {
  if (history.length < windowSize) return history[history.length - 1]?.rate || 0;

  const window = history.slice(-windowSize);
  const rates = window.map(h => h.rate);
  
  // Calculate mean (theta)
  const theta = rates.reduce((a, b) => a + b, 0) / rates.length;
  
  // Estimate kappa from AR(1)
  const n = rates.length - 1;
  let sumXY = 0, sumX = 0, sumY = 0, sumX2 = 0;
  
  for (let i = 1; i < rates.length; i++) {
    sumXY += rates[i - 1] * rates[i];
    sumX += rates[i - 1];
    sumY += rates[i];
    sumX2 += rates[i - 1] ** 2;
  }
  
  const b = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX ** 2);
  const kappa = Math.max(0.01, Math.min(2, -Math.log(Math.max(b, 0.01))));
  
  // Predict: E[X(t+h)] = theta + (X(t) - theta) * exp(-kappa * h)
  const currentRate = rates[rates.length - 1];
  const decay = Math.exp(-kappa * horizonHours);
  
  return theta + (currentRate - theta) * decay;
}

/**
 * Run backtest for a specific horizon
 */
function runHorizonBacktest(
  history: HistoricalRate[],
  trainingWindow: number,
  horizonHours: number,
): HorizonResults {
  const errors: number[] = [];
  const directionalCorrect: boolean[] = [];

  // Start after training window, end before horizon
  for (let i = trainingWindow; i < history.length - horizonHours; i++) {
    const trainingData = history.slice(0, i);
    const actualRate = history[i + horizonHours - 1].rate; // Rate at horizon

    const predicted = predictMeanReversion(trainingData, trainingWindow, horizonHours);
    
    errors.push(Math.abs(predicted - actualRate));
    directionalCorrect.push(
      Math.sign(predicted) === Math.sign(actualRate) ||
      (Math.abs(predicted) < 1e-6 && Math.abs(actualRate) < 1e-6)
    );
  }

  const mae = errors.reduce((a, b) => a + b, 0) / errors.length;
  const mse = errors.reduce((a, b) => a + b ** 2, 0) / errors.length;
  const rmse = Math.sqrt(mse);
  const directionalAccuracy = directionalCorrect.filter(x => x).length / directionalCorrect.length;

  return {
    horizon: horizonHours,
    predictions: errors.length,
    mae,
    rmse,
    directionalAccuracy,
  };
}

/**
 * Format percentage
 */
function formatPct(value: number): string {
  return (value * 100).toFixed(4) + '%';
}

/**
 * Main
 */
async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('              MULTI-HORIZON FUNDING RATE PREDICTION BACKTEST');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('Testing prediction accuracy at different time horizons...');
  console.log('');

  const symbols = ['ETH', 'BTC'];
  const horizons = [1, 2, 4, 8, 12, 24]; // hours ahead
  const trainingWindow = 168; // 7 days

  for (const symbol of symbols) {
    console.log(`Fetching ${symbol} history...`);
    const history = await fetchHyperliquidHistory(symbol, 30);
    
    if (history.length < 200) {
      console.log(`  ⚠️  Insufficient data: ${history.length} points`);
      continue;
    }

    console.log(`  ✓ Got ${history.length} data points`);
    console.log('');

    console.log(`┌────────────────────────────────────────────────────────────────────────┐`);
    console.log(`│  ${symbol} - PREDICTION ACCURACY BY HORIZON                              │`);
    console.log(`├──────────┬─────────────┬───────────────┬──────────────┬────────────────┤`);
    console.log(`│ Horizon  │ Predictions │ MAE           │ RMSE         │ Dir Accuracy   │`);
    console.log(`├──────────┼─────────────┼───────────────┼──────────────┼────────────────┤`);

    const results: HorizonResults[] = [];

    for (const horizon of horizons) {
      const result = runHorizonBacktest(history, trainingWindow, horizon);
      results.push(result);

      const horizonStr = `${horizon}h`.padStart(4);
      const predsStr = result.predictions.toString().padStart(5);
      const maeStr = formatPct(result.mae).padStart(10);
      const rmseStr = formatPct(result.rmse).padStart(10);
      const dirStr = `${(result.directionalAccuracy * 100).toFixed(1)}%`.padStart(8);

      console.log(`│  ${horizonStr}    │    ${predsStr}    │  ${maeStr}   │  ${rmseStr}  │    ${dirStr}     │`);
    }

    console.log(`└──────────┴─────────────┴───────────────┴──────────────┴────────────────┘`);
    console.log('');

    // Calculate accuracy decay
    const h1Acc = results[0].directionalAccuracy;
    const h24Acc = results[results.length - 1].directionalAccuracy;
    const decayRate = ((h1Acc - h24Acc) / h1Acc * 100).toFixed(1);

    console.log(`  📊 Analysis:`);
    console.log(`     • 1h accuracy:  ${(h1Acc * 100).toFixed(1)}%`);
    console.log(`     • 24h accuracy: ${(h24Acc * 100).toFixed(1)}%`);
    console.log(`     • Decay rate:   ${decayRate}% over 24 hours`);
    
    // Find usable horizon threshold (>60% directional accuracy)
    const usableHorizon = results.find(r => r.directionalAccuracy < 0.6);
    if (usableHorizon) {
      const lastUsable = results[results.indexOf(usableHorizon) - 1];
      console.log(`     • Usable horizon: Up to ${lastUsable?.horizon || 1}h (>60% accuracy)`);
    } else {
      console.log(`     • Usable horizon: All tested horizons maintain >60% accuracy`);
    }
    
    console.log('');
    console.log('');

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('                              CONCLUSIONS');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Hyperliquid funding is paid HOURLY, so:');
  console.log('');
  console.log('  ✓ 1h prediction = Next funding payment');
  console.log('  ✓ 8h prediction = ~8 funding payments ahead (same as CEX 8h window)');
  console.log('  ✓ 24h prediction = Full day of funding payments');
  console.log('');
  console.log('  For arbitrage decisions:');
  console.log('  • Use 1-4h predictions for entry/exit timing');
  console.log('  • Use 8-24h predictions for position sizing and hold duration');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════');
}

main().catch(console.error);

