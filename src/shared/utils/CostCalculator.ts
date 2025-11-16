/**
 * Cost Calculator
 * Calculates slippage, gas costs, and Uniswap pool fees for trades and rebalances
 */

import { Amount, Price } from '@domain/value-objects';
import { Trade } from '@domain/entities/Trade';
import { Position } from '@domain/entities/Position';
import { GasPriceService } from './GasPriceService';

export interface CostModel {
  slippageBps: number; // Basis points (e.g., 10 = 0.1%)
  gasCostUSD?: number; // Gas cost in USD per transaction (deprecated - use gasModel instead)
  gasModel?: {
    gasUnitsPerRebalance: number; // Gas units for a full rebalance (mint + burn + swap)
    gasPriceGwei?: number; // Current gas price in Gwei (optional - will fetch if network provided)
    nativeTokenPriceUSD: number; // Price of native token (ETH) in USD
    network?: string; // Network name (e.g., 'base', 'mainnet', 'arbitrum') - will fetch gas price if provided
  };
  poolFeeTier?: number; // Uniswap pool fee tier (e.g., 0.0005 = 0.05%, 0.003 = 0.3%, 0.01 = 1%)
}

export class CostCalculator {
  private slippageBps: number;
  private gasCostUSD: number; // Legacy field for backward compatibility
  private gasModel?: {
    gasUnitsPerRebalance: number;
    gasPriceGwei?: number;
    nativeTokenPriceUSD: number;
    network?: string;
  };
  private poolFeeTier?: number; // Pool fee tier as decimal (e.g., 0.003 = 0.3%)
  private cachedGasPriceGwei?: number; // Cache fetched gas price to avoid repeated RPC calls

  constructor(config: CostModel = { slippageBps: 10, gasCostUSD: 50 }) {
    this.slippageBps = config.slippageBps;
    this.gasCostUSD = config.gasCostUSD || 50; // Default to 50 if not provided
    this.gasModel = config.gasModel;
    this.poolFeeTier = config.poolFeeTier;
  }

  /**
   * Calculate slippage cost for a trade
   * @param trade The trade to calculate slippage for
   * @returns Slippage amount in USD
   */
  calculateSlippage(trade: Trade): Amount {
    const tradeValue = trade.totalCost().value;
    const slippagePercent = this.slippageBps / 10000; // Convert bps to decimal
    const slippageAmount = tradeValue * slippagePercent;
    return Amount.create(slippageAmount);
  }

  /**
   * Get gas cost for a transaction
   * Uses gasModel if available, otherwise falls back to gasCostUSD
   * @returns Gas cost in USD
   */
  getGasCost(): Amount {
    if (this.gasModel && this.gasModel.gasPriceGwei) {
      // Calculate: gasUnits * (gasPriceGwei / 1e9) * nativeTokenPriceUSD
      const gasCostETH = (this.gasModel.gasUnitsPerRebalance * this.gasModel.gasPriceGwei) / 1e9;
      const gasCostUSD = gasCostETH * this.gasModel.nativeTokenPriceUSD;
      return Amount.create(gasCostUSD);
    }
    return Amount.create(this.gasCostUSD);
  }

  /**
   * Estimate gas cost for a rebalance operation
   * Fetches real-time gas price if network is provided (cached after first fetch)
   * @returns Gas cost in USD
   */
  async estimateGasCostUSD(): Promise<number> {
    if (this.gasModel) {
      let gasPriceGwei = this.gasModel.gasPriceGwei;
      
      // Fetch real-time gas price if network is provided and not already cached
      if (this.gasModel.network && !gasPriceGwei && this.cachedGasPriceGwei === undefined) {
        try {
          const gasPriceResult = await GasPriceService.fetchGasPrice(this.gasModel.network);
          gasPriceGwei = gasPriceResult.gasPriceGwei;
          this.cachedGasPriceGwei = gasPriceGwei; // Cache for subsequent calls
        } catch (error) {
          console.warn(`⚠️  Failed to fetch gas price, using default for ${this.gasModel.network}`);
          // Use network default
          const networkConfig = GasPriceService.getNetworkConfig(this.gasModel.network);
          gasPriceGwei = networkConfig?.defaultGasPriceGwei || 0.1;
          this.cachedGasPriceGwei = gasPriceGwei; // Cache the fallback
        }
      } else if (this.cachedGasPriceGwei !== undefined) {
        // Use cached gas price
        gasPriceGwei = this.cachedGasPriceGwei;
      }
      
      if (!gasPriceGwei) {
        gasPriceGwei = 0.1; // Default fallback
      }
      
      const gasCostETH = (this.gasModel.gasUnitsPerRebalance * gasPriceGwei) / 1e9;
      return gasCostETH * this.gasModel.nativeTokenPriceUSD;
    }
    return this.gasCostUSD;
  }

  /**
   * Estimate Uniswap pool fee cost for a rebalance
   * A rebalance typically involves:
   * 1. Burning old LP position (no fee)
   * 2. Swapping tokens to rebalance (pays pool fee)
   * 3. Minting new LP position (no fee)
   * 
   * We approximate this as: positionValue * poolFeeTier
   * (assuming we swap roughly half the position value to rebalance)
   * 
   * @param position The LP position being rebalanced
   * @param marketPrice Current market price for calculating position value
   * @returns Pool fee cost in USD
   */
  estimateRebalanceFeeCost(position: Position, marketPrice: Price): Amount {
    if (!this.poolFeeTier) {
      return Amount.create(0); // No pool fee configured
    }

    // Calculate position value in USD
    const positionValue = position.marketValue().value;
    
    // Estimate swap notional: typically need to swap ~50% of position value to rebalance
    // This is a conservative estimate - actual swap amount depends on price deviation
    const estimatedSwapNotional = positionValue * 0.5;
    
    // Pool fee = swap notional * fee tier
    // Fee tier is already a decimal (e.g., 0.003 = 0.3%)
    const poolFeeCost = estimatedSwapNotional * this.poolFeeTier;
    
    return Amount.create(poolFeeCost);
  }

  /**
   * Estimate total rebalance cost (gas + pool fees)
   * @param position The LP position being rebalanced
   * @param marketPrice Current market price
   * @returns Total rebalance cost in USD
   */
  async estimateTotalRebalanceCost(position: Position, marketPrice: Price): Promise<Amount> {
    const gasCost = await this.estimateGasCostUSD();
    const poolFeeCost = this.estimateRebalanceFeeCost(position, marketPrice);
    return Amount.create(gasCost + poolFeeCost.value);
  }

  /**
   * Calculate total cost (slippage + gas) for a trade
   * @param trade The trade
   * @returns Total cost in USD
   */
  calculateTotalCost(trade: Trade): Amount {
    const slippage = this.calculateSlippage(trade);
    const gas = this.getGasCost();
    return slippage.add(gas);
  }

  /**
   * Apply slippage to trade price
   * @param trade The trade
   * @returns New price with slippage applied
   */
  applySlippageToPrice(trade: Trade): Price {
    const slippagePercent = this.slippageBps / 10000;
    const priceMultiplier = trade.side === 'buy' 
      ? 1 + slippagePercent  // Buy: pay more
      : 1 - slippagePercent; // Sell: receive less
    
    return Price.create(trade.price.value * priceMultiplier);
  }
}

