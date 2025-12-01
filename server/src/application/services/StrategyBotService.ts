import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { 
  StrategyOrchestrator, 
  FundingRateStrategy, 
  StrategyExecutionResult,
} from '../../domain/strategies';
import { DeltaNeutralFundingStrategy, DeltaNeutralFundingConfig } from '../../domain/strategies/DeltaNeutralFundingStrategy';
import { HyperLiquidDataProvider, HyperLiquidExecutor } from '../../infrastructure/adapters/hyperliquid';
import { ethers } from 'ethers';
import type { IMarketDataProvider } from '../../domain/ports/IMarketDataProvider';
import type { IBlockchainAdapter } from '../../domain/ports/IBlockchainAdapter';
import type { IStrategyExecutor } from '../../domain/ports/IStrategyExecutor';
import { Inject } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

interface StrategyConfig {
  id?: string;
  type: 'funding' | 'lp' | 'delta-neutral-funding';
  name: string;
  chainId: number;
  contractAddress: string;
  vaultAddress?: string;
  hyperLendPool?: string;
  wethAddress?: string;
  enabled: boolean;
  // Funding strategy specific
  asset?: string;
  assetId?: number;
  minFundingRateThreshold?: number;
  maxPositionSize?: number;
  targetLeverage?: number;
  // Delta-neutral funding specific
  riskParams?: {
    minHealthFactor: number;
    targetHealthFactor: number;
    emergencyHealthFactor: number;
    maxLeverage: number;
    targetLeverage: number;
    minLeverage: number;
  };
  fundingParams?: {
    minFundingRateThreshold: number;
    fundingFlipThreshold: number;
    minAnnualizedAPY: number;
  };
  positionParams?: {
    maxPositionSizeUSD: number;
    maxDeltaDriftPercent: number;
    rebalanceCooldownSeconds: number;
  };
}

/**
 * StrategyBotService - Unified bot service that runs all strategies
 * 
 * This service:
 * 1. Loads strategy configurations
 * 2. Initializes appropriate strategy instances
 * 3. Runs all strategies on a schedule
 * 4. Provides monitoring and emergency controls
 */
@Injectable()
export class StrategyBotService implements OnModuleInit {
  private readonly logger = new Logger(StrategyBotService.name);
  private readonly orchestrator: StrategyOrchestrator;
  private hyperLiquidDataProvider: HyperLiquidDataProvider | null = null;
  private hyperLiquidExecutor: HyperLiquidExecutor | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Inject('IMarketDataProvider') private readonly marketData: IMarketDataProvider,
    @Inject('IBlockchainAdapter') private readonly blockchain: IBlockchainAdapter,
  ) {
    this.orchestrator = new StrategyOrchestrator();
  }

  async onModuleInit() {
    this.logger.log('🚀 Strategy Bot Service initializing...');
    
    // Initialize HyperLiquid adapters if configured
    await this.initializeHyperLiquidAdapters();
    
    // Load and register strategies
    await this.loadStrategies();
    
    this.logger.log(`✅ Strategy Bot Service ready with ${this.orchestrator.getStrategies().length} strategies`);
  }

  private async initializeHyperLiquidAdapters() {
    const hyperLiquidRpc = this.configService.get<string>('HYPERLIQUID_RPC_URL');
    
    // StrategyBotService is disabled - this method should not be called
    // All HyperLiquid functionality is now handled by PerpKeeperService
    this.logger.warn('StrategyBotService is disabled - HyperLiquid adapters not initialized');
    return;
  }

  private async loadStrategies() {
    // Load from config file or environment
    const strategies = this.getStrategyConfigs();
    
    for (const config of strategies) {
      try {
        if (config.type === 'funding') {
          await this.registerFundingStrategy(config);
        } else if (config.type === 'delta-neutral-funding') {
          await this.registerDeltaNeutralFundingStrategy(config);
        }
        // LP strategies removed - not viable
      } catch (error) {
        this.logger.error(`Failed to register strategy ${config.name}: ${error.message}`);
      }
    }
  }

  private getStrategyConfigs(): StrategyConfig[] {
    // Try to load from config file
    const configPaths = [
      path.join(__dirname, '../../config/strategies.json'),
      path.join(__dirname, '../../../src/config/strategies.json'),
      path.join(process.cwd(), 'src/config/strategies.json'),
    ];

    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          this.logger.log(`Loaded strategies from ${configPath}`);
          return config.strategies || [];
        } catch (error) {
          this.logger.warn(`Could not parse ${configPath}: ${error.message}`);
        }
      }
    }

    // Default strategies if no config file
    return this.getDefaultStrategies();
  }

  private getDefaultStrategies(): StrategyConfig[] {
    const strategies: StrategyConfig[] = [];

    // HyperEVM Funding Strategy (if configured)
    const fundingStrategyAddress = this.configService.get<string>('HYPEREVM_FUNDING_STRATEGY');
    if (fundingStrategyAddress && this.hyperLiquidDataProvider) {
      strategies.push({
        type: 'funding',
        name: 'ETH Funding Rate',
        chainId: 999,
        contractAddress: fundingStrategyAddress,
        enabled: true,
        asset: 'ETH',
        minFundingRateThreshold: 0.0001, // 0.01% per 8h
        maxPositionSize: 10000,
        targetLeverage: 1,
      });
    }

    // LP strategies removed - not viable

    return strategies;
  }


  private async registerFundingStrategy(config: StrategyConfig) {
    if (!this.hyperLiquidDataProvider || !this.hyperLiquidExecutor) {
      this.logger.warn(`Cannot register ${config.name}: HyperLiquid adapters not available`);
      return;
    }

    const strategy = new FundingRateStrategy(
      {
        name: config.name,
        chainId: config.chainId,
        contractAddress: config.contractAddress,
        enabled: config.enabled,
        asset: config.asset || 'ETH',
        minFundingRateThreshold: config.minFundingRateThreshold || 0.0001,
        maxPositionSize: config.maxPositionSize || 10000,
        targetLeverage: config.targetLeverage || 1,
      },
      this.hyperLiquidDataProvider,
      this.hyperLiquidExecutor,
    );

    this.orchestrator.registerStrategy(strategy);
  }


  private async registerDeltaNeutralFundingStrategy(config: StrategyConfig) {
    const hyperLiquidRpc = this.configService.get<string>('HYPERLIQUID_RPC_URL');
    const privateKey = this.configService.get<string>('PRIVATE_KEY');
    
    if (!hyperLiquidRpc || !privateKey) {
      this.logger.warn(`Cannot register ${config.name}: HyperEVM not configured (missing RPC or PRIVATE_KEY)`);
      return;
    }

    if (!config.contractAddress || config.contractAddress === '0x0000000000000000000000000000000000000000') {
      this.logger.warn(`Cannot register ${config.name}: Contract not deployed`);
      return;
    }

    const provider = new ethers.JsonRpcProvider(hyperLiquidRpc);
    const wallet = new ethers.Wallet(privateKey, provider);

    const strategyConfig: DeltaNeutralFundingConfig = {
      id: config.id || config.contractAddress,
      name: config.name,
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      vaultAddress: config.vaultAddress || '',
      hyperLendPool: config.hyperLendPool || '',
      wethAddress: config.wethAddress || '',
      enabled: config.enabled,
      asset: config.asset || 'ETH',
      assetId: config.assetId || 4,
      riskParams: config.riskParams || {
        minHealthFactor: 1.5,
        targetHealthFactor: 2.0,
        emergencyHealthFactor: 1.3,
        maxLeverage: 5,
        targetLeverage: 2,
        minLeverage: 1,
      },
      fundingParams: config.fundingParams || {
        minFundingRateThreshold: 0.0001,
        fundingFlipThreshold: -0.00005,
        minAnnualizedAPY: 10,
      },
      positionParams: config.positionParams || {
        maxPositionSizeUSD: 5000,
        maxDeltaDriftPercent: 5,
        rebalanceCooldownSeconds: 300,
      },
    };

    const strategy = new DeltaNeutralFundingStrategy(strategyConfig, provider, wallet);
    this.orchestrator.registerStrategy(strategy);
    
    this.logger.log(`✅ Registered Delta-Neutral Funding Strategy: ${config.name}`);
  }

  // ═══════════════════════════════════════════════════════════
  // Scheduled Tasks
  // ═══════════════════════════════════════════════════════════

  @Cron('*/30 * * * * *') // Every 30 seconds
  async executeStrategies() {
    const results = await this.orchestrator.executeAll();
    
    // Log summary
    const executed = results.filter(r => r.executed).length;
    const errors = results.filter(r => r.error).length;
    
    if (executed > 0 || errors > 0) {
      this.logger.log(`📊 Execution complete: ${executed} actions, ${errors} errors`);
    }
  }

  @Interval(60000) // Every minute
  async logMetrics() {
    const metrics = await this.orchestrator.getAllMetrics();
    
    this.logger.log('');
    this.logger.log('📊 ─── Strategy Metrics ───');
    
    for (const [name, data] of Object.entries(metrics)) {
      if (data.error) {
        this.logger.warn(`  ${name}: Error - ${data.error}`);
      } else {
        const fundingRate = data.currentFundingRatePct || data.fundingRate;
        const apy = data.estimatedAPYPct || data.estimatedNetApyPct;
        const position = data.positionSide || data.positionInRangePct;
        
        this.logger.log(
          `  ${name}: ` +
          (fundingRate ? `Funding=${fundingRate} ` : '') +
          (apy ? `APY=${apy} ` : '') +
          (position ? `Position=${position}` : '')
        );
      }
    }
    this.logger.log('');
  }

  // ═══════════════════════════════════════════════════════════
  // API Methods
  // ═══════════════════════════════════════════════════════════

  /**
   * Get all registered strategies
   */
  getStrategies() {
    return this.orchestrator.getStrategies().map(s => ({
      name: s.name,
      chainId: s.chainId,
      contractAddress: s.contractAddress,
      enabled: s.isEnabled(),
    }));
  }

  /**
   * Get metrics for all strategies
   */
  async getAllMetrics() {
    return this.orchestrator.getAllMetrics();
  }

  /**
   * Enable/disable a strategy
   */
  setStrategyEnabled(contractAddress: string, enabled: boolean) {
    return this.orchestrator.setStrategyEnabled(contractAddress, enabled);
  }

  /**
   * Emergency exit all strategies
   */
  async emergencyExitAll() {
    this.logger.warn('🚨 EMERGENCY EXIT ALL triggered');
    return this.orchestrator.emergencyExitAll();
  }

  /**
   * Manually trigger strategy execution
   */
  async manualExecute(): Promise<StrategyExecutionResult[]> {
    this.logger.log('🔧 Manual execution triggered');
    return this.orchestrator.executeAll();
  }
}



