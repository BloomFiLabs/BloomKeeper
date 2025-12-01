/**
 * Range Optimizer
 * Optimizes LP range width to hit target APY
 */

import { Price, Amount, APR } from '../../domain/value-objects';

export interface OptimizationResult {
  optimalRangeWidth: number;
  expectedAPY: number; // Gross APY (before costs)
  netAPY?: number; // Net APY (after costs)
  rebalanceFrequency: number; // Estimated rebalances per year
  feeCaptureEfficiency: number; // Estimated % of time in range
  annualCostDrag?: number; // Annual cost drag in percentage points
}

export class RangeOptimizer {
  /**
   * Estimate APY for a given range width
   */
  static estimateAPYForRange(
    rangeWidth: number,
    baseFeeAPR: number,
    incentiveAPR: number,
    fundingAPR: number,
    historicalVolatility: number = 0.6,
    costModel?: {
      gasCostPerRebalance: number; 
      poolFeeTier?: number;
      positionValueUSD?: number;
    },
    trendVelocity: number = 0 // Absolute trend drift per year
  ): OptimizationResult {
    
    const rangePercent = rangeWidth * 100;
    const volatilityPercent = historicalVolatility * 100;
    
    // FIXED: Efficiency ratio - more realistic for mean-reverting assets
    // Use normal distribution approximation: what % of time is price within range?
    const rangeStdDevRatio = rangePercent / volatilityPercent;
    // CRITICAL FIX: Lower efficiency floor to 0.10 (was 0.40)
    // Do not promise 40% efficiency on bad ranges - in high vol/trending markets,
    // narrow positions can be out of range 95% of the time
    const efficiencyRatio = Math.min(0.98, Math.max(0.10, 
      rangeStdDevRatio > 2 ? 0.95 :  // If range > 2x volatility, nearly always in range
      rangeStdDevRatio > 1 ? 0.75 + (rangeStdDevRatio - 1) * 0.20 : // 1σ to 2σ
      rangeStdDevRatio > 0.5 ? 0.40 + (rangeStdDevRatio - 0.5) * 0.70 : // 0.5σ to 1σ (steeper penalty)
      0.10 + rangeStdDevRatio * 0.60 // < 0.5σ (much steeper penalty for very narrow ranges)
    ));
    
    // FIXED: Fee concentration - use realistic exponent (was 1.5, now 0.8)
    const referenceRangeWidth = 0.05; 
    const feeDensityMultiplier = Math.pow(referenceRangeWidth / rangeWidth, 0.8);
    
    const effectiveFeeAPR = baseFeeAPR * feeDensityMultiplier * efficiencyRatio;
    const totalAPR = effectiveFeeAPR + incentiveAPR + fundingAPR;
    
    // CRITICAL FIX: Rebalance Frequency - use QUADRATIC diffusion model
    // Price diffusion (Brownian motion) scales with the SQUARE of volatility relative to range width
    // If you halve the range width, you hit the edge 4x as often (not 2x)!
    const rebalanceThreshold = 0.95; // Rebalance at 95% to edge (was 0.9)
    const effectiveRangeWidth = rangeWidth * rebalanceThreshold; // Effective range we use (95% of full range)
    const rangeWidthPercent = effectiveRangeWidth * 100;
    
    // Volatility component: QUADRATIC scaling (vol/width)^2
    // Scalar calibrated from backtest data: 1.20 (was 1.5, which overestimated by 20%)
    // Accounts for: 1) fat tails (crypto crashes faster), 2) price wicks, 3) kurtosis
    const volRatio = volatilityPercent / rangeWidthPercent;
    const volatilityScalar = 1.20; // Calibrated from backtest data
    const volatilityRebalances = Math.pow(volRatio, 2) * volatilityScalar;
    
    // Drift component - Linear is correct here: Velocity / Distance
    const driftDecimal = Math.abs(trendVelocity); // Already in decimal form
    const driftRebalances = (driftDecimal * 100) / rangeWidthPercent; // How many range-widths we drift per year
    
    // Total Frequency
    const rebalanceFrequency = Math.max(1, volatilityRebalances + driftRebalances);
    
    let annualCostDrag = 0;
    let netAPY = totalAPR;
    
    if (costModel) {
      const gasCostPerRebalance = costModel.gasCostPerRebalance;
      
      let poolFeeCostPerRebalance = 0;
      if (costModel.poolFeeTier && costModel.positionValueUSD) {
        const estimatedSwapNotional = costModel.positionValueUSD * 0.5;
        poolFeeCostPerRebalance = estimatedSwapNotional * costModel.poolFeeTier;
      }
      
      const totalCostPerRebalance = gasCostPerRebalance + poolFeeCostPerRebalance;
      const annualCosts = totalCostPerRebalance * rebalanceFrequency;
      
      if (costModel.positionValueUSD && costModel.positionValueUSD > 0) {
        annualCostDrag = (annualCosts / costModel.positionValueUSD) * 100;
        netAPY = totalAPR - annualCostDrag;
      }
    }
    
    return {
      optimalRangeWidth: rangeWidth,
      expectedAPY: totalAPR,
      netAPY: costModel ? netAPY : undefined,
      rebalanceFrequency,
      feeCaptureEfficiency: efficiencyRatio * 100,
      annualCostDrag: costModel ? annualCostDrag : undefined,
    };
  }

  static findOptimalRange(
    targetAPY: number,
    baseFeeAPR: number,
    incentiveAPR: number,
    fundingAPR: number,
    historicalVolatility: number = 0.6,
    minRange: number = 0.01,
    maxRange: number = 0.20,
    costModel?: {
      gasCostPerRebalance: number;
      poolFeeTier?: number;
      positionValueUSD?: number;
    }
  ): OptimizationResult {
    let bestResult: OptimizationResult | null = null;
    let smallestDiff = Number.POSITIVE_INFINITY;
    const steps = 100;

    for (let i = 0; i <= steps; i++) {
      const w = minRange + (maxRange - minRange) * (i / steps);
      const res = this.estimateAPYForRange(
        w,
        baseFeeAPR,
        incentiveAPR,
        fundingAPR,
        historicalVolatility,
        costModel
      );
      const diff = Math.abs(res.expectedAPY - targetAPY);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        bestResult = res;
      }
    }

    return bestResult ?? this.estimateAPYForRange(
      minRange,
      baseFeeAPR,
      incentiveAPR,
      fundingAPR,
      historicalVolatility,
      costModel
    );
  }

  static findOptimalNarrowestRange(
    baseFeeAPR: number,
    incentiveAPR: number,
    fundingAPR: number,
    historicalVolatility: number = 0.6,
    minRange: number = 0.005,
    maxRange: number = 0.20,
    costModel: {
      gasCostPerRebalance: number;
      poolFeeTier?: number;
      positionValueUSD: number;
    },
    trendVelocity: number = 0 
  ): OptimizationResult {
    if (!costModel.positionValueUSD || costModel.positionValueUSD <= 0) {
      throw new Error('positionValueUSD is required for cost calculation');
    }

    // Numerical Search for Max Net APY
    let bestWidth = minRange;
    let bestNetAPY = -Infinity;
    let bestResult: OptimizationResult | null = null;

    const steps = 100;
    for (let i = 0; i <= steps; i++) {
        const w = minRange + (maxRange - minRange) * (i / steps);
        
        const res = this.estimateAPYForRange(
            w, baseFeeAPR, incentiveAPR, fundingAPR, historicalVolatility, 
            costModel, trendVelocity
        );
        
        const net = res.netAPY || -Infinity;
        if (net > bestNetAPY) {
            bestNetAPY = net;
            bestWidth = w;
            bestResult = res;
        }
    }

    return bestResult!;
  }
}
