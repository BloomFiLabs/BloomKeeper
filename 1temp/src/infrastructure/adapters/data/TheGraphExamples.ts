/**
 * Examples of using The Graph data adapter
 * These are example configurations for common DEX protocols
 */

import {
  TheGraphDataAdapter,
  UniswapV4Adapter,
  UniswapV3Adapter,
  UniswapV2Adapter,
  CurveAdapter,
} from './TheGraphDataAdapter';

/**
 * Example 1: Uniswap V4 pool with API key
 */
export function createUniswapV4Adapter(apiKey?: string): UniswapV4Adapter {
  return new UniswapV4Adapter({
    apiKey: apiKey || process.env.THE_GRAPH_API_KEY,
    poolAddress: '0x...', // Your V4 pool address
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
  });
}

/**
 * Example 2: Uniswap V3 ETH/USDC pool
 */
export function createUniswapV3ETHUSDCAdapter(): UniswapV3Adapter {
  return new UniswapV3Adapter({
    poolAddress: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8', // ETH/USDC 0.05% pool
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
  });
}

/**
 * Example 2: Uniswap V3 using token addresses
 */
export function createUniswapV3ByAddressAdapter(): UniswapV3Adapter {
  return new UniswapV3Adapter({
    token0Address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    token1Address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  });
}

/**
 * Example 3: Uniswap V2 adapter
 */
export function createUniswapV2Adapter(): UniswapV2Adapter {
  return new UniswapV2Adapter({
    token0Symbol: 'ETH',
    token1Symbol: 'USDC',
  });
}

/**
 * Example 4: Custom The Graph subgraph
 */
export function createCustomSubgraphAdapter(): TheGraphDataAdapter {
  return new TheGraphDataAdapter({
    subgraphUrl: 'https://api.thegraph.com/subgraphs/name/your-subgraph',
    poolAddress: '0x...',
    token0Symbol: 'ETH',
    token1Symbol: 'USDC',
  });
}

/**
 * Example 5: Curve pool adapter
 */
export function createCurveAdapter(): CurveAdapter {
  return new CurveAdapter({
    poolAddress: '0x...', // Curve pool address
    token0Symbol: 'USDC',
    token1Symbol: 'USDT',
  });
}

/**
 * Usage example:
 * 
 * import { createUniswapV3ETHUSDCAdapter } from './TheGraphExamples';
 * import { RunBacktestUseCase } from '@application/use-cases/RunBacktest';
 * 
 * const adapter = createUniswapV3ETHUSDCAdapter();
 * 
 * const useCase = new RunBacktestUseCase();
 * const result = await useCase.execute({
 *   startDate: new Date('2024-01-01'),
 *   endDate: new Date('2024-12-31'),
 *   initialCapital: 100000,
 *   strategies: [...],
 *   customDataAdapter: adapter, // Use The Graph adapter
 * });
 */

