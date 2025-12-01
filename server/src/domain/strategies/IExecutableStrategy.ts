import { MarketDataContext } from '../services/MarketDataContext';

/**
 * IExecutableStrategy - Interface for all executable bot strategies
 * 
 * IMPORTANT: Strategies receive a shared MarketDataContext that is
 * fetched ONCE per cycle. This prevents redundant API calls and ensures
 * all strategies see the same market snapshot.
 * 
 * Strategies should NOT fetch their own market data - they use the context.
 */

export interface StrategyConfig {
  id: string;
  name: string;
  chainId: number;
  contractAddress: string;
  enabled: boolean;
}

export interface StrategyExecutionResult {
  strategyName: string;
  executed: boolean;
  action?: string;
  reason: string;
  metrics?: Record<string, number | string>;
  txHash?: string;
  error?: string;
}

export interface IExecutableStrategy {
  /**
   * Unique identifier for this strategy instance
   */
  readonly id: string;
  
  /**
   * Human-readable name
   */
  readonly name: string;
  
  /**
   * Chain ID where this strategy operates
   */
  readonly chainId: number;
  
  /**
   * Contract address of the on-chain strategy
   */
  readonly contractAddress: string;
  
  /**
   * Assets this strategy needs data for
   * Used by orchestrator to know what data to fetch
   */
  readonly requiredAssets: string[];
  
  /**
   * Pools this strategy needs data for (if LP strategy)
   */
  readonly requiredPools: string[];
  
  /**
   * Whether this strategy is currently enabled
   */
  isEnabled(): boolean;
  
  /**
   * Enable or disable this strategy
   */
  setEnabled(enabled: boolean): void;
  
  /**
   * Main execution method - called by orchestrator on each interval
   * 
   * RECEIVES shared MarketDataContext - do NOT fetch data yourself!
   * 
   * @param context - Shared market data fetched once for all strategies
   */
  execute(context: MarketDataContext): Promise<StrategyExecutionResult>;
  
  /**
   * Get current strategy state/metrics for monitoring
   * Can use cached data from last execution
   */
  getMetrics(): Promise<Record<string, number | string>>;
  
  /**
   * Emergency exit - close all positions and return funds
   */
  emergencyExit(): Promise<StrategyExecutionResult>;
}
