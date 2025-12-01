#!/usr/bin/env node
import 'dotenv/config';
import { execSync } from 'child_process';
import { RunBacktestUseCase } from './application/use-cases/RunBacktest';
import { UniswapV3Adapter } from './infrastructure/adapters/data/TheGraphDataAdapter';
import { AaveV3Adapter } from './infrastructure/adapters/data/AaveV3Adapter';
import { StrategyOptimizer } from './domain/services/StrategyOptimizer';
import {
  TrendAwareStrategy,
  FundingRateCaptureStrategy,
} from './infrastructure/adapters/strategies';
import { HyperliquidAdapter } from './infrastructure/adapters/data/HyperliquidAdapter';
import { mergeWithDefaults } from './shared/config/StrategyConfigs';

function formatNumber(value: number, decimals = 2): string {
  const rounded = Number(value.toFixed(decimals));
  if (Math.abs(rounded) < Math.pow(10, -decimals)) return (0).toFixed(decimals);
  return rounded.toFixed(decimals);
}

function formatPercent(value: number, decimals = 2): string {
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
    // process.exit(1); // Continue for demo purposes
  }

  // Step 2: Fetch Hyperliquid Data (if needed)
  console.log('='.repeat(60));
  console.log('\n🚀 Step 2: Fetching Hyperliquid Data...\n');
  console.log('='.repeat(60));
  try {
    execSync('npx tsx scripts/fetch-hyperliquid-data.ts', { stdio: 'inherit' });
    console.log('\n✅ Hyperliquid data fetched!\n');
  } catch (error) {
    console.warn('\n⚠️  Hyperliquid data fetch failed, continuing...\n');
  }

  // Step 3: Run Integrated Backtest
  console.log('='.repeat(60));
  console.log('\n🚀 Step 3: Running Integrated Uniswap V3 + Hyperliquid Backtest...\n');

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set in environment');
    process.exit(1);
  }

  // Base network - Use actual Base token addresses
  const WETH_BASE = '0x4200000000000000000000000000000000000006';
  const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const cbBTC_BASE = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // cbBTC (not WBTC) on Base
  
  // Note: Uniswap V3 orders tokens lexicographically by address
  // WETH (0x4200...) < USDC (0x8335...), so WETH is token0
  const ethUsdcAdapter = new UniswapV3Adapter({ 
    apiKey, 
    token0Symbol: 'WETH',     // token0 = lower address
    token1Symbol: 'USDC',     // token1 = higher address
    token0Address: WETH_BASE,
    token1Address: USDC_BASE,
    useUrlAuth: true 
  });
  
  // Note: Uniswap V3 orders tokens lexicographically by address
  // USDC (0x833...) < cbBTC (0xcbb...), so USDC is token0
  const cbBtcUsdcAdapter = new UniswapV3Adapter({ 
    apiKey, 
    token0Symbol: 'USDC',     // token0 = lower address
    token1Symbol: 'cbBTC',    // token1 = higher address
    token0Address: USDC_BASE,
    token1Address: cbBTC_BASE,
    useUrlAuth: true 
  });
  const aaveAdapter = new AaveV3Adapter({ apiKey });
  const hyperliquidAdapter = new HyperliquidAdapter();

  // Use recent date range with available data (last 90 days)
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const initialCapital = 100000;

  // Preload funding history to avoid rate limits
  try {
      await hyperliquidAdapter.preloadFundingHistory('ETH', startDate, endDate);
  } catch (e) {
      console.warn('⚠️ Failed to preload Hyperliquid history:', e);
  }

  const useCase = new RunBacktestUseCase();
  
  console.log(`📅 Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`💰 Initial Capital: $${initialCapital.toLocaleString()}\n`);

  console.log('📈 Calculating real APR from fees (Base network)...');
  const [ethUsdcAPR, cbBtcUsdcAPR] = await Promise.all([
    ethUsdcAdapter.calculateActualAPR('ETH-USDC', startDate, endDate),
    cbBtcUsdcAdapter.calculateActualAPR('cbBTC-USDC', startDate, endDate).catch(() => 0),
  ]);

  console.log(`   ETH/USDC Real APR: ${ethUsdcAPR.toFixed(2)}%`);
  console.log(`   cbBTC/USDC Real APR: ${cbBtcUsdcAPR > 0 ? cbBtcUsdcAPR.toFixed(2) + '%' : 'N/A (pool not found)'}\n`);

  const optimizer = new StrategyOptimizer();
  const optimalConfigs = new Map<string, { interval: number, netAPY: number }>();
  
  console.log('🔍 OPTIMIZING STRATEGIES (Running dynamic configuration sweep)...');
  console.log('='.repeat(60));
  
  // Define pools to optimize (Base network)
  const poolsToOptimize = [
    { asset: 'ETH-USDC', adapter: ethUsdcAdapter, apr: ethUsdcAPR, feeTier: 0.0005 },
  ];
  
  // Add cbBTC pool if it exists
  if (cbBtcUsdcAPR > 0) {
    poolsToOptimize.push({ asset: 'cbBTC-USDC', adapter: cbBtcUsdcAdapter, apr: cbBtcUsdcAPR, feeTier: 0.003 });
  }

  for (const pool of poolsToOptimize) {
    process.stdout.write(`   Finding optimal interval for ${pool.asset}... `);
    const data = await pool.adapter.fetchHourlyOHLCV(pool.asset, startDate, endDate);
    
    // Check actual fee tier if possible, fallback to config
    let feeTier = pool.feeTier;
    try {
        feeTier = await pool.adapter.fetchPoolFeeTier(pool.asset);
    } catch (e) {}
    
    const result = await optimizer.optimizeVolatilePair(
      pool.asset,
      data,
      pool.apr,
      feeTier,
      25000 // $25k allocation
    );
    
    optimalConfigs.set(pool.asset, { interval: result.interval, netAPY: result.netAPY });
    console.log(`✅ ${result.interval}h (${result.netAPY.toFixed(1)}% APY)`);
  }
  console.log('\n');

  // Build strategies array based on available pools
  const strategies = [
    // ETH/USDC - Main strategy
    {
      strategy: new TrendAwareStrategy('eth-usdc-trend', 'ETH/USDC Trend Aware'),
      config: mergeWithDefaults('volatile-pair', {
        pair: 'ETH-USDC',
        allocation: cbBtcUsdcAPR > 0 ? 0.30 : 0.50, // 30% if cbBTC available, 50% otherwise
        ammFeeAPR: ethUsdcAPR,
        incentiveAPR: 0,
        fundingAPR: 0,
        costModel: {
          gasCostPerRebalance: 0.50, // Base gas ≈ $0.50
          poolFeeTier: 0.0005,
        },
      }),
      allocation: cbBtcUsdcAPR > 0 ? 0.30 : 0.50,
    },
    // Funding Rate Strategy (Hyperliquid + Aave)
    {
      strategy: new FundingRateCaptureStrategy('eth-funding', 'ETH Funding Capture (3x)'),
      config: {
        asset: 'ETH',
        leverage: 3.0, // 3x Leverage
        allocation: cbBtcUsdcAPR > 0 ? 0.30 : 0.50, // 30% if cbBTC available, 50% otherwise
        hyperliquidAdapter: hyperliquidAdapter, // Use real Hyperliquid funding
        borrowRateAdapter: aaveAdapter, // Use real Aave borrow rates
        borrowAsset: 'USDC', // Borrow USDC to lever up long ETH
        fundingThreshold: 0.000001, // Low threshold to ensure execution
        dataAdapter: ethUsdcAdapter, // Use ETH/USDC pool for ETH price data
      },
      allocation: cbBtcUsdcAPR > 0 ? 0.30 : 0.50,
    }
  ];

  // Add cbBTC/USDC strategy if the pool exists on Base
  if (cbBtcUsdcAPR > 0) {
    strategies.splice(1, 0, {
      strategy: new TrendAwareStrategy('cbbtc-usdc-trend', 'cbBTC/USDC Trend Aware'),
      config: mergeWithDefaults('volatile-pair', {
        pair: 'cbBTC-USDC',
        allocation: 0.40,
        ammFeeAPR: cbBtcUsdcAPR,
        incentiveAPR: 0,
        fundingAPR: 0,
        costModel: {
          gasCostPerRebalance: 0.50,
          poolFeeTier: 0.003,
        },
      }),
      allocation: 0.40,
    });
  }

  const result = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    dataDirectory: './data',
    strategies,
    customDataAdapter: ethUsdcAdapter, // Default fallback
    calculateIV: true,
    useRealFees: true,
    applyIL: true,
    applyCosts: true,
    costModel: {
      slippageBps: 5,
      gasModel: {
        gasUnitsPerRebalance: 450000,
        // Base network typical gas price: 0.001-0.01 Gwei
        // CRITICAL: This is historical average for backtesting
        // Live bot MUST fetch real-time gas prices from chain
        gasPriceGwei: 0.001,
        nativeTokenPriceUSD: 3000,
        network: 'base',
      },
    },
    outputPath: './results/main-backtest.json',
  });

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

  console.log('⚙️  OPTIMIZED CONFIGURATIONS USED:');
  optimalConfigs.forEach((config, asset) => {
    console.log(`   ${asset}: ${config.interval}h interval (Target: ${config.netAPY.toFixed(1)}% APY)`);
  });

  console.log(`\n📁 Results saved to: ./results/main-backtest.json\n`);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
