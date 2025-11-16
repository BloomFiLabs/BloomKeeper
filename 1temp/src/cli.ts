#!/usr/bin/env node
/**
 * Primary CLI entry point for Bloom Backtesting Framework
 * Runs tests, then executes main backtest with optimal configuration
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { RunBacktestUseCase } from './application/use-cases/RunBacktest';
import { UniswapV3Adapter } from './infrastructure/adapters/data/TheGraphDataAdapter';
import {
  VolatilePairStrategy,
  OptionsOverlayStrategy,
} from './infrastructure/adapters/strategies';
import { mergeWithDefaults } from './shared/config/StrategyConfigs';

// Helper formatting utilities for cleaner console output
function formatNumber(value: number, decimals = 2): string {
  const rounded = Number(value.toFixed(decimals));
  // Avoid showing "-0.00" for very small negatives
  if (Math.abs(rounded) < Math.pow(10, -decimals)) {
    return (0).toFixed(decimals);
  }
  return rounded.toFixed(decimals);
}

function formatPercent(value: number, decimals = 2): string {
  return formatNumber(value, decimals);
}

function formatDays(value: number, decimals = 2): string {
  return formatNumber(value, decimals);
}

async function main() {
  console.log('🌱 Bloom Backtesting Framework\n');
  console.log('='.repeat(60));

  // Step 1: Run tests
  console.log('\n📋 Step 1: Running Tests...\n');
  try {
    execSync('npm test -- --run', { stdio: 'inherit' });
    console.log('\n✅ All tests passed!\n');
  } catch (error) {
    console.error('\n❌ Tests failed! Fix tests before running backtest.\n');
    process.exit(1);
  }

  // Step 2: Run main backtest
  console.log('='.repeat(60));
  console.log('\n🚀 Step 2: Running Main Backtest...\n');

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set in environment');
    process.exit(1);
  }

  const adapter = new UniswapV3Adapter({
    apiKey,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    useUrlAuth: true,
  });

  const useCase = new RunBacktestUseCase();

  // Use full year of historical data
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');
  const initialCapital = 100000;

  console.log(`📅 Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`💰 Initial Capital: $${initialCapital.toLocaleString()}\n`);

  // Calculate real APR
  console.log('📈 Calculating real APR from fees...');
  const realAPR = await adapter.calculateActualAPR('ETH-USDC', startDate, endDate);
  console.log(`   Real APR: ${realAPR.toFixed(2)}%\n`);

  const result = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    dataDirectory: './data',
    strategies: [
      {
        strategy: new VolatilePairStrategy('vp1', 'ETH/USDC Volatile Pair'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          optimizeForNarrowest: true, // Find narrowest range that maximizes net APR (cost-aware)
          ammFeeAPR: realAPR, // Use real APR
          incentiveAPR: 15,
          fundingAPR: 5,
          allocation: 0.4,
        }),
        allocation: 0.4,
      },
      {
        strategy: new OptionsOverlayStrategy('op1', 'ETH/USDC Options Overlay'),
        config: mergeWithDefaults('options-overlay', {
          pair: 'ETH-USDC',
          lpRangeWidth: 0.03, // ±3% range
          optionStrikeDistance: 0.05,
          allocation: 0.3,
        }),
        allocation: 0.3,
      },
    ],
    customDataAdapter: adapter,
    calculateIV: true,
    useRealFees: true,
    applyIL: true,
    applyCosts: true, // Apply realistic costs (gas + pool fees)
    costModel: {
      slippageBps: 5, // 0.05% slippage for range adjustment
      // Gas model: Base L2 network (much lower gas costs than mainnet)
      // Typical rebalance on Base: burn LP (~100k gas) + swap (~150k gas) + mint LP (~200k gas) = ~450k gas
      // Base gas prices: ~0.01-0.1 Gwei (vs 30+ Gwei on mainnet)
      // Using Base network - gas price will be fetched automatically, or use ~0.1 Gwei default
      gasModel: {
        gasUnitsPerRebalance: 450000, // Total gas for full rebalance operation
        network: 'base', // Will fetch real-time gas price from Base RPC
        nativeTokenPriceUSD: 3000, // ETH price in USD
        // gasPriceGwei: 0.1, // Optional: override if you want to set manually
      },
      // poolFeeTier will be fetched automatically from The Graph
    },
    outputPath: './results/main-backtest.json',
  });

  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const annualizedReturn = result.metrics.totalReturn;

  console.log('\n' + '='.repeat(60));
  console.log('✅ BACKTEST COMPLETE!');
  console.log('='.repeat(60) + '\n');

  console.log('📊 PORTFOLIO METRICS:');
  console.log(`   Initial Capital: $${initialCapital.toLocaleString()}`);
  console.log(`   Final Value: $${result.metrics.finalValue.toFixed(2)}`);
  console.log(`   Total Return: ${formatPercent(result.metrics.totalReturn)}%`);
  console.log(`   Annualized Return: ${formatPercent(annualizedReturn)}% APY`);
  console.log(`   Total PnL: $${(result.metrics.finalValue - initialCapital).toFixed(2)}\n`);

  console.log('📈 RISK METRICS:');
  console.log(`   Sharpe Ratio: ${formatNumber(result.metrics.sharpeRatio, 4)}`);
  console.log(`   Max Drawdown: ${formatPercent(result.metrics.maxDrawdown)}%\n`);

  console.log('💼 TRADING ACTIVITY:');
  console.log(`   Total Trades: ${result.trades.length}`);
  console.log(`   Final Positions: ${result.positions.length}\n`);

  // Display position metrics
  if (result.positionMetrics && result.positionMetrics.size > 0) {
    console.log('📊 POSITION METRICS:');
    for (const [positionId, metrics] of result.positionMetrics.entries()) {
      const position = result.positions.find(p => p.id === positionId);
      if (position && metrics) {
        console.log(`\n   ${position.asset} (${positionId}):`);
        console.log(`      Entry Date: ${metrics.entryDate.toISOString().split('T')[0]}`);
        console.log(`      Entry Price: $${metrics.entryPrice.value.toFixed(2)}`);
        console.log(`      Current Price: $${metrics.currentPrice.value.toFixed(2)}`);
        console.log(`      Total Price Change: ${formatPercent(metrics.totalPriceChange)}%`);
        console.log(`      Max Deviation: ${formatPercent(metrics.maxPriceDeviation)}%`);
        console.log(`      Min Deviation: ${formatPercent(metrics.minPriceDeviation)}%`);
        console.log(`      Rebalances: ${metrics.rebalanceCount}`);
        const totalDaysInSample = metrics.daysInRange + metrics.daysOutOfRange;
        const inRangePct = totalDaysInSample > 0 ? (metrics.daysInRange / totalDaysInSample) * 100 : 0;
        const outOfRangePct = totalDaysInSample > 0 ? (metrics.daysOutOfRange / totalDaysInSample) * 100 : 0;
        console.log(`      Days In Range: ${formatDays(metrics.daysInRange)} (${formatPercent(inRangePct, 1)}%)`);
        console.log(`      Days Out of Range: ${formatDays(metrics.daysOutOfRange)} (${formatPercent(outOfRangePct, 1)}%)`);
        console.log(`      Fee Capture Efficiency: ${formatPercent(metrics.feeCaptureEfficiency)}%`);
        console.log(`      Total Fees Earned: $${metrics.totalFeesEarned.toFixed(2)}`);
        console.log(`      Expected Fees (if always in range): $${metrics.expectedFees.toFixed(2)}`);
        console.log(`      Fee Capture Rate: ${formatPercent(metrics.feeCaptureRate)}%`);
        console.log(`      Current IL: ${formatPercent(metrics.currentIL)}%`);
        console.log(`      Max IL (worst): ${formatPercent(metrics.maxIL)}%`);
        
        // Show rebalance costs if available
        const totalRebalanceCosts = (metrics as any).totalRebalanceCosts;
        if (totalRebalanceCosts !== undefined && totalRebalanceCosts > 0) {
          console.log(`      Total Rebalance Costs: $${totalRebalanceCosts.toFixed(2)}`);
          const positionValue = position.marketValue().value;
          if (positionValue > 0) {
            const costDragPercent = (totalRebalanceCosts / positionValue) * 100;
            console.log(`      Cost Drag: ${formatPercent(costDragPercent, 2)}% of position value`);
            
            // Calculate net APY (fees earned - cost drag)
            const feesAPR = (metrics.totalFeesEarned / positionValue) * 100;
            const netAPR = feesAPR - costDragPercent;
            console.log(`      Gross Fee APR: ${formatPercent(feesAPR, 2)}%`);
            console.log(`      Net Fee APR (after costs): ${formatPercent(netAPR, 2)}%`);
          }
        }
        
        if (metrics.rebalanceEvents.length > 0) {
          console.log(`      Rebalance Events:`);
          metrics.rebalanceEvents.slice(0, 5).forEach((event: any, i: number) => {
            console.log(`         ${i + 1}. ${event.date.toISOString().split('T')[0]}: ${event.reason}`);
            console.log(`            Price: $${event.priceBefore.value.toFixed(2)} → $${event.priceAfter.value.toFixed(2)} (${event.priceChange > 0 ? '+' : ''}${event.priceChange.toFixed(2)}%)`);
          });
          if (metrics.rebalanceEvents.length > 5) {
            console.log(`         ... and ${metrics.rebalanceEvents.length - 5} more`);
          }
        }
      }
    }
    console.log('');
  }

  console.log('📋 STRATEGIES TESTED:');
  console.log('   1. Volatile Pair Strategy (ETH/USDC)');
  console.log(`      - Range: ±5%`);
  console.log(`      - Allocation: 40%`);
  console.log(`      - Real Fee APR: ${realAPR.toFixed(2)}%`);
  console.log(`      - Incentive APR: 15.00%`);
  console.log(`      - Funding APR: 5.00%`);
  console.log(`      - Total Expected APR: ${(realAPR + 15 + 5).toFixed(2)}%`);
  
  // Calculate Options Overlay APR
  const optionsAPR = 15 + (50 * 0.01 * 52); // LP fees + options overlay
  console.log('   2. Options Overlay Strategy (ETH/USDC)');
  console.log(`      - Range: ±3%`);
  console.log(`      - Allocation: 30%`);
  console.log(`      - Real Fee APR: ${realAPR.toFixed(2)}%`);
  console.log(`      - Options Overlay APR: ~${(50 * 0.01 * 52).toFixed(2)}%`);
  console.log(`      - Total Expected APR: ~${optionsAPR.toFixed(2)}%\n`);

  console.log(`📁 Results saved to: ./results/main-backtest.json\n`);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
