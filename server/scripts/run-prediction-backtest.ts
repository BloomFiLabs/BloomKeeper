/**
 * Standalone script to backtest funding rate predictions
 * 
 * Usage: npx ts-node scripts/run-prediction-backtest.ts
 */

import axios from 'axios';

// Configuration
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const ASTER_API = 'https://fapi.asterdex.com';

// Prediction models (simplified versions for standalone testing)

interface HistoricalRate {
  rate: number;
  timestamp: Date;
}

interface PredictionResult {
  predictedRate: number;
  actualRate: number;
  error: number;
  directionCorrect: boolean;
}

interface BacktestMetrics {
  symbol: string;
  exchange: string;
  totalPredictions: number;
  meanAbsoluteError: number;
  rootMeanSquareError: number;
  directionalAccuracy: number;
  meanReversionMAE: number;
  premiumMAE: number;
  ensembleMAE: number;
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
    console.error(`Failed to fetch Hyperliquid history for ${symbol}: ${error.message}`);
  }
  return [];
}

/**
 * Fetch historical funding rates from Aster
 */
async function fetchAsterHistory(symbol: string, days: number = 30): Promise<HistoricalRate[]> {
  const endTime = Date.now();
  const startTime = endTime - (days * 24 * 60 * 60 * 1000);

  try {
    const response = await axios.get(`${ASTER_API}/fapi/v1/fundingRate`, {
      params: {
        symbol: `${symbol}USDT`,
        startTime,
        endTime,
        limit: 1000,
      },
      timeout: 30000,
    });

    if (Array.isArray(response.data)) {
      return response.data.map((entry: any) => ({
        rate: parseFloat(entry.fundingRate),
        timestamp: new Date(entry.fundingTime),
      })).sort((a: HistoricalRate, b: HistoricalRate) => 
        a.timestamp.getTime() - b.timestamp.getTime()
      );
    }
  } catch (error: any) {
    console.error(`Failed to fetch Aster history for ${symbol}: ${error.message}`);
  }
  return [];
}

/**
 * Mean Reversion Predictor (Ornstein-Uhlenbeck)
 */
function predictMeanReversion(history: HistoricalRate[], windowSize: number = 168): number {
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
  
  // Predict: E[X(t+1)] = theta + (X(t) - theta) * exp(-kappa)
  const currentRate = rates[rates.length - 1];
  const decay = Math.exp(-kappa);
  
  return theta + (currentRate - theta) * decay;
}

/**
 * Premium-based Predictor (uses recent rate trend)
 */
function predictPremium(history: HistoricalRate[], _windowSize: number = 24): number {
  if (history.length < 2) return history[history.length - 1]?.rate || 0;

  const recent = history.slice(-8);
  const avgRate = recent.reduce((a, b) => a + b.rate, 0) / recent.length;
  
  // Apply dampening (arbitrage will reduce premium)
  const dampening = 0.7;
  return avgRate * dampening;
}

/**
 * Ensemble Predictor (weighted average)
 */
function predictEnsemble(
  meanReversionPred: number,
  premiumPred: number,
): number {
  // Weights: Mean Reversion 60%, Premium 40%
  return meanReversionPred * 0.6 + premiumPred * 0.4;
}

/**
 * Run walk-forward backtest
 */
function runBacktest(
  history: HistoricalRate[],
  trainingWindow: number = 168,
): {
  meanReversionResults: PredictionResult[];
  premiumResults: PredictionResult[];
  ensembleResults: PredictionResult[];
} {
  const meanReversionResults: PredictionResult[] = [];
  const premiumResults: PredictionResult[] = [];
  const ensembleResults: PredictionResult[] = [];

  // Start after training window
  for (let i = trainingWindow; i < history.length - 1; i++) {
    const trainingData = history.slice(0, i);
    const actualRate = history[i].rate;

    // Mean Reversion prediction
    const mrPred = predictMeanReversion(trainingData, trainingWindow);
    meanReversionResults.push({
      predictedRate: mrPred,
      actualRate,
      error: Math.abs(mrPred - actualRate),
      directionCorrect: Math.sign(mrPred) === Math.sign(actualRate) || 
        (Math.abs(mrPred) < 1e-6 && Math.abs(actualRate) < 1e-6),
    });

    // Premium prediction
    const premPred = predictPremium(trainingData);
    premiumResults.push({
      predictedRate: premPred,
      actualRate,
      error: Math.abs(premPred - actualRate),
      directionCorrect: Math.sign(premPred) === Math.sign(actualRate) ||
        (Math.abs(premPred) < 1e-6 && Math.abs(actualRate) < 1e-6),
    });

    // Ensemble prediction
    const ensPred = predictEnsemble(mrPred, premPred);
    ensembleResults.push({
      predictedRate: ensPred,
      actualRate,
      error: Math.abs(ensPred - actualRate),
      directionCorrect: Math.sign(ensPred) === Math.sign(actualRate) ||
        (Math.abs(ensPred) < 1e-6 && Math.abs(actualRate) < 1e-6),
    });
  }

  return { meanReversionResults, premiumResults, ensembleResults };
}

/**
 * Calculate metrics from results
 */
function calculateMetrics(results: PredictionResult[]): {
  mae: number;
  rmse: number;
  directionalAccuracy: number;
} {
  if (results.length === 0) {
    return { mae: 0, rmse: 0, directionalAccuracy: 0 };
  }

  const mae = results.reduce((sum, r) => sum + r.error, 0) / results.length;
  const mse = results.reduce((sum, r) => sum + r.error ** 2, 0) / results.length;
  const rmse = Math.sqrt(mse);
  const directionalAccuracy = results.filter(r => r.directionCorrect).length / results.length;

  return { mae, rmse, directionalAccuracy };
}

/**
 * Format percentage for display
 */
function formatPct(value: number): string {
  return (value * 100).toFixed(4) + '%';
}

/**
 * Main backtest runner
 */
async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('       FUNDING RATE PREDICTION BACKTEST');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('');

  const symbols = ['ETH', 'BTC'];
  const exchanges = [
    { name: 'Hyperliquid', fetcher: fetchHyperliquidHistory },
    { name: 'Aster', fetcher: fetchAsterHistory },
  ];

  const allResults: BacktestMetrics[] = [];

  for (const symbol of symbols) {
    for (const exchange of exchanges) {
      console.log(`Fetching ${symbol} history from ${exchange.name}...`);
      
      const history = await exchange.fetcher(symbol, 30);
      
      if (history.length < 100) {
        console.log(`  ⚠️  Insufficient data: ${history.length} points (need 100+)`);
        continue;
      }

      console.log(`  ✓ Got ${history.length} data points`);
      console.log(`  Running backtest...`);

      const { meanReversionResults, premiumResults, ensembleResults } = runBacktest(history);

      const mrMetrics = calculateMetrics(meanReversionResults);
      const premMetrics = calculateMetrics(premiumResults);
      const ensMetrics = calculateMetrics(ensembleResults);

      allResults.push({
        symbol,
        exchange: exchange.name,
        totalPredictions: ensembleResults.length,
        meanAbsoluteError: ensMetrics.mae,
        rootMeanSquareError: ensMetrics.rmse,
        directionalAccuracy: ensMetrics.directionalAccuracy,
        meanReversionMAE: mrMetrics.mae,
        premiumMAE: premMetrics.mae,
        ensembleMAE: ensMetrics.mae,
      });

      console.log('');
      console.log(`  ┌─────────────────────────────────────────────────────────────┐`);
      console.log(`  │  ${symbol} / ${exchange.name}                                        │`);
      console.log(`  ├─────────────────────────────────────────────────────────────┤`);
      console.log(`  │  Predictions: ${ensembleResults.length.toString().padEnd(45)}│`);
      console.log(`  │                                                             │`);
      console.log(`  │  ENSEMBLE:                                                  │`);
      console.log(`  │    MAE:          ${formatPct(ensMetrics.mae).padEnd(42)}│`);
      console.log(`  │    RMSE:         ${formatPct(ensMetrics.rmse).padEnd(42)}│`);
      console.log(`  │    Dir Accuracy: ${(ensMetrics.directionalAccuracy * 100).toFixed(1).padEnd(3)}%                                      │`);
      console.log(`  │                                                             │`);
      console.log(`  │  INDIVIDUAL PREDICTORS:                                     │`);
      console.log(`  │    Mean Reversion MAE: ${formatPct(mrMetrics.mae).padEnd(36)}│`);
      console.log(`  │    Premium MAE:        ${formatPct(premMetrics.mae).padEnd(36)}│`);
      console.log(`  │                                                             │`);
      console.log(`  │    Mean Reversion Dir: ${(mrMetrics.directionalAccuracy * 100).toFixed(1).padEnd(3)}%                                │`);
      console.log(`  │    Premium Dir:        ${(premMetrics.directionalAccuracy * 100).toFixed(1).padEnd(3)}%                                │`);
      console.log(`  └─────────────────────────────────────────────────────────────┘`);
      console.log('');

      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Summary
  if (allResults.length > 0) {
    const avgMAE = allResults.reduce((sum, r) => sum + r.meanAbsoluteError, 0) / allResults.length;
    const avgDirAcc = allResults.reduce((sum, r) => sum + r.directionalAccuracy, 0) / allResults.length;

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('                        OVERALL SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Symbols tested:        ${allResults.length}`);
    console.log(`  Average MAE:           ${formatPct(avgMAE)}`);
    console.log(`  Average Dir Accuracy:  ${(avgDirAcc * 100).toFixed(1)}%`);
    console.log('');
    console.log('  Interpretation:');
    console.log(`    • MAE of ${formatPct(avgMAE)} means average prediction error`);
    console.log(`    • ${(avgDirAcc * 100).toFixed(0)}% directional accuracy (>50% = better than random)`);
    if (avgDirAcc > 0.6) {
      console.log('    • ✓ Model shows predictive power');
    } else if (avgDirAcc > 0.5) {
      console.log('    • ~ Model slightly better than random');
    } else {
      console.log('    • ✗ Model needs improvement');
    }
    console.log('═══════════════════════════════════════════════════════════════════');
  }
}

main().catch(console.error);

