import { Logger } from '@nestjs/common';
import { IExecutableStrategy, StrategyExecutionResult } from './IExecutableStrategy';
import { MarketDataContext } from '../services/MarketDataContext';

export interface FundingRateStrategyConfig {
  name: string;
  chainId: number;
  contractAddress: string;
  enabled: boolean;
  asset: string; // e.g., 'ETH', 'BTC'
  minFundingRateThreshold: number; // Minimum funding rate to enter (e.g., 0.0001 = 0.01%)
  maxPositionSize: number; // Max position size in USD
  targetLeverage: number; // Target leverage (1 = no leverage)
}

export interface IFundingDataProvider {
  getCurrentFundingRate(asset: string): Promise<number>;
  getPredictedFundingRate(asset: string): Promise<number>;
  getOpenInterest(asset: string): Promise<number>;
}

export interface IHyperLiquidExecutor {
  getPosition(strategyAddress: string): Promise<{ size: number; side: 'long' | 'short' | 'none'; entryPrice: number }>;
  placeOrder(strategyAddress: string, isLong: boolean, size: number, price: number): Promise<string>;
  closePosition(strategyAddress: string): Promise<string>;
  getEquity(strategyAddress: string): Promise<number>;
  getMarkPrice(asset: string): Promise<number>;
}

/**
 * FundingRateStrategy - Captures funding rate payments on perpetual markets
 * 
 * Strategy Logic:
 * - When funding rate is positive (longs pay shorts): Go SHORT to receive funding
 * - When funding rate is negative (shorts pay longs): Go LONG to receive funding
 * - Close/flip position when funding rate reverses
 * 
 * Risk Management:
 * - Only enter when funding rate exceeds threshold (filters noise)
 * - Position sizing based on available equity and leverage target
 * - Emergency exit capability
 */
export class FundingRateStrategy implements IExecutableStrategy {
  private readonly logger = new Logger(FundingRateStrategy.name);
  private enabled: boolean;
  
  // Funding rate thresholds
  private readonly FLIP_THRESHOLD_MULTIPLIER = 1.5; // Flip when rate is 1.5x threshold in opposite direction
  private readonly FUNDING_PERIODS_PER_DAY = 3; // HyperLiquid has 8h funding periods
  
  // Local position tracking (fallback when L1Read doesn't work)
  private localPosition: { side: 'long' | 'short' | 'none'; size: number; entryPrice: number } = {
    side: 'none',
    size: 0,
    entryPrice: 0,
  };
  
  constructor(
    private readonly config: FundingRateStrategyConfig,
    private readonly fundingProvider: IFundingDataProvider,
    private readonly executor: IHyperLiquidExecutor,
  ) {
    this.enabled = config.enabled;
  }

  get name(): string {
    return this.config.name;
  }

  get chainId(): number {
    return this.config.chainId;
  }

  get contractAddress(): string {
    return this.config.contractAddress;
  }

  get id(): string {
    return this.config.contractAddress; // Use contract address as ID
  }

  get requiredAssets(): string[] {
    return [this.config.asset];
  }

  get requiredPools(): string[] {
    return []; // Funding rate strategy doesn't need pool data
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.logger.log(`Strategy ${this.name} ${enabled ? 'enabled' : 'disabled'}`);
  }

  async execute(context: MarketDataContext): Promise<StrategyExecutionResult> {
    const baseResult: StrategyExecutionResult = {
      strategyName: this.name,
      executed: false,
      reason: '',
    };

    // Check if enabled
    if (!this.enabled) {
      return {
        ...baseResult,
        reason: 'Strategy is disabled',
      };
    }

    try {
      // 1. Fetch current market data
      const [currentRate, predictedRate, openInterest, onChainPosition, equity] = await Promise.all([
        this.fundingProvider.getCurrentFundingRate(this.config.asset),
        this.fundingProvider.getPredictedFundingRate(this.config.asset),
        this.fundingProvider.getOpenInterest(this.config.asset),
        this.executor.getPosition(this.config.contractAddress),
        this.executor.getEquity(this.config.contractAddress),
      ]);

      // Use on-chain position if available, otherwise use local tracking
      const position = onChainPosition.size > 0 ? onChainPosition : this.localPosition;

      const absRate = Math.abs(currentRate);
      const rateIsPositive = currentRate > 0;
      
      this.logger.debug(
        `[${this.name}] Funding: ${(currentRate * 100).toFixed(4)}% | ` +
        `Predicted: ${(predictedRate * 100).toFixed(4)}% | ` +
        `Position: ${position.side} ${position.size.toFixed(4)} | ` +
        `Equity: $${equity.toFixed(2)}`
      );

      // 2. Decision logic based on current position
      if (position.side === 'none' || position.size === 0) {
        // No position - check if we should enter
        return await this.handleNoPosition(currentRate, predictedRate, equity, baseResult);
      } else {
        // Have position - check if we should hold, close, or flip
        return await this.handleExistingPosition(currentRate, predictedRate, position, equity, baseResult);
      }

    } catch (error) {
      this.logger.error(`[${this.name}] Execution error: ${error.message}`);
      return {
        ...baseResult,
        executed: false,
        reason: `Error: ${error.message}`,
        error: error.message,
      };
    }
  }

  private async handleNoPosition(
    currentRate: number,
    predictedRate: number,
    equity: number,
    baseResult: StrategyExecutionResult,
  ): Promise<StrategyExecutionResult> {
    const absRate = Math.abs(currentRate);
    
    // Check if rate is above threshold
    if (absRate < this.config.minFundingRateThreshold) {
      return {
        ...baseResult,
        executed: false,
        action: 'NONE',
        reason: `Funding rate ${(currentRate * 100).toFixed(4)}% is below threshold ${(this.config.minFundingRateThreshold * 100).toFixed(4)}%`,
        metrics: await this.getMetrics(),
      };
    }

    // Determine direction: Short when rate is positive, Long when negative
    const shouldGoLong = currentRate < 0;
    const action = shouldGoLong ? 'OPEN_LONG' : 'OPEN_SHORT';
    
    // Calculate position size
    const markPrice = await this.executor.getMarkPrice(this.config.asset);
    // Use config maxPositionSize as fallback if equity is 0 (not bridged to HyperCore yet)
    const effectiveEquity = equity > 0 ? equity : this.config.maxPositionSize / this.config.targetLeverage;
    const positionSizeUSD = Math.min(effectiveEquity * this.config.targetLeverage, this.config.maxPositionSize);
    const positionSizeUnits = positionSizeUSD / markPrice;

    this.logger.log(
      `[${this.name}] Opening ${action}: Rate=${(currentRate * 100).toFixed(4)}%, ` +
      `Size=$${positionSizeUSD.toFixed(2)} (${positionSizeUnits.toFixed(4)} ${this.config.asset})`
    );

    // Execute the order
    const txHash = await this.executor.placeOrder(
      this.config.contractAddress,
      shouldGoLong,
      positionSizeUnits,
      markPrice, // Use mark price as limit
    );

    // Update local position tracking
    this.localPosition = {
      side: shouldGoLong ? 'long' : 'short',
      size: positionSizeUnits,
      entryPrice: markPrice,
    };

    return {
      ...baseResult,
      executed: true,
      action,
      reason: `Opened ${shouldGoLong ? 'LONG' : 'SHORT'} to capture ${(absRate * 100).toFixed(4)}% funding`,
      txHash,
      metrics: await this.getMetrics(),
    };
  }

  private async handleExistingPosition(
    currentRate: number,
    predictedRate: number,
    position: { size: number; side: 'long' | 'short' | 'none'; entryPrice: number },
    equity: number,
    baseResult: StrategyExecutionResult,
  ): Promise<StrategyExecutionResult> {
    const absRate = Math.abs(currentRate);
    const rateIsPositive = currentRate > 0;
    
    // ═══════════════════════════════════════════════════════════
    // LIQUIDATION PROTECTION - Check if price moved against us
    // ═══════════════════════════════════════════════════════════
    const markPrice = await this.executor.getMarkPrice(this.config.asset);
    const entryPrice = position.entryPrice || this.localPosition.entryPrice;
    
    if (entryPrice > 0) {
      const priceChange = (markPrice - entryPrice) / entryPrice;
      // At 30x leverage, liquidation is ~3.3%. We exit at 2% to be safe.
      const MAX_ADVERSE_MOVE = 0.02; // 2% stop-loss
      
      const isAdverseMove = 
        (position.side === 'short' && priceChange > MAX_ADVERSE_MOVE) ||
        (position.side === 'long' && priceChange < -MAX_ADVERSE_MOVE);
      
      if (isAdverseMove) {
        this.logger.warn(
          `[${this.name}] ⚠️ STOP-LOSS TRIGGERED! Price moved ${(priceChange * 100).toFixed(2)}% against ${position.side} position. ` +
          `Entry: $${entryPrice.toFixed(2)}, Current: $${markPrice.toFixed(2)}`
        );
        
        const txHash = await this.executor.closePosition(this.config.contractAddress);
        this.localPosition = { side: 'none', size: 0, entryPrice: 0 };
        
        return {
          ...baseResult,
          executed: true,
          action: 'STOP_LOSS',
          reason: `Stop-loss triggered - price moved ${(priceChange * 100).toFixed(2)}% against position`,
          txHash,
          metrics: await this.getMetrics(),
        };
      }
    }
    // ═══════════════════════════════════════════════════════════
    
    // Check if funding rate is still favorable for our position
    // Short position benefits from positive funding (longs pay shorts)
    // Long position benefits from negative funding (shorts pay longs)
    const positionIsFavorable = 
      (position.side === 'short' && rateIsPositive) ||
      (position.side === 'long' && !rateIsPositive);

    if (positionIsFavorable) {
      // Hold position - funding is still in our favor
      const pnlPercent = entryPrice > 0 ? ((markPrice - entryPrice) / entryPrice * 100) : 0;
      const pnlDirection = position.side === 'short' ? -pnlPercent : pnlPercent;
      
      return {
        ...baseResult,
        executed: false,
        action: 'HOLD',
        reason: `Holding ${position.side} - funding ${(currentRate * 100).toFixed(4)}% favorable, PnL: ${pnlDirection.toFixed(2)}%`,
        metrics: await this.getMetrics(),
      };
    }

    // Funding rate has flipped against us
    const flipThreshold = this.config.minFundingRateThreshold * this.FLIP_THRESHOLD_MULTIPLIER;
    
    if (absRate >= flipThreshold) {
      // Strong reversal - flip position
      this.logger.log(`[${this.name}] Flipping position: Rate reversed to ${(currentRate * 100).toFixed(4)}%`);
      
      // Close current position
      await this.executor.closePosition(this.config.contractAddress);
      
      // Open opposite position
      const shouldGoLong = currentRate < 0;
      const markPrice = await this.executor.getMarkPrice(this.config.asset);
      const positionSizeUSD = Math.min(equity * this.config.targetLeverage, this.config.maxPositionSize);
      const positionSizeUnits = positionSizeUSD / markPrice;
      
      const txHash = await this.executor.placeOrder(
        this.config.contractAddress,
        shouldGoLong,
        positionSizeUnits,
        markPrice,
      );

      // Update local position tracking
      this.localPosition = {
        side: shouldGoLong ? 'long' : 'short',
        size: positionSizeUnits,
        entryPrice: markPrice,
      };

      return {
        ...baseResult,
        executed: true,
        action: shouldGoLong ? 'FLIP_TO_LONG' : 'FLIP_TO_SHORT',
        reason: `Flipped to ${shouldGoLong ? 'LONG' : 'SHORT'} - funding reversed to ${(currentRate * 100).toFixed(4)}%`,
        txHash,
        metrics: await this.getMetrics(),
      };
    } else {
      // Weak reversal - just close position
      this.logger.log(`[${this.name}] Closing position: Rate unfavorable at ${(currentRate * 100).toFixed(4)}%`);
      
      const txHash = await this.executor.closePosition(this.config.contractAddress);

      // Clear local position tracking
      this.localPosition = { side: 'none', size: 0, entryPrice: 0 };

      return {
        ...baseResult,
        executed: true,
        action: 'CLOSE_POSITION',
        reason: `Closed ${position.side} - funding rate flipped to ${(currentRate * 100).toFixed(4)}%`,
        txHash,
        metrics: await this.getMetrics(),
      };
    }
  }

  async getMetrics(): Promise<Record<string, number | string>> {
    try {
      const [currentRate, predictedRate, position, equity] = await Promise.all([
        this.fundingProvider.getCurrentFundingRate(this.config.asset),
        this.fundingProvider.getPredictedFundingRate(this.config.asset),
        this.executor.getPosition(this.config.contractAddress),
        this.executor.getEquity(this.config.contractAddress),
      ]);

      // Calculate estimated APY from current funding rate
      // APY = rate * periods_per_day * 365
      const estimatedAPY = Math.abs(currentRate) * this.FUNDING_PERIODS_PER_DAY * 365 * 100;

      return {
        asset: this.config.asset,
        currentFundingRate: currentRate,
        currentFundingRatePct: `${(currentRate * 100).toFixed(4)}%`,
        predictedFundingRate: predictedRate,
        predictedFundingRatePct: `${(predictedRate * 100).toFixed(4)}%`,
        positionSide: position.side,
        positionSize: position.size,
        entryPrice: position.entryPrice,
        equity,
        estimatedAPY,
        estimatedAPYPct: `${estimatedAPY.toFixed(2)}%`,
        threshold: this.config.minFundingRateThreshold,
        thresholdPct: `${(this.config.minFundingRateThreshold * 100).toFixed(4)}%`,
      };
    } catch (error) {
      return {
        error: error.message,
      };
    }
  }

  async emergencyExit(): Promise<StrategyExecutionResult> {
    this.logger.warn(`[${this.name}] EMERGENCY EXIT triggered`);
    const txHash = await this.executor.closePosition(this.config.contractAddress);
    return {
      strategyName: this.name,
      executed: true,
      action: 'emergency_exit',
      reason: 'Emergency exit triggered',
      txHash,
    };
  }
}

