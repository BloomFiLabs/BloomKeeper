/**
 * CostModel - Models realistic trading costs for backtest
 * 
 * Includes:
 * - Exchange fees (maker/taker)
 * - Slippage (sqrt market impact model)
 * - Basis risk (mark price divergence)
 */

import { BacktestConfig } from './types';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

/**
 * Cost breakdown for a trade
 */
export interface TradeCosts {
  hyperliquidFee: number;
  lighterFee: number;
  totalFees: number;
  hyperliquidSlippage: number;
  lighterSlippage: number;
  totalSlippage: number;
  basisRiskCost: number;
  totalCost: number;
}

/**
 * CostModel - Calculates realistic trading costs
 */
export class CostModel {
  private readonly config: BacktestConfig;
  
  constructor(config: BacktestConfig) {
    this.config = config;
  }
  
  /**
   * Calculate total entry costs for a position
   * Uses maker fees for limit orders (our strategy uses limit at mark)
   */
  calculateEntryCosts(
    notionalSize: number,
    hyperliquidLiquidity: number = 1000000, // Approximate OI/liquidity in USD
    lighterLiquidity: number = 500000,
    basisDivergenceBps: number = 0,
  ): TradeCosts {
    return this.calculateCosts(
      notionalSize,
      hyperliquidLiquidity,
      lighterLiquidity,
      basisDivergenceBps,
      true, // isEntry - use maker fees
    );
  }
  
  /**
   * Calculate total exit costs for a position
   * Uses taker fees for market exits
   */
  calculateExitCosts(
    notionalSize: number,
    hyperliquidLiquidity: number = 1000000,
    lighterLiquidity: number = 500000,
    basisDivergenceBps: number = 0,
  ): TradeCosts {
    return this.calculateCosts(
      notionalSize,
      hyperliquidLiquidity,
      lighterLiquidity,
      basisDivergenceBps,
      false, // isExit - use taker fees
    );
  }
  
  /**
   * Internal cost calculation
   */
  private calculateCosts(
    notionalSize: number,
    hyperliquidLiquidity: number,
    lighterLiquidity: number,
    basisDivergenceBps: number,
    isEntry: boolean,
  ): TradeCosts {
    // Fees - maker for entry (limit orders), taker for exit (market orders)
    const hlFeeRate = isEntry 
      ? this.config.hyperliquidMakerFee 
      : this.config.hyperliquidTakerFee;
    const lighterFeeRate = isEntry 
      ? this.config.lighterMakerFee 
      : this.config.lighterTakerFee;
    
    const hyperliquidFee = notionalSize * hlFeeRate;
    const lighterFee = notionalSize * lighterFeeRate;
    const totalFees = hyperliquidFee + lighterFee;
    
    // Slippage - Square root market impact model
    // slippage = base_slippage + sqrt_factor * sqrt(size / liquidity)
    const hyperliquidSlippage = this.calculateSlippage(notionalSize, hyperliquidLiquidity);
    const lighterSlippage = this.calculateSlippage(notionalSize, lighterLiquidity);
    const totalSlippage = hyperliquidSlippage + lighterSlippage;
    
    // Basis risk - cost from mark price divergence between venues
    // Calculated as absolute basis divergence * position size
    const basisRiskCost = (Math.abs(basisDivergenceBps) / 10000) * notionalSize;
    
    return {
      hyperliquidFee,
      lighterFee,
      totalFees,
      hyperliquidSlippage,
      lighterSlippage,
      totalSlippage,
      basisRiskCost,
      totalCost: totalFees + totalSlippage + basisRiskCost,
    };
  }
  
  /**
   * Calculate slippage using square root market impact model
   * 
   * Formula: slippage% = base + sqrt_factor * sqrt(size / liquidity)
   * 
   * This models:
   * - Small orders: near-zero slippage
   * - Medium orders: proportional slippage
   * - Large orders: diminishing but still significant slippage
   */
  private calculateSlippage(notionalSize: number, liquidity: number): number {
    if (liquidity <= 0) {
      // No liquidity = max slippage (cap at 2%)
      return notionalSize * 0.02;
    }
    
    const sizeRatio = notionalSize / liquidity;
    const sqrtImpact = Math.sqrt(sizeRatio);
    
    const slippagePercent = this.config.baseSlippagePercent + 
      (this.config.sqrtImpactFactor * sqrtImpact);
    
    // Cap slippage at 2% to prevent unrealistic values
    const cappedSlippage = Math.min(slippagePercent, 0.02);
    
    return notionalSize * cappedSlippage;
  }
  
  /**
   * Calculate break-even time in hours
   * 
   * How long does it take for funding income to cover entry + exit costs?
   */
  calculateBreakEvenHours(
    notionalSize: number,
    hourlySpread: number, // Annualized spread / 8760
    entryCosts: TradeCosts,
    exitCosts: TradeCosts,
  ): number {
    const totalCosts = entryCosts.totalCost + exitCosts.totalCost;
    
    // Hourly funding return = notional * hourly spread
    const hourlyReturn = notionalSize * hourlySpread;
    
    if (hourlyReturn <= 0) {
      return Infinity;
    }
    
    return totalCosts / hourlyReturn;
  }
  
  /**
   * Calculate round-trip costs as a percentage of notional
   */
  calculateRoundTripCostPercent(
    notionalSize: number,
    hyperliquidLiquidity: number = 1000000,
    lighterLiquidity: number = 500000,
    basisDivergenceBps: number = 0,
  ): number {
    const entryCosts = this.calculateEntryCosts(
      notionalSize,
      hyperliquidLiquidity,
      lighterLiquidity,
      basisDivergenceBps,
    );
    
    const exitCosts = this.calculateExitCosts(
      notionalSize,
      hyperliquidLiquidity,
      lighterLiquidity,
      basisDivergenceBps,
    );
    
    const totalCost = entryCosts.totalCost + exitCosts.totalCost;
    return (totalCost / notionalSize) * 100;
  }
  
  /**
   * Estimate optimal position size given liquidity constraints
   * 
   * We want slippage + fees to be < expected funding profit
   * Target: round-trip costs < X% of expected daily funding
   */
  calculateOptimalPositionSize(
    hyperliquidLiquidity: number,
    lighterLiquidity: number,
    expectedDailySpread: number, // As decimal, e.g., 0.001 = 0.1% per day
    maxCostToRewardRatio: number = 0.3, // Max 30% of daily funding goes to costs
  ): number {
    const minLiquidity = Math.min(hyperliquidLiquidity, lighterLiquidity);
    
    // Start with 5% of minimum liquidity as base
    let optimalSize = minLiquidity * 0.05;
    
    // Iterate to find size where cost ratio is acceptable
    for (let i = 0; i < 10; i++) {
      const roundTripCostPercent = this.calculateRoundTripCostPercent(
        optimalSize,
        hyperliquidLiquidity,
        lighterLiquidity,
      );
      
      // Expected daily profit = size * daily spread
      const expectedDailyProfit = optimalSize * expectedDailySpread;
      const costToRewardRatio = (optimalSize * (roundTripCostPercent / 100)) / expectedDailyProfit;
      
      if (costToRewardRatio > maxCostToRewardRatio) {
        // Reduce size
        optimalSize *= 0.7;
      } else if (costToRewardRatio < maxCostToRewardRatio * 0.5) {
        // Can increase size
        optimalSize *= 1.2;
      } else {
        // Good range
        break;
      }
    }
    
    // Enforce liquidity cap: never more than 5% of min liquidity
    return Math.min(optimalSize, minLiquidity * 0.05);
  }
  
  /**
   * Get fee schedule summary
   */
  getFeeSchedule(): {
    hyperliquidMaker: string;
    hyperliquidTaker: string;
    lighterMaker: string;
    lighterTaker: string;
    roundTripExample: string;
  } {
    const exampleSize = 10000;
    const roundTrip = this.calculateRoundTripCostPercent(exampleSize);
    
    return {
      hyperliquidMaker: `${(this.config.hyperliquidMakerFee * 100).toFixed(3)}%`,
      hyperliquidTaker: `${(this.config.hyperliquidTakerFee * 100).toFixed(3)}%`,
      lighterMaker: `${(this.config.lighterMakerFee * 100).toFixed(3)}%`,
      lighterTaker: `${(this.config.lighterTakerFee * 100).toFixed(3)}%`,
      roundTripExample: `${roundTrip.toFixed(3)}% on $${exampleSize.toLocaleString()}`,
    };
  }
}


