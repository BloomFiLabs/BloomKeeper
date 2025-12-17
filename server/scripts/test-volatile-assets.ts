/**
 * Test prediction on volatile assets
 */
import axios from 'axios';

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

interface HistoricalRate {
  rate: number;
  timestamp: Date;
}

async function fetchHistory(symbol: string, days: number = 30): Promise<HistoricalRate[]> {
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
      return response.data.map((e: any) => ({
        rate: parseFloat(e.fundingRate),
        timestamp: new Date(e.time),
      })).sort((a: HistoricalRate, b: HistoricalRate) => 
        a.timestamp.getTime() - b.timestamp.getTime()
      );
    }
  } catch (e) {
    // silent fail
  }
  return [];
}

function predictMeanReversion(history: HistoricalRate[], windowSize: number, horizonHours: number): number {
  if (history.length < windowSize) return history[history.length - 1]?.rate || 0;
  const window = history.slice(-windowSize);
  const rates = window.map(h => h.rate);
  const theta = rates.reduce((a, b) => a + b, 0) / rates.length;
  
  const n = rates.length - 1;
  let sumXY = 0, sumX = 0, sumY = 0, sumX2 = 0;
  for (let i = 1; i < rates.length; i++) {
    sumXY += rates[i - 1] * rates[i];
    sumX += rates[i - 1];
    sumY += rates[i];
    sumX2 += rates[i - 1] ** 2;
  }
  const denom = n * sumX2 - sumX ** 2;
  const b = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0.9;
  const kappa = Math.max(0.01, Math.min(2, -Math.log(Math.max(Math.abs(b), 0.01))));
  const currentRate = rates[rates.length - 1];
  return theta + (currentRate - theta) * Math.exp(-kappa * horizonHours);
}

function runBacktest(history: HistoricalRate[], trainingWindow: number, horizonHours: number) {
  const errors: number[] = [];
  const dirCorrect: boolean[] = [];
  
  for (let i = trainingWindow; i < history.length - horizonHours; i++) {
    const trainingData = history.slice(0, i);
    const actualRate = history[i + horizonHours - 1].rate;
    const predicted = predictMeanReversion(trainingData, trainingWindow, horizonHours);
    errors.push(Math.abs(predicted - actualRate));
    dirCorrect.push(
      Math.sign(predicted) === Math.sign(actualRate) || 
      (Math.abs(predicted) < 1e-6 && Math.abs(actualRate) < 1e-6)
    );
  }
  
  if (errors.length === 0) return null;
  
  const mae = errors.reduce((a, b) => a + b, 0) / errors.length;
  const dirAcc = dirCorrect.filter(x => x).length / dirCorrect.length;
  return { predictions: errors.length, mae, dirAcc };
}

async function testAsset(symbol: string) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${symbol} - VOLATILE ASSET PREDICTION TEST`);
  console.log('═'.repeat(70));
  
  const history = await fetchHistory(symbol, 30);
  
  if (history.length < 50) {
    console.log(`  ⚠️ Insufficient data: ${history.length} points`);
    return;
  }
  
  console.log(`  Data points: ${history.length}`);
  
  // Rate statistics
  const rates = history.map(h => h.rate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const avg = rates.reduce((a,b) => a+b, 0) / rates.length;
  const stdDev = Math.sqrt(rates.reduce((s, r) => s + (r - avg) ** 2, 0) / rates.length);
  
  console.log(`\n  Rate Statistics (30 days):`);
  console.log(`    Min:     ${(min * 100).toFixed(4)}%`);
  console.log(`    Max:     ${(max * 100).toFixed(4)}%`);
  console.log(`    Average: ${(avg * 100).toFixed(4)}%`);
  console.log(`    Std Dev: ${(stdDev * 100).toFixed(4)}%`);
  console.log(`    Range:   ${((max - min) * 100).toFixed(4)}% (${((max-min)/stdDev).toFixed(1)}σ)`);
  
  // Backtest at different horizons
  const horizons = [1, 2, 4, 8, 24];
  const trainingWindow = Math.min(72, Math.floor(history.length * 0.4)); // Shorter window for volatile assets
  
  console.log(`\n  Prediction Accuracy (${trainingWindow}h training window):`);
  console.log('  ┌──────────┬─────────────┬────────────┬──────────────┐');
  console.log('  │ Horizon  │ Predictions │    MAE     │ Dir Accuracy │');
  console.log('  ├──────────┼─────────────┼────────────┼──────────────┤');
  
  for (const h of horizons) {
    if (history.length < trainingWindow + h + 10) continue;
    const result = runBacktest(history, trainingWindow, h);
    if (!result) continue;
    
    console.log(
      '  │ ' + `${h}h`.padStart(6) + '   │   ' +
      result.predictions.toString().padStart(5) + '     │ ' +
      `${(result.mae * 100).toFixed(4)}%`.padStart(9) + ' │    ' +
      `${(result.dirAcc * 100).toFixed(1)}%`.padStart(5) + '     │'
    );
  }
  console.log('  └──────────┴─────────────┴────────────┴──────────────┘');
}

async function main() {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     VOLATILE ASSET FUNDING RATE PREDICTION BACKTEST                  ║');
  console.log('║     Testing on high-volatility assets with swinging funding rates    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  
  // Test on volatile assets
  const volatileAssets = ['OM', 'MOVE', 'MERL', 'DOGE', 'PEPE', 'WIF', 'BONK'];
  
  for (const asset of volatileAssets) {
    await testAsset(asset);
    await new Promise(r => setTimeout(r, 300)); // Rate limit
  }
  
  console.log('\n');
  console.log('═'.repeat(70));
  console.log('  INTERPRETATION');
  console.log('═'.repeat(70));
  console.log('  • Volatile assets have wider rate ranges and higher std dev');
  console.log('  • Directional accuracy >60% = model has predictive power');
  console.log('  • Directional accuracy >70% = strong signal for trading');
  console.log('  • MAE shows average prediction error magnitude');
  console.log('═'.repeat(70));
}

main().catch(console.error);

