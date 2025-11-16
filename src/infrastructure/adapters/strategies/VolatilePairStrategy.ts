import { BaseStrategy } from './BaseStrategy';
import { Portfolio, StrategyConfig, MarketData, StrategyResult } from '@domain/entities/Strategy';
import { APR, Delta, Price } from '@domain/value-objects';
import { Position } from '@domain/entities/Position';
import { Trade } from '@domain/entities/Trade';
import { RangeOptimizer } from '@shared/utils/RangeOptimizer';

export interface VolatilePairConfig extends StrategyConfig {
  pair: string;
  rangeWidth?: number; // e.g., 0.05 for ±5% - will be auto-optimized if targetAPY is set
  targetAPY?: number; // Target APY - if set, will auto-optimize rangeWidth
  optimizeForNarrowest?: boolean; // If true, finds narrowest range that maximizes net APR (requires costModel)
  rebalanceThreshold?: number; // Rebalance when price moves to X% of range (default 0.9 = 90%)
  hedgeRatio?: number; // Default 1.0 for delta neutrality
  allocation?: number;
  ammFeeAPR?: number;
  incentiveAPR?: number;
  fundingAPR?: number;
  // Cost model info for optimization (optional - can be passed from BacktestEngine)
  costModel?: {
    gasCostPerRebalance: number;
    poolFeeTier?: number;
    positionValueUSD?: number; // Will be estimated from allocation if not provided
  };
}

export class VolatilePairStrategy extends BaseStrategy {
  // Track entry price per position for rebalancing logic
  private entryPrices: Map<string, Price> = new Map();

  constructor(id: string, name: string = 'Volatile Pair Strategy') {
    super(id, name);
  }

  async execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult> {
    const volatileConfig = config as VolatilePairConfig;
    
    // Auto-optimize range width
    // Option 1: Find narrowest range that maximizes net APR (cost-aware)
    // Option 2: Find range that hits target APY
    const baseFeeAPR = volatileConfig.ammFeeAPR || 20;
    const incentiveAPR = volatileConfig.incentiveAPR || 15;
    const fundingAPR = volatileConfig.fundingAPR || 5;
    
    // Only optimize once (check if already optimized)
    if (!volatileConfig.rangeWidth || volatileConfig.rangeWidth === 0.05) {
      if (volatileConfig.optimizeForNarrowest && volatileConfig.costModel) {
        // Find narrowest range that maximizes net APR
        const allocation = volatileConfig.allocation !== undefined ? volatileConfig.allocation : 0.25;
        const totalValue = portfolio.totalValue();
        const estimatedPositionValue = totalValue.multiply(allocation).value;
        
        // Use provided position value or estimate from allocation
        const positionValueUSD = volatileConfig.costModel.positionValueUSD || estimatedPositionValue;
        
        console.log(`   🎯 Finding narrowest range that maximizes net APR (cost-aware)...`);
        const optimization = RangeOptimizer.findOptimalNarrowestRange(
          baseFeeAPR,
          incentiveAPR,
          fundingAPR,
          0.6, // Historical volatility (can be made configurable)
          0.005, // Start from ±0.5%
          0.20, // Up to ±20%
          {
            gasCostPerRebalance: volatileConfig.costModel.gasCostPerRebalance,
            poolFeeTier: volatileConfig.costModel.poolFeeTier,
            positionValueUSD: positionValueUSD,
          },
          0.001 // Test every 0.1%
        );
        
        volatileConfig.rangeWidth = optimization.optimalRangeWidth;
        console.log(`   ✅ Optimal narrowest range: ±${(optimization.optimalRangeWidth * 100).toFixed(2)}%`);
        console.log(`      Gross APY: ${optimization.expectedAPY.toFixed(2)}%`);
        if (optimization.netAPY !== undefined) {
          console.log(`      Net APY (after costs): ${optimization.netAPY.toFixed(2)}%`);
          console.log(`      Cost drag: ${optimization.annualCostDrag?.toFixed(2)}%`);
          console.log(`      Est. rebalances/year: ${optimization.rebalanceFrequency.toFixed(0)}`);
        }
      } else if (volatileConfig.targetAPY) {
        // Find range that hits target APY
        console.log(`   🎯 Auto-optimizing range width for ${volatileConfig.targetAPY}% APY target...`);
        const optimization = RangeOptimizer.findOptimalRange(
          volatileConfig.targetAPY,
          baseFeeAPR,
          incentiveAPR,
          fundingAPR,
          0.6,
          0.01,
          0.20,
          volatileConfig.costModel
        );
        
        volatileConfig.rangeWidth = optimization.optimalRangeWidth;
        console.log(`   ✅ Optimal range width: ±${(optimization.optimalRangeWidth * 100).toFixed(2)}% (expected APY: ${optimization.expectedAPY.toFixed(2)}%)`);
        if (optimization.netAPY !== undefined) {
          console.log(`      Net APY (after costs): ${optimization.netAPY.toFixed(2)}%`);
        }
      }
    }
    
    // Fallback to default if neither rangeWidth nor targetAPY provided
    if (!volatileConfig.rangeWidth) {
      volatileConfig.rangeWidth = 0.05; // Default ±5%
    }
    
    // Validate AFTER optimization
    this.validateConfigOrThrow(volatileConfig);

    const trades: Trade[] = [];
    const positions: Position[] = [];
    let shouldRebalance = false;
    let rebalanceReason: string | undefined;

    const allocation = volatileConfig.allocation !== undefined ? volatileConfig.allocation : 0.25;
    const totalValue = portfolio.totalValue();
    const allocatedAmount = totalValue.multiply(allocation);

    const existingPosition = portfolio.positions.find(
      (p) => p.strategyId === this.id && p.asset === volatileConfig.pair
    );

    const positionId = `${this.id}-${volatileConfig.pair}`;
    const rangeWidth = volatileConfig.rangeWidth;

    if (!existingPosition && allocatedAmount.value > 0) {
      // CREATE POSITION ONCE - Day 1 entry
      const lpPrice = Price.create(1.0); // LP tokens priced at $1 each
      
      // Track entry price for rebalancing (use current market price as reference)
      // This is the ETH price when we entered the LP position
      const entryPrice = marketData.price;
      this.entryPrices.set(positionId, entryPrice);
      
      const position = Position.create({
        id: positionId,
        strategyId: this.id,
        asset: volatileConfig.pair,
        amount: allocatedAmount, // LP token amount in USD value
        entryPrice: lpPrice, // LP price is always 1.0
        currentPrice: lpPrice,
      });

      positions.push(position);
      
      // Create a single trade for the full LP position
      const lpTrade = this.createTradeForStrategy(
        volatileConfig.pair,
        'buy',
        allocatedAmount,
        Price.create(1.0),
        marketData.timestamp
      );
      trades.push(lpTrade);
    } else if (existingPosition) {
      // POSITION EXISTS - Hold it, don't recreate
      // Only check for rebalancing if allocation > 0
      if (allocatedAmount.value > 0) {
        // Get the tracked entry/rebalance price
        const trackedEntryPrice = this.entryPrices.get(positionId);
        if (!trackedEntryPrice) {
          // Shouldn't happen, but fallback
          this.entryPrices.set(positionId, marketData.price);
        }
        
        const currentEntryPrice = trackedEntryPrice || marketData.price;
        
        // Calculate price change from entry/rebalance point
        const priceChange = marketData.price.percentageChange(currentEntryPrice);
        const absPriceChange = Math.abs(priceChange);
        
        // Rebalance threshold: rebalance when price moves to X% of range width (default 90%)
        // This keeps position recentered BEFORE going out of range
        // Example: ±1% range with 0.9 threshold = rebalance at ±0.9%
        const rebalanceThreshold = volatileConfig.rebalanceThreshold || 0.9;
        const rebalanceTrigger = rangeWidth * rebalanceThreshold * 100; // Convert to percentage
        
        // Rebalance if price moved to threshold (e.g., 90% of range width)
        if (absPriceChange >= rebalanceTrigger) {
          shouldRebalance = true;
          rebalanceReason = `Price moved ${absPriceChange.toFixed(2)}% from entry/rebalance point (threshold: ±${rebalanceTrigger.toFixed(2)}% = ${(rebalanceThreshold * 100).toFixed(0)}% of ±${(rangeWidth * 100).toFixed(2)}% range)`;
          
          // Update entry price to current price (new rebalance point)
          this.entryPrices.set(positionId, marketData.price);
        }

        // Update position price (keep LP price at 1.0)
        // Position amount will be adjusted by IL and yield in BacktestEngine
        const lpPrice = Price.create(1.0);
        positions.push(existingPosition.updatePrice(lpPrice));
      }
      // If allocation is 0, don't return the position (it should be closed)
    }

    return { trades, positions, shouldRebalance, rebalanceReason };
  }

  calculateExpectedYield(config: StrategyConfig, _marketData: MarketData): APR {
    const volatileConfig = config as VolatilePairConfig;
    const ammFeeAPR = volatileConfig.ammFeeAPR || 20;
    const incentiveAPR = volatileConfig.incentiveAPR || 15;
    const fundingAPR = volatileConfig.fundingAPR || 5;

    return APR.create(ammFeeAPR + incentiveAPR + fundingAPR);
  }

  validateConfig(config: StrategyConfig): boolean {
    const volatileConfig = config as VolatilePairConfig;
    const hasRangeWidth = volatileConfig.rangeWidth !== undefined;
    const hasTargetAPY = volatileConfig.targetAPY !== undefined;
    
    return (
      !!volatileConfig.pair &&
      (hasRangeWidth || hasTargetAPY) && // Must have either rangeWidth or targetAPY
      (!hasRangeWidth || (volatileConfig.rangeWidth! >= 0.01 && volatileConfig.rangeWidth! <= 0.2)) &&
      (!hasTargetAPY || (volatileConfig.targetAPY! > 0 && volatileConfig.targetAPY! < 200)) &&
      (volatileConfig.hedgeRatio === undefined ||
        (volatileConfig.hedgeRatio >= 0.8 && volatileConfig.hedgeRatio <= 1.2))
    );
  }

  private validateConfigOrThrow(config: VolatilePairConfig): void {
    if (!this.validateConfig(config)) {
      throw new Error(`Invalid VolatilePairStrategy config`);
    }
  }
}
