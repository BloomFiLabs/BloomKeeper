import { BacktestEngine, BacktestConfig, BacktestResult } from '@domain/services/BacktestEngine';
import { CSVDataAdapter, IVCalculatorAdapter } from '@infrastructure/adapters/data';
import { ReportGenerator } from '@infrastructure/adapters/output/ReportGenerator';
import { Amount } from '@domain/value-objects';
import { Strategy } from '@domain/entities/Strategy';
import { DataAdapter } from '@infrastructure/adapters/data/DataAdapter';

export class RunBacktestUseCase {
  private backtestEngine: BacktestEngine;
  private reportGenerator: ReportGenerator;

  constructor() {
    this.backtestEngine = new BacktestEngine();
    this.reportGenerator = new ReportGenerator();
  }

  async execute(config: {
    startDate: Date;
    endDate: Date;
    initialCapital: number;
    strategies: Array<{
      strategy: Strategy;
      config: Record<string, unknown>;
      allocation: number;
    }>;
    dataDirectory: string;
    outputPath?: string;
    calculateIV?: boolean; // Whether to calculate IV from price data
    customDataAdapter?: DataAdapter; // Optional custom adapter
    extrapolateData?: boolean; // Whether to extrapolate data for longer periods
    useRealFees?: boolean; // Use real fees from data adapter if available
    applyIL?: boolean; // Apply impermanent loss
    applyCosts?: boolean; // Apply slippage and gas costs
    costModel?: {
      slippageBps: number;
      gasCostUSD?: number; // Legacy - use gasModel instead
      gasModel?: {
        gasUnitsPerRebalance: number;
        gasPriceGwei?: number; // Optional - will fetch if network provided
        nativeTokenPriceUSD: number;
        network?: string; // Network name (e.g., 'base', 'mainnet', 'arbitrum')
      };
      poolFeeTier?: number; // Will be fetched from adapter if not provided
    };
  }): Promise<BacktestResult> {
    // Use custom adapter if provided, otherwise create appropriate adapter
    let dataAdapter: DataAdapter;
    
    if (config.customDataAdapter) {
      dataAdapter = config.customDataAdapter;
      
      // Wrap with extrapolator if requested
      if (config.extrapolateData) {
        const { DataExtrapolatorAdapter } = await import('@infrastructure/adapters/data/DataExtrapolator');
        const extrapolator = new DataExtrapolatorAdapter(dataAdapter, { method: 'repeat' });
        // Pre-load available data
        for (const strategyConfig of config.strategies) {
          const asset = this.getAssetFromConfig(strategyConfig.config);
          try {
            await extrapolator.preloadData(asset, config.startDate, config.endDate);
          } catch (error) {
            // Ignore if preload fails
          }
        }
        dataAdapter = extrapolator;
      }
    } else if (config.calculateIV) {
      // Use IVCalculatorAdapter to automatically calculate IV
      dataAdapter = new IVCalculatorAdapter(config.dataDirectory);
      
      // Pre-calculate IV for all assets used in strategies
      const assets = new Set<string>();
      for (const strategyConfig of config.strategies) {
        const asset = this.getAssetFromConfig(strategyConfig.config);
        if (asset) assets.add(asset);
      }
      
      for (const asset of assets) {
        try {
          await (dataAdapter as IVCalculatorAdapter).precalculateIV(
            asset,
            config.startDate,
            config.endDate
          );
        } catch (error) {
          console.warn(`Warning: Could not pre-calculate IV for ${asset}:`, error);
        }
      }
    } else {
      dataAdapter = new CSVDataAdapter(config.dataDirectory);
    }

    const backtestConfig: BacktestConfig = {
      startDate: config.startDate,
      endDate: config.endDate,
      initialCapital: Amount.create(config.initialCapital),
      strategies: config.strategies,
      dataAdapter,
      useRealFees: config.useRealFees,
      applyIL: config.applyIL,
      applyCosts: config.applyCosts,
      costModel: config.costModel,
      slippageModel: config.applyCosts ? undefined : ((trade) => {
        // Simple slippage model: 0.1% for stable pairs, 0.3% for volatile
        const slippageRate = trade.asset.includes('USDC') || trade.asset.includes('USDT') ? 0.001 : 0.003;
        return trade.amount.multiply(slippageRate);
      }),
      gasCostModel: config.applyCosts ? undefined : ((trade) => {
        // Simple gas cost: $5 per trade
        return Amount.create(5);
      }),
    };

    const result = await this.backtestEngine.run(backtestConfig);

    if (config.outputPath) {
      this.reportGenerator.generateJSON(result, config.outputPath);
    }

    return result;
  }

  private getAssetFromConfig(config: Record<string, unknown>): string {
    if (config.pair) return config.pair as string;
    if (config.asset) return config.asset as string;
    if (config.rwaVault) return config.rwaVault as string;
    return 'USDC'; // Default fallback
  }
}

