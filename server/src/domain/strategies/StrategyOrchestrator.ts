import { Logger } from '@nestjs/common';
import { IExecutableStrategy, StrategyExecutionResult } from './IExecutableStrategy';
import { MarketDataContext, MarketDataAggregator, createEmptyContext } from '../services/MarketDataContext';

/**
 * StrategyOrchestrator - Manages and executes multiple strategies
 * 
 * KEY PRINCIPLE: Fetch data ONCE, pass to ALL strategies
 * 
 * Responsibilities:
 * - Register/unregister strategies
 * - Aggregate required assets/pools from all strategies
 * - Fetch market data ONCE per cycle
 * - Pass shared context to each strategy
 * - Handle emergency exits
 */
export class StrategyOrchestrator {
  private readonly logger = new Logger(StrategyOrchestrator.name);
  private readonly strategies: Map<string, IExecutableStrategy> = new Map();
  private lastContext: MarketDataContext | null = null;

  constructor(
    private readonly dataAggregator?: MarketDataAggregator,
  ) {}

  /**
   * Register a strategy for execution
   */
  registerStrategy(strategy: IExecutableStrategy): boolean {
    const key = strategy.id || strategy.contractAddress;
    
    if (this.strategies.has(key)) {
      this.logger.warn(
        `Strategy ${key} already registered. Skipping duplicate "${strategy.name}"`
      );
      return false;
    }

    this.strategies.set(key, strategy);
    this.logger.log(
      `✅ Registered strategy: ${strategy.name} ` +
      `(Chain: ${strategy.chainId}, Address: ${strategy.contractAddress})`
    );
    return true;
  }

  /**
   * Unregister a strategy
   */
  unregisterStrategy(strategyId: string): boolean {
    const strategy = this.strategies.get(strategyId);
    if (strategy) {
      this.strategies.delete(strategyId);
      this.logger.log(`Unregistered strategy: ${strategy.name}`);
      return true;
    }
    return false;
  }

  /**
   * Get all registered strategies
   */
  getStrategies(): IExecutableStrategy[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Get a specific strategy
   */
  getStrategy(strategyId: string): IExecutableStrategy | undefined {
    return this.strategies.get(strategyId);
  }

  /**
   * Get all unique assets required by registered strategies
   */
  getRequiredAssets(): string[] {
    const assets = new Set<string>();
    for (const strategy of this.strategies.values()) {
      for (const asset of strategy.requiredAssets || []) {
        assets.add(asset);
      }
    }
    return Array.from(assets);
  }

  /**
   * Get all unique pools required by registered strategies
   */
  getRequiredPools(): string[] {
    const pools = new Set<string>();
    for (const strategy of this.strategies.values()) {
      for (const pool of strategy.requiredPools || []) {
        pools.add(pool);
      }
    }
    return Array.from(pools);
  }

  /**
   * Get all unique chains used by registered strategies
   */
  getRequiredChains(): number[] {
    const chains = new Set<number>();
    for (const strategy of this.strategies.values()) {
      chains.add(strategy.chainId);
    }
    return Array.from(chains);
  }

  /**
   * Execute all registered strategies
   * 
   * 1. Fetch ALL market data ONCE
   * 2. Pass shared context to each strategy
   * 3. Each strategy uses the same data snapshot
   */
  async executeAll(): Promise<StrategyExecutionResult[]> {
    const results: StrategyExecutionResult[] = [];
    
    this.logger.log('');
    this.logger.log('🔄 ═══════════════════════════════════════════════════════════');
    this.logger.log(`🔄 Executing ${this.strategies.size} strategies...`);
    this.logger.log('🔄 ═══════════════════════════════════════════════════════════');

    // Step 1: Fetch ALL market data ONCE
    const context = await this.fetchMarketData();
    this.lastContext = context;
    
    this.logger.log(`📊 Market data fetched: ${context.funding.size} funding, ${context.prices.size} prices, ${context.volatility.size} vol`);

    // Step 2: Execute each strategy with shared context
    for (const [id, strategy] of this.strategies) {
      if (!strategy.isEnabled()) {
        results.push({
          strategyName: strategy.name,
          executed: false,
          action: 'DISABLED',
          reason: 'Strategy is disabled',
        });
        continue;
      }

      try {
        this.logger.log(`\n📊 [${strategy.name}] Starting execution...`);
        const startTime = Date.now();
        
        // Pass shared context to strategy
        const result = await strategy.execute(context);
        
        const duration = Date.now() - startTime;
        this.logResult(result, duration);
        results.push(result);
        
      } catch (error) {
        this.logger.error(`❌ [${strategy.name}] Fatal error: ${error.message}`);
        results.push({
          strategyName: strategy.name,
          executed: false,
          reason: `Fatal error: ${error.message}`,
          error: error.message,
        });
      }
    }

    this.logSummary(results);
    return results;
  }

  /**
   * Execute strategies on a specific chain
   */
  async executeByChain(chainId: number): Promise<StrategyExecutionResult[]> {
    const results: StrategyExecutionResult[] = [];
    
    // Filter strategies by chain
    const chainStrategies = Array.from(this.strategies.values()).filter(
      (strategy) => strategy.chainId === chainId
    );

    if (chainStrategies.length === 0) {
      this.logger.warn(`No strategies found for chain ${chainId}`);
      return results;
    }

    this.logger.log(`Executing ${chainStrategies.length} strategies on chain ${chainId}`);

    // Fetch market data once
    const context = await this.fetchMarketData();
    this.lastContext = context;

    // Execute each strategy on this chain
    for (const strategy of chainStrategies) {
      if (!strategy.isEnabled()) {
        results.push({
          strategyName: strategy.name,
          executed: false,
          action: 'DISABLED',
          reason: 'Strategy is disabled',
        });
        continue;
      }

      try {
        this.logger.log(`\n📊 [${strategy.name}] Starting execution...`);
        const startTime = Date.now();
        
        const result = await strategy.execute(context);
        
        const duration = Date.now() - startTime;
        this.logResult(result, duration);
        results.push(result);
        
      } catch (error) {
        this.logger.error(`❌ [${strategy.name}] Fatal error: ${error.message}`);
        results.push({
          strategyName: strategy.name,
          executed: false,
          reason: `Fatal error: ${error.message}`,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Fetch market data for all required assets/pools/chains
   */
  private async fetchMarketData(): Promise<MarketDataContext> {
    if (!this.dataAggregator) {
      // Debug level - this is expected when strategies don't need market data
      // Some strategies (like perp keeper arbitrage) use their own data providers
      this.logger.debug('No data aggregator configured, using empty context');
      return createEmptyContext();
    }

    const assets = this.getRequiredAssets();
    const chains = this.getRequiredChains();
    const pools = this.getRequiredPools();

    this.logger.debug(
      `Fetching data for: ${assets.length} assets, ${chains.length} chains, ${pools.length} pools`
    );

    return this.dataAggregator.fetchAll(assets, chains, pools);
  }

  /**
   * Get the last fetched market context (for monitoring)
   */
  getLastContext(): MarketDataContext | null {
    return this.lastContext;
  }

  /**
   * Emergency exit all strategies
   */
  async emergencyExitAll(): Promise<{ strategy: string; result: StrategyExecutionResult }[]> {
    this.logger.warn('🚨 EMERGENCY EXIT ALL STRATEGIES');
    
    const results: { strategy: string; result: StrategyExecutionResult }[] = [];

    for (const [id, strategy] of this.strategies) {
      try {
        const result = await strategy.emergencyExit();
        results.push({ strategy: strategy.name, result });
        this.logger.log(`✅ [${strategy.name}] Emergency exit: ${result.action}`);
      } catch (error) {
        results.push({ 
          strategy: strategy.name, 
          result: {
            strategyName: strategy.name,
            executed: false,
            reason: `Emergency exit failed: ${error.message}`,
            error: error.message,
          }
        });
        this.logger.error(`❌ [${strategy.name}] Emergency exit failed: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * Get metrics from all strategies
   */
  async getAllMetrics(): Promise<Record<string, Record<string, number | string>>> {
    const metrics: Record<string, Record<string, number | string>> = {};

    for (const [id, strategy] of this.strategies) {
      try {
        metrics[strategy.name] = await strategy.getMetrics();
      } catch (error) {
        metrics[strategy.name] = { error: error.message };
      }
    }

    return metrics;
  }

  /**
   * Enable/disable a specific strategy
   */
  setStrategyEnabled(strategyId: string, enabled: boolean): boolean {
    const strategy = this.strategies.get(strategyId);
    if (strategy) {
      strategy.setEnabled(enabled);
      return true;
    }
    return false;
  }

  private logResult(result: StrategyExecutionResult, durationMs: number): void {
    const status = result.executed ? '✅ EXECUTED' : '⏸️  SKIPPED';
    const action = result.action ? ` | Action: ${result.action}` : '';
    
    this.logger.log(
      `   ${status}${action} | ${result.reason} (${durationMs}ms)`
    );

    if (result.txHash) {
      this.logger.log(`   📝 TX: ${result.txHash}`);
    }

    if (result.error) {
      this.logger.error(`   ❌ Error: ${result.error}`);
    }
  }

  private logSummary(results: StrategyExecutionResult[]): void {
    const executed = results.filter(r => r.executed).length;
    const skipped = results.filter(r => !r.executed && !r.error).length;
    const errors = results.filter(r => r.error).length;

    this.logger.log('');
    this.logger.log('📋 ═══════════════════════════════════════════════════════════');
    this.logger.log(`📋 Summary: ${executed} executed, ${skipped} skipped, ${errors} errors`);
    this.logger.log('📋 ═══════════════════════════════════════════════════════════');
    this.logger.log('');
  }
}
