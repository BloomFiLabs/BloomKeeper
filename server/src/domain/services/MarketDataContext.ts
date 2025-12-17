import { Logger } from '@nestjs/common';

/**
 * MarketDataContext - Fetched ONCE per cycle, shared across ALL strategies
 *
 * This prevents redundant API calls and ensures all strategies
 * see the same market snapshot for consistent decision-making.
 */

export interface FundingData {
  asset: string;
  currentRate: number; // Current funding rate (per 8h)
  predictedRate: number; // Predicted next funding
  markPrice: number; // Current mark price
  indexPrice: number; // Index price
  openInterest: number; // Total open interest
  fundingAPY: number; // Annualized funding rate
}

export interface LendingData {
  asset: string;
  supplyAPY: number; // Supply APY
  borrowAPY: number; // Borrow APY
  utilization: number; // Pool utilization
  availableLiquidity: number;
}

export interface VolatilityData {
  asset: string;
  impliedVol: number; // IV from options (Deribit)
  realizedVol: number; // Historical realized vol
  garchVol: number; // GARCH forecast
  hurst: number; // Hurst exponent
}

export interface PriceData {
  asset: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
}

export interface GasData {
  chainId: number;
  gasPriceGwei: number;
  nativeTokenPrice: number;
  estimatedTxCostUSD: number;
}

export interface PoolData {
  address: string;
  token0: string;
  token1: string;
  feeTier: number;
  tvl: number;
  volume24h: number;
  feeAPR: number;
}

/**
 * Complete market snapshot - fetched once, used by all strategies
 */
export interface MarketDataContext {
  timestamp: number;

  // Funding rates for perp strategies
  funding: Map<string, FundingData>;

  // Lending rates for delta-neutral strategies
  lending: Map<string, LendingData>;

  // Volatility metrics for all strategies
  volatility: Map<string, VolatilityData>;

  // Current prices
  prices: Map<string, PriceData>;

  // Gas costs per chain
  gas: Map<number, GasData>;

  // Pool data for LP strategies
  pools: Map<string, PoolData>;
}

/**
 * Creates an empty context
 */
export function createEmptyContext(): MarketDataContext {
  return {
    timestamp: Date.now(),
    funding: new Map(),
    lending: new Map(),
    volatility: new Map(),
    prices: new Map(),
    gas: new Map(),
    pools: new Map(),
  };
}

/**
 * MarketDataAggregator - Fetches all data once per cycle
 */
export class MarketDataAggregator {
  private readonly logger = new Logger(MarketDataAggregator.name);

  constructor(
    private readonly fundingProvider: IFundingProvider,
    private readonly lendingProvider: ILendingProvider,
    private readonly volatilityProvider: IVolatilityProvider,
    private readonly priceProvider: IPriceProvider,
    private readonly gasProvider: IGasProvider,
    private readonly poolProvider: IPoolProvider,
  ) {}

  /**
   * Fetch ALL market data in one call
   * This is called ONCE at the start of each execution cycle
   */
  async fetchAll(
    assets: string[],
    chains: number[],
    pools: string[],
  ): Promise<MarketDataContext> {
    const startTime = Date.now();
    const context = createEmptyContext();

    this.logger.debug(
      `Fetching market data for ${assets.length} assets, ${chains.length} chains, ${pools.length} pools...`,
    );

    // Fetch all data in parallel
    const [
      fundingResults,
      lendingResults,
      volResults,
      priceResults,
      gasResults,
      poolResults,
    ] = await Promise.allSettled([
      this.fetchAllFunding(assets),
      this.fetchAllLending(assets),
      this.fetchAllVolatility(assets),
      this.fetchAllPrices(assets),
      this.fetchAllGas(chains),
      this.fetchAllPools(pools),
    ]);

    // Process results
    if (fundingResults.status === 'fulfilled') {
      for (const data of fundingResults.value) {
        context.funding.set(data.asset, data);
      }
    } else {
      this.logger.warn(
        `Failed to fetch funding data: ${fundingResults.reason}`,
      );
    }

    if (lendingResults.status === 'fulfilled') {
      for (const data of lendingResults.value) {
        context.lending.set(data.asset, data);
      }
    } else {
      this.logger.warn(
        `Failed to fetch lending data: ${lendingResults.reason}`,
      );
    }

    if (volResults.status === 'fulfilled') {
      for (const data of volResults.value) {
        context.volatility.set(data.asset, data);
      }
    } else {
      this.logger.warn(`Failed to fetch volatility data: ${volResults.reason}`);
    }

    if (priceResults.status === 'fulfilled') {
      for (const data of priceResults.value) {
        context.prices.set(data.asset, data);
      }
    } else {
      this.logger.warn(`Failed to fetch price data: ${priceResults.reason}`);
    }

    if (gasResults.status === 'fulfilled') {
      for (const data of gasResults.value) {
        context.gas.set(data.chainId, data);
      }
    } else {
      this.logger.warn(`Failed to fetch gas data: ${gasResults.reason}`);
    }

    if (poolResults.status === 'fulfilled') {
      for (const data of poolResults.value) {
        context.pools.set(data.address, data);
      }
    } else {
      this.logger.warn(`Failed to fetch pool data: ${poolResults.reason}`);
    }

    const elapsed = Date.now() - startTime;
    this.logger.debug(`Market data fetched in ${elapsed}ms`);

    return context;
  }

  private async fetchAllFunding(assets: string[]): Promise<FundingData[]> {
    return Promise.all(
      assets.map((asset) => this.fundingProvider.getFundingData(asset)),
    );
  }

  private async fetchAllLending(assets: string[]): Promise<LendingData[]> {
    return Promise.all(
      assets.map((asset) => this.lendingProvider.getLendingData(asset)),
    );
  }

  private async fetchAllVolatility(
    assets: string[],
  ): Promise<VolatilityData[]> {
    return Promise.all(
      assets.map((asset) => this.volatilityProvider.getVolatilityData(asset)),
    );
  }

  private async fetchAllPrices(assets: string[]): Promise<PriceData[]> {
    return Promise.all(
      assets.map((asset) => this.priceProvider.getPriceData(asset)),
    );
  }

  private async fetchAllGas(chains: number[]): Promise<GasData[]> {
    return Promise.all(
      chains.map((chainId) => this.gasProvider.getGasData(chainId)),
    );
  }

  private async fetchAllPools(pools: string[]): Promise<PoolData[]> {
    return Promise.all(
      pools.map((address) => this.poolProvider.getPoolData(address)),
    );
  }
}

// ═══════════════════════════════════════════════════════════
// Provider Interfaces
// ═══════════════════════════════════════════════════════════

export interface IFundingProvider {
  getFundingData(asset: string): Promise<FundingData>;
}

export interface ILendingProvider {
  getLendingData(asset: string): Promise<LendingData>;
}

export interface IVolatilityProvider {
  getVolatilityData(asset: string): Promise<VolatilityData>;
}

export interface IPriceProvider {
  getPriceData(asset: string): Promise<PriceData>;
}

export interface IGasProvider {
  getGasData(chainId: number): Promise<GasData>;
}

export interface IPoolProvider {
  getPoolData(address: string): Promise<PoolData>;
}
