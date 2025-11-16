/**
 * Example usage of centralized strategy configurations
 * This file demonstrates how to use the configuration system
 */

import {
  getDefaultConfig,
  mergeWithDefaults,
  normalizeConfig,
  DEFAULT_STABLE_PAIR_CONFIG,
  DEFAULT_VOLATILE_PAIR_CONFIG,
} from './StrategyConfigs';
import { StablePairStrategy } from '@infrastructure/adapters/strategies';

// Example 1: Using default configuration
export function example1_useDefaults() {
  const defaultConfig = getDefaultConfig('stable-pair');
  console.log('Default Stable Pair Config:', defaultConfig);
  // Output: { pair: 'USDC-USDT', rangeWidth: 0.002, leverage: 2.0, ... }
}

// Example 2: Merging user config with defaults
export function example2_mergeWithDefaults() {
  const customConfig = mergeWithDefaults('stable-pair', {
    pair: 'DAI-USDC',
    leverage: 2.5,
    allocation: 0.3,
  });
  console.log('Custom Config:', customConfig);
  // Only specified fields are overridden, rest use defaults
}

// Example 3: Normalizing partial configuration
export function example3_normalizeConfig() {
  const partialConfig = {
    pair: 'USDC-USDT',
    // Other fields will use defaults
  };
  const normalized = normalizeConfig('stable-pair', partialConfig);
  console.log('Normalized Config:', normalized);
}

// Example 4: Using in a backtest
export async function example4_useInBacktest() {
  const strategy = new StablePairStrategy('stable-1', 'My Stable Pair');

  // Option A: Use defaults
  const configA = getDefaultConfig('stable-pair');

  // Option B: Customize specific parameters
  const configB = mergeWithDefaults('stable-pair', {
    leverage: 3.0,
    allocation: 0.4,
  });

  // Both configs are fully typed and validated
  // await strategy.execute(portfolio, marketData, configA);
  // await strategy.execute(portfolio, marketData, configB);
}

// Example 5: Accessing individual default configs
export function example5_directDefaults() {
  // You can also import specific default configs directly
  console.log('Stable Pair Defaults:', DEFAULT_STABLE_PAIR_CONFIG);
  console.log('Volatile Pair Defaults:', DEFAULT_VOLATILE_PAIR_CONFIG);
}

// Example 6: Creating a complete backtest configuration
export function example6_completeBacktestConfig() {
  const backtestConfig = {
    strategies: [
      {
        strategy: new StablePairStrategy('sp1', 'Stable Pair 1'),
        config: getDefaultConfig('stable-pair'),
        allocation: 0.25,
      },
      {
        strategy: new StablePairStrategy('sp2', 'Stable Pair 2'),
        config: mergeWithDefaults('stable-pair', {
          pair: 'DAI-USDC',
          leverage: 2.5,
        }),
        allocation: 0.20,
      },
    ],
  };

  return backtestConfig;
}

