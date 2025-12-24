/**
 * CapacityAnalyzer - Analyzes market capacity and optimal portfolio allocation
 * 
 * Key questions:
 * 1. What % of market OI would $200k represent?
 * 2. At what size do we start moving the market?
 * 3. What's the optimal allocation across symbols?
 */

import { BacktestResults, BacktestConfig, SymbolPerformance } from './types';

/**
 * Market capacity metrics
 */
export interface CapacityMetrics {
  // Capital analysis
  totalCapital: number;
  deployedCapital: number;
  utilizationPercent: number;
  
  // Market share
  estimatedTotalMarketOI: number;
  ourEstimatedOI: number;
  marketSharePercent: number;
  
  // Slippage impact
  avgSlippagePercent: number;
  slippageAtCurrentSize: number;
  slippageAt2xSize: number;
  slippageAt5xSize: number;
  
  // Optimal sizing
  optimalCapitalUtilization: number;
  recommendedMaxPositionSize: number;
  maxScalableCapital: number;
  
  // Per-symbol capacity
  symbolCapacity: SymbolCapacity[];
  
  // Recommendations
  recommendations: string[];
}

/**
 * Per-symbol capacity analysis
 */
export interface SymbolCapacity {
  symbol: string;
  estimatedOI: number;
  ourMaxPosition: number;
  marketSharePercent: number;
  avgSpread: number;
  spreadRank: number;
  capacityScore: number; // 0-100, higher = more room to scale
  recommendation: 'increase' | 'maintain' | 'decrease' | 'skip';
}

/**
 * Typical OI estimates by asset class (USD)
 * Based on typical perpetual exchange data
 */
const ESTIMATED_OI_BY_SYMBOL: Record<string, number> = {
  // Majors
  BTC: 500_000_000,
  ETH: 300_000_000,
  
  // Large caps
  SOL: 100_000_000,
  DOGE: 50_000_000,
  XRP: 50_000_000,
  AVAX: 40_000_000,
  LINK: 40_000_000,
  
  // Mid caps
  ARB: 30_000_000,
  OP: 25_000_000,
  SUI: 25_000_000,
  APT: 20_000_000,
  
  // Meme coins (high vol, lower OI)
  PEPE: 30_000_000,
  WIF: 20_000_000,
  BONK: 15_000_000,
  FARTCOIN: 10_000_000,
  
  // Default for unlisted
  DEFAULT: 10_000_000,
};

/**
 * CapacityAnalyzer - Estimates market capacity
 */
export class CapacityAnalyzer {
  private readonly config: BacktestConfig;
  
  constructor(config: BacktestConfig) {
    this.config = config;
  }
  
  /**
   * Analyze capacity from backtest results
   */
  analyze(results: BacktestResults): CapacityMetrics {
    // Calculate deployed capital (average position size * avg concurrent positions)
    const avgConcurrentPositions = this.calculateAvgConcurrentPositions(results);
    const deployedCapital = results.avgPositionSize * avgConcurrentPositions;
    
    // Estimate total market OI across traded symbols
    let totalMarketOI = 0;
    for (const [symbol] of results.symbolPerformance) {
      totalMarketOI += this.getEstimatedOI(symbol);
    }
    
    // Our estimated OI contribution
    const ourEstimatedOI = deployedCapital * results.avgLeverage;
    
    // Calculate slippage at various sizes
    const avgSlippagePercent = results.totalTradingCosts > 0
      ? (results.totalTradingCosts / (results.avgPositionSize * results.totalTrades * 2)) * 100
      : 0.05;
    
    // Slippage scales with sqrt of size
    const slippageAt2x = avgSlippagePercent * Math.sqrt(2);
    const slippageAt5x = avgSlippagePercent * Math.sqrt(5);
    
    // Optimal capital utilization
    // Rule of thumb: keep total OI < 1% of market to avoid excessive impact
    // (0.1% is too conservative for a $200k fund, 1% is a standard "medium impact" threshold)
    const maxSafeOI = totalMarketOI * 0.01; // 1% of market
    const maxScalableCapital = maxSafeOI / results.avgLeverage;
    
    // Per-symbol capacity analysis
    const symbolCapacity = this.analyzeSymbolCapacity(results);
    
    // Generate recommendations
    const recommendations = this.generateRecommendations(
      results,
      ourEstimatedOI,
      totalMarketOI,
      maxScalableCapital,
      symbolCapacity,
    );
    
    return {
      totalCapital: this.config.initialCapital,
      deployedCapital,
      utilizationPercent: (deployedCapital / this.config.initialCapital) * 100,
      
      estimatedTotalMarketOI: totalMarketOI,
      ourEstimatedOI,
      marketSharePercent: (ourEstimatedOI / totalMarketOI) * 100,
      
      avgSlippagePercent,
      slippageAtCurrentSize: avgSlippagePercent,
      slippageAt2xSize: slippageAt2x,
      slippageAt5xSize: slippageAt5x,
      
      optimalCapitalUtilization: Math.min(100, (this.config.initialCapital / maxScalableCapital) * 100),
      recommendedMaxPositionSize: Math.min(this.config.maxPositionSizeUsd, maxScalableCapital / 10),
      maxScalableCapital,
      
      symbolCapacity,
      recommendations,
    };
  }
  
  /**
   * Calculate average concurrent positions from equity curve
   */
  private calculateAvgConcurrentPositions(results: BacktestResults): number {
    if (results.equityCurve.length === 0) return 1;
    
    const totalActivePositions = results.equityCurve.reduce(
      (sum, point) => sum + point.activePositions,
      0,
    );
    
    return totalActivePositions / results.equityCurve.length;
  }
  
  /**
   * Get estimated OI for a symbol
   */
  private getEstimatedOI(symbol: string): number {
    // Try exact match first
    if (ESTIMATED_OI_BY_SYMBOL[symbol]) {
      return ESTIMATED_OI_BY_SYMBOL[symbol];
    }
    
    // Try normalized (remove numbers, common suffixes)
    const normalized = symbol.replace(/\d+/g, '').replace(/(USDT|USD|PERP)$/i, '');
    if (ESTIMATED_OI_BY_SYMBOL[normalized]) {
      return ESTIMATED_OI_BY_SYMBOL[normalized];
    }
    
    return ESTIMATED_OI_BY_SYMBOL.DEFAULT;
  }
  
  /**
   * Analyze capacity for each symbol
   */
  private analyzeSymbolCapacity(results: BacktestResults): SymbolCapacity[] {
    const capacities: SymbolCapacity[] = [];
    
    // Rank symbols by spread
    const sortedBySpread = Array.from(results.symbolPerformance.entries())
      .sort((a, b) => b[1].avgSpread - a[1].avgSpread);
    
    for (let i = 0; i < sortedBySpread.length; i++) {
      const [symbol, perf] = sortedBySpread[i];
      const estimatedOI = this.getEstimatedOI(symbol);
      
      // Our max position for this symbol
      const ourMaxPosition = perf.totalTrades > 0
        ? Math.max(...results.positions.filter(p => p.symbol === symbol).map(p => p.notionalSize))
        : this.config.maxPositionSizeUsd;
      
      // Market share for this symbol
      const symbolMarketShare = (ourMaxPosition * results.avgLeverage) / estimatedOI * 100;
      
      // Capacity score: higher OI + higher spread = more capacity
      // Penalize if we're already taking significant market share
      const oiScore = Math.min(100, (estimatedOI / ESTIMATED_OI_BY_SYMBOL.BTC) * 100);
      const spreadScore = Math.min(100, (perf.avgSpread / 0.001) * 100);
      const marketSharePenalty = Math.max(0, symbolMarketShare - 0.1) * 50;
      
      const capacityScore = Math.max(0, (oiScore * 0.4 + spreadScore * 0.6) - marketSharePenalty);
      
      // Recommendation
      let recommendation: SymbolCapacity['recommendation'];
      if (symbolMarketShare > 0.5) {
        recommendation = 'decrease';
      } else if (capacityScore > 70 && perf.totalPnL > 0) {
        recommendation = 'increase';
      } else if (perf.totalPnL < 0) {
        recommendation = 'skip';
      } else {
        recommendation = 'maintain';
      }
      
      capacities.push({
        symbol,
        estimatedOI,
        ourMaxPosition,
        marketSharePercent: symbolMarketShare,
        avgSpread: perf.avgSpread,
        spreadRank: i + 1,
        capacityScore,
        recommendation,
      });
    }
    
    return capacities.sort((a, b) => b.capacityScore - a.capacityScore);
  }
  
  /**
   * Generate actionable recommendations
   */
  private generateRecommendations(
    results: BacktestResults,
    ourOI: number,
    totalOI: number,
    maxScalable: number,
    symbolCapacity: SymbolCapacity[],
  ): string[] {
    const recommendations: string[] = [];
    
    // Overall sizing recommendation
    const currentShare = (ourOI / totalOI) * 100;
    if (currentShare < 0.01) {
      recommendations.push(
        `✅ Current market share (${currentShare.toFixed(3)}%) is minimal - significant room to scale`,
      );
      
      if (this.config.initialCapital < maxScalable * 0.5) {
        recommendations.push(
          `📈 Could deploy up to $${(maxScalable * 0.5).toLocaleString()} before significant market impact`,
        );
      }
    } else if (currentShare > 0.1) {
      recommendations.push(
        `⚠️ Market share (${currentShare.toFixed(2)}%) is elevated - may be moving markets`,
      );
      recommendations.push(
        `Consider reducing position sizes or diversifying to more symbols`,
      );
    }
    
    // APY assessment
    if (results.netAPY > 20) {
      recommendations.push(
        `💰 Net APY of ${results.netAPY.toFixed(1)}% is excellent for delta-neutral strategy`,
      );
    } else if (results.netAPY > 10) {
      recommendations.push(
        `👍 Net APY of ${results.netAPY.toFixed(1)}% is solid - comparable to traditional yield strategies`,
      );
    } else if (results.netAPY > 0) {
      recommendations.push(
        `⚡ Net APY of ${results.netAPY.toFixed(1)}% is modest - consider optimizing entry/exit`,
      );
    } else {
      recommendations.push(
        `❌ Negative APY - strategy needs adjustment before deployment`,
      );
    }
    
    // Symbol-specific recommendations
    const bestSymbols = symbolCapacity.filter(s => s.recommendation === 'increase').slice(0, 3);
    if (bestSymbols.length > 0) {
      recommendations.push(
        `🎯 Best symbols to scale: ${bestSymbols.map(s => s.symbol).join(', ')}`,
      );
    }
    
    const skipSymbols = symbolCapacity.filter(s => s.recommendation === 'skip');
    if (skipSymbols.length > 0 && skipSymbols.length <= 5) {
      recommendations.push(
        `🚫 Consider skipping: ${skipSymbols.map(s => s.symbol).join(', ')} (negative P&L)`,
      );
    }
    
    // Predictive strategy specific
    if (results.strategyMode === 'predictive' || results.strategyMode === 'hybrid') {
      if (results.directionAccuracy && results.directionAccuracy > 60) {
        recommendations.push(
          `🔮 Prediction accuracy (${results.directionAccuracy.toFixed(1)}%) indicates genuine alpha`,
        );
      } else if (results.directionAccuracy) {
        recommendations.push(
          `⚠️ Prediction accuracy (${results.directionAccuracy.toFixed(1)}%) is marginal - predictive edge unclear`,
        );
      }
    }
    
    // Risk assessment
    if (results.maxDrawdownPercent > 10) {
      recommendations.push(
        `🛡️ Max drawdown of ${results.maxDrawdownPercent.toFixed(1)}% - consider reducing leverage`,
      );
    }
    
    if (results.sharpeRatio > 2) {
      recommendations.push(
        `📊 Sharpe ratio of ${results.sharpeRatio.toFixed(2)} is excellent risk-adjusted performance`,
      );
    }
    
    return recommendations;
  }
  
  /**
   * Estimate max capital before significant market impact
   */
  estimateMaxCapacity(
    targetMarketSharePercent: number = 0.1,
    avgLeverage: number = 2,
  ): { maxCapital: number; reasoning: string } {
    // Sum up OI for typical tradeable assets
    const symbols = Object.keys(ESTIMATED_OI_BY_SYMBOL).filter(s => s !== 'DEFAULT');
    const totalOI = symbols.reduce((sum, s) => sum + ESTIMATED_OI_BY_SYMBOL[s], 0);
    
    const maxOI = totalOI * (targetMarketSharePercent / 100);
    const maxCapital = maxOI / avgLeverage;
    
    return {
      maxCapital,
      reasoning: `At ${targetMarketSharePercent}% market share across ${symbols.length} assets ` +
        `with ~$${(totalOI / 1_000_000_000).toFixed(1)}B total OI and ${avgLeverage}x avg leverage`,
    };
  }
  
  /**
   * Print capacity analysis
   */
  printAnalysis(metrics: CapacityMetrics): void {
    console.log('\n' + '='.repeat(70));
    console.log('📊 CAPACITY ANALYSIS');
    console.log('='.repeat(70));
    
    console.log('\n💰 CAPITAL DEPLOYMENT:');
    console.log(`   Total Capital: $${metrics.totalCapital.toLocaleString()}`);
    console.log(`   Deployed: $${metrics.deployedCapital.toLocaleString()} (${metrics.utilizationPercent.toFixed(1)}%)`);
    
    console.log('\n🌊 MARKET SHARE:');
    console.log(`   Est. Total Market OI: $${(metrics.estimatedTotalMarketOI / 1_000_000).toFixed(1)}M`);
    console.log(`   Our OI Contribution: $${(metrics.ourEstimatedOI / 1_000_000).toFixed(2)}M`);
    console.log(`   Market Share: ${metrics.marketSharePercent.toFixed(4)}%`);
    
    console.log('\n📈 SLIPPAGE IMPACT:');
    console.log(`   Current Size: ${metrics.slippageAtCurrentSize.toFixed(3)}%`);
    console.log(`   At 2x Size: ${metrics.slippageAt2xSize.toFixed(3)}%`);
    console.log(`   At 5x Size: ${metrics.slippageAt5xSize.toFixed(3)}%`);
    
    console.log('\n🎯 SCALING LIMITS:');
    console.log(`   Max Scalable Capital: $${metrics.maxScalableCapital.toLocaleString()}`);
    console.log(`   Recommended Max Position: $${metrics.recommendedMaxPositionSize.toLocaleString()}`);
    console.log(`   Current Utilization vs Max: ${metrics.optimalCapitalUtilization.toFixed(1)}%`);
    
    console.log('\n🏆 TOP SYMBOLS BY CAPACITY:');
    for (const sym of metrics.symbolCapacity.slice(0, 5)) {
      const rec = {
        increase: '⬆️',
        maintain: '➡️',
        decrease: '⬇️',
        skip: '🚫',
      }[sym.recommendation];
      console.log(
        `   ${rec} ${sym.symbol.padEnd(10)} | ` +
        `Score: ${sym.capacityScore.toFixed(0).padStart(3)} | ` +
        `Spread: ${(sym.avgSpread * 100).toFixed(3)}% | ` +
        `Share: ${sym.marketSharePercent.toFixed(3)}%`,
      );
    }
    
    console.log('\n💡 RECOMMENDATIONS:');
    for (const rec of metrics.recommendations) {
      console.log(`   ${rec}`);
    }
    
    console.log('='.repeat(70));
  }
}

