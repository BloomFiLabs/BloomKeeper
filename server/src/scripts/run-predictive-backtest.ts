/**
 * Run Predictive Arbitrage Backtest
 * 
 * Usage:
 *   npx ts-node src/scripts/run-predictive-backtest.ts [options]
 * 
 * Options:
 *   --mode=reactive|predictive|hybrid  Strategy mode (default: all three)
 *   --capital=200000                   Initial capital (default: 200000)
 *   --compare                          Run all modes and compare
 *   --symbols=BTC,ETH,SOL              Whitelist specific symbols
 *   --verbose                          Show detailed output
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  SimulationEngine,
  CapacityAnalyzer,
  BacktestResults,
  DEFAULT_BACKTEST_CONFIG,
  StrategyMode,
} from '../backtest/predictive-arbitrage';

/**
 * Parse command line arguments
 */
function parseArgs(): {
  mode: StrategyMode | 'compare';
  capital: number;
  symbols: string[];
  verbose: boolean;
} {
  const args = process.argv.slice(2);
  let mode: StrategyMode | 'compare' = 'compare';
  let capital = 200000;
  let symbols: string[] = [];
  let verbose = false;
  
  for (const arg of args) {
    if (arg.startsWith('--mode=')) {
      const value = arg.split('=')[1];
      if (['reactive', 'predictive', 'hybrid', 'compare'].includes(value)) {
        mode = value as StrategyMode | 'compare';
      }
    } else if (arg.startsWith('--capital=')) {
      capital = parseInt(arg.split('=')[1], 10) || 200000;
    } else if (arg.startsWith('--symbols=')) {
      symbols = arg.split('=')[1].split(',').map(s => s.trim().toUpperCase());
    } else if (arg === '--compare') {
      mode = 'compare';
    } else if (arg === '--verbose') {
      verbose = true;
    }
  }
  
  return { mode, capital, symbols, verbose };
}

/**
 * Format currency
 */
function formatCurrency(value: number): string {
  if (Math.abs(value) >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  } else if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(2)}`;
}

/**
 * Save equity curve to CSV
 */
function saveEquityCurve(results: BacktestResults): void {
  const dir = path.join(process.cwd(), 'backtest-results');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const filename = `equity-curve-${results.strategyMode}-${new Date().getTime()}.csv`;
  const filePath = path.join(dir, filename);
  
  const header = 'Timestamp,Equity,Drawdown,DrawdownPercent,ActivePositions\n';
  const rows = results.equityCurve.map(p => 
    `${p.timestamp.toISOString()},${p.equity.toFixed(2)},${p.drawdown.toFixed(2)},${p.drawdownPercent.toFixed(4)},${p.activePositions}`
  ).join('\n');
  
  fs.writeFileSync(filePath, header + rows);
  console.log(`\n💾 Hourly equity curve saved to: ${filePath}`);
}

/**
 * Print backtest results
 */
function printResults(results: BacktestResults, verbose: boolean = false): void {
  console.log('\n' + '═'.repeat(70));
  console.log(`📈 BACKTEST RESULTS: ${results.strategyMode.toUpperCase()} STRATEGY`);
  console.log('═'.repeat(70));
  
  // Period info
  console.log(`\n📅 Period: ${results.startDate.toISOString().split('T')[0]} to ${results.endDate.toISOString().split('T')[0]}`);
  console.log(`   Duration: ${Math.round(results.totalHours / 24)} days (${results.totalHours} hours)`);
  
  // Capital metrics
  console.log('\n💰 CAPITAL:');
  console.log(`   Initial: ${formatCurrency(results.initialCapital)}`);
  console.log(`   Final: ${formatCurrency(results.finalCapital)}`);
  console.log(`   Peak: ${formatCurrency(results.peakCapital)}`);
  console.log(`   Total P&L: ${formatCurrency(results.totalPnL)} (${((results.totalPnL / results.initialCapital) * 100).toFixed(2)}%)`);
  
  // P&L breakdown
  console.log('\n📊 P&L BREAKDOWN:');
  console.log(`   Funding P&L: ${formatCurrency(results.totalFundingPnL)}`);
  console.log(`   Price P&L: ${formatCurrency(results.totalPricePnL)} (Premium Capture)`);
  console.log(`   Trading Costs: ${formatCurrency(-results.totalTradingCosts)}`);
  console.log(`   Net P&L: ${formatCurrency(results.totalPnL)}`);
  
  // Performance
  console.log('\n🎯 PERFORMANCE:');
  console.log(`   Gross APY: ${results.grossAPY.toFixed(2)}%`);
  console.log(`   Net APY: ${results.netAPY.toFixed(2)}%`);
  console.log(`   Sharpe Ratio: ${results.sharpeRatio.toFixed(2)}`);
  console.log(`   Sortino Ratio: ${results.sortinoRatio.toFixed(2)}`);
  console.log(`   Calmar Ratio: ${results.calmarRatio.toFixed(2)}`);
  
  // Risk
  console.log('\n🛡️ RISK:');
  console.log(`   Max Drawdown: ${formatCurrency(results.maxDrawdown)} (${results.maxDrawdownPercent.toFixed(2)}%)`);
  
  // Trade stats
  console.log('\n🔄 TRADES:');
  console.log(`   Total Trades: ${results.totalTrades}`);
  console.log(`   Winning: ${results.winningTrades} (${results.winRate.toFixed(1)}%)`);
  console.log(`   Losing: ${results.losingTrades}`);
  console.log(`   Avg Trade Profit: ${formatCurrency(results.avgTradeProfit)}`);
  console.log(`   Avg Win: ${formatCurrency(results.avgWin)}`);
  console.log(`   Avg Loss: ${formatCurrency(results.avgLoss)}`);
  console.log(`   Profit Factor: ${results.profitFactor.toFixed(2)}`);
  console.log(`   Avg Holding Period: ${results.avgHoldingPeriodHours.toFixed(1)} hours`);
  
  // Prediction metrics (if applicable)
  if (results.strategyMode !== 'reactive' && results.predictionAccuracy !== undefined) {
    console.log('\n🔮 PREDICTION METRICS:');
    console.log(`   Direction Accuracy: ${results.directionAccuracy?.toFixed(1)}%`);
    console.log(`   Avg Prediction Error: ${((results.avgPredictionError || 0) * 100).toFixed(4)}%`);
  }
  
  // Position sizing
  console.log('\n📐 POSITION SIZING:');
  console.log(`   Avg Position Size: ${formatCurrency(results.avgPositionSize)}`);
  console.log(`   Max Position Size: ${formatCurrency(results.maxPositionSize)}`);
  console.log(`   Avg Leverage: ${results.avgLeverage.toFixed(2)}x`);
  console.log(`   Est. Market Share: ${results.estimatedMarketSharePercent.toFixed(4)}%`);
  
  // Top symbols (if verbose)
  if (verbose && results.symbolPerformance.size > 0) {
    console.log('\n🏆 TOP PERFORMING SYMBOLS:');
    const sorted = Array.from(results.symbolPerformance.values())
      .sort((a, b) => b.totalPnL - a.totalPnL)
      .slice(0, 10);
    
    for (const sym of sorted) {
      const pnlColor = sym.totalPnL >= 0 ? '✅' : '❌';
      console.log(
        `   ${pnlColor} ${sym.symbol.padEnd(12)} | ` +
        `P&L: ${formatCurrency(sym.totalPnL).padStart(10)} | ` +
        `Trades: ${sym.totalTrades.toString().padStart(3)} | ` +
        `Win: ${sym.winRate.toFixed(0)}%`,
      );
    }
  }
  
  console.log('═'.repeat(70));
}

/**
 * Print comparison table
 */
function printComparison(results: Map<StrategyMode, BacktestResults>): void {
  console.log('\n' + '═'.repeat(90));
  console.log('📊 STRATEGY COMPARISON');
  console.log('═'.repeat(90));
  
  const modes: StrategyMode[] = ['reactive', 'predictive', 'hybrid'];
  
  // Header
  console.log('\n' + 'Metric'.padEnd(25) + modes.map(m => m.toUpperCase().padStart(20)).join(''));
  console.log('-'.repeat(90));
  
  // Metrics to compare
  const metrics: Array<{ name: string; getter: (r: BacktestResults) => string }> = [
    { name: 'Net APY', getter: r => `${r.netAPY.toFixed(2)}%` },
    { name: 'Total P&L', getter: r => formatCurrency(r.totalPnL) },
    { name: 'Sharpe Ratio', getter: r => r.sharpeRatio.toFixed(2) },
    { name: 'Max Drawdown', getter: r => `${r.maxDrawdownPercent.toFixed(2)}%` },
    { name: 'Win Rate', getter: r => `${r.winRate.toFixed(1)}%` },
    { name: 'Total Trades', getter: r => r.totalTrades.toString() },
    { name: 'Profit Factor', getter: r => r.profitFactor.toFixed(2) },
    { name: 'Avg Holding Hours', getter: r => r.avgHoldingPeriodHours.toFixed(1) },
    { name: 'Prediction Accuracy', getter: r => r.directionAccuracy ? `${r.directionAccuracy.toFixed(1)}%` : 'N/A' },
  ];
  
  for (const metric of metrics) {
    const row = metric.name.padEnd(25) + modes.map(m => {
      const result = results.get(m);
      return result ? metric.getter(result).padStart(20) : 'N/A'.padStart(20);
    }).join('');
    console.log(row);
  }
  
  console.log('-'.repeat(90));
  
  // Determine winner
  const netAPYs = modes.map(m => ({ mode: m, apy: results.get(m)?.netAPY || 0 }));
  const winner = netAPYs.sort((a, b) => b.apy - a.apy)[0];
  
  console.log(`\n🏆 Best Performer: ${winner.mode.toUpperCase()} with ${winner.apy.toFixed(2)}% APY`);
  
  // Predictive advantage
  const reactive = results.get('reactive');
  const predictive = results.get('predictive');
  if (reactive && predictive) {
    const advantage = predictive.netAPY - reactive.netAPY;
    const pct = (advantage / reactive.netAPY) * 100;
    if (advantage > 0) {
      console.log(`📈 Predictive advantage: +${advantage.toFixed(2)}% APY (+${pct.toFixed(1)}% improvement)`);
    } else {
      console.log(`📉 Predictive underperformance: ${advantage.toFixed(2)}% APY (${pct.toFixed(1)}%)`);
    }
  }
  
  console.log('═'.repeat(90));
}

/**
 * Main function
 */
async function main(): Promise<void> {
  console.log('\n🚀 PREDICTIVE FUNDING RATE ARBITRAGE BACKTESTER\n');
  
  const { mode, capital, symbols, verbose } = parseArgs();
  
  console.log(`Configuration:`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Capital: ${formatCurrency(capital)}`);
  console.log(`  Symbols: ${symbols.length > 0 ? symbols.join(', ') : 'All available'}`);
  console.log(`  Verbose: ${verbose}`);
  
  // Create config
  const config = {
    ...DEFAULT_BACKTEST_CONFIG,
    initialCapital: capital,
    symbolWhitelist: symbols,
  };
  
  // Use current working directory (should be server/)
  const baseDir = process.cwd();
  
  try {
    // Get data summary first
    const engine = new SimulationEngine(config, baseDir);
    const summary = await engine.getDataSummary();
    
    console.log(`\n📂 Data Summary:`);
    console.log(`  Symbols: ${summary.symbolCount}`);
    console.log(`  Hours: ${summary.totalHours}`);
    console.log(`  Date Range: ${summary.dateRange}`);
    console.log(`  Avg Spread: ${(summary.spreadStats.avgSpread * 100).toFixed(4)}%`);
    console.log(`  Positive Spread: ${summary.spreadStats.positiveSpreadPercent.toFixed(1)}%`);
    
    if (mode === 'compare') {
      // Run all three modes and compare
      const results = new Map<StrategyMode, BacktestResults>();
      
      for (const m of ['reactive', 'predictive', 'hybrid'] as StrategyMode[]) {
        console.log(`\n⏳ Running ${m} backtest...`);
        const engine = new SimulationEngine(config, baseDir);
        const result = await engine.runBacktest(m, (pct, msg) => {
          process.stdout.write(`\r   ${msg.padEnd(60)} [${pct}%]`);
        });
        console.log('');
        results.set(m, result);
        saveEquityCurve(result);
      }
      
      // Print individual results
      for (const [m, result] of results) {
        printResults(result, verbose);
      }
      
      // Print comparison
      printComparison(results);
      
      // Run capacity analysis on best performer
      const bestMode = Array.from(results.entries())
        .sort((a, b) => b[1].netAPY - a[1].netAPY)[0];
      
      console.log(`\n📊 Capacity analysis for best performer (${bestMode[0]}):`);
      const capacityAnalyzer = new CapacityAnalyzer(config);
      const capacity = capacityAnalyzer.analyze(bestMode[1]);
      capacityAnalyzer.printAnalysis(capacity);
      
    } else {
      // Run single mode
      console.log(`\n⏳ Running ${mode} backtest...`);
      const result = await engine.runBacktest(mode as StrategyMode, (pct, msg) => {
        process.stdout.write(`\r   ${msg.padEnd(60)} [${pct}%]`);
      });
      console.log('');
      
      printResults(result, verbose);
      saveEquityCurve(result);
      
      // Run capacity analysis
      const capacityAnalyzer = new CapacityAnalyzer(config);
      const capacity = capacityAnalyzer.analyze(result);
      capacityAnalyzer.printAnalysis(capacity);
    }
    
    console.log('\n✅ Backtest complete!\n');
    
  } catch (error: any) {
    console.error(`\n❌ Error: ${error.message}`);
    if (error.message.includes('No cached historical data')) {
      console.log('\nTo collect historical data, run the server with:');
      console.log('  pnpm start:dev\n');
      console.log('Wait ~1 hour for initial data collection, then run this backtest again.');
    }
    process.exit(1);
  }
}

// Run
main().catch(console.error);

