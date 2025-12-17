import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gql, GraphQLClient } from 'graphql-request';
import { IMarketDataProvider } from '../../../domain/ports/IMarketDataProvider';
import { Candle } from '../../../domain/entities/Candle';

@Injectable()
export class UniswapGraphAdapter implements IMarketDataProvider {
  private client: GraphQLClient;
  private readonly SUBGRAPH_URL =
    'https://gateway.thegraph.com/api/subgraphs/id/HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1';

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('GRAPH_API_KEY');

    this.client = new GraphQLClient(this.SUBGRAPH_URL, {
      headers: apiKey
        ? {
            Authorization: `Bearer ${apiKey}`,
          }
        : {},
    });
  }

  async getHistory(poolAddress: string, hours: number): Promise<Candle[]> {
    const now = Math.floor(Date.now() / 1000);
    const start = now - hours * 3600;

    const query = gql`
      query GetPoolHourDatas($pool: String!, $start: Int!) {
        poolHourDatas(
          where: { pool: $pool, periodStartUnix_gt: $start }
          orderBy: periodStartUnix
          orderDirection: asc
          first: 1000
        ) {
          periodStartUnix
          open
          high
          low
          close
          volumeUSD
        }
      }
    `;

    const data = await this.client.request<any>(query, {
      pool: poolAddress.toLowerCase(),
      start,
    });

    return data.poolHourDatas.map(this.mapToCandle);
  }

  async getLatestCandle(poolAddress: string): Promise<Candle> {
    const query = gql`
      query GetLatestCandle($pool: String!) {
        poolHourDatas(
          where: { pool: $pool }
          orderBy: periodStartUnix
          orderDirection: desc
          first: 1
        ) {
          periodStartUnix
          open
          high
          low
          close
          volumeUSD
        }
      }
    `;

    const data = await this.client.request<any>(query, {
      pool: poolAddress.toLowerCase(),
    });

    if (!data.poolHourDatas || data.poolHourDatas.length === 0) {
      throw new Error(`No candle data found for pool ${poolAddress}`);
    }

    return this.mapToCandle(data.poolHourDatas[0]);
  }

  /**
   * Get pool fee APR based on 7-day average (more stable than 24h)
   * Formula: APR = (avg_daily_fees / avg_tvl) * 365 * 100
   */
  async getPoolFeeApr(poolAddress: string): Promise<number> {
    const query = gql`
      query GetPoolMetrics($pool: String!) {
        pool(id: $pool) {
          feeTier
          totalValueLockedUSD
          volumeUSD
          feesUSD
        }
        poolDayDatas(
          where: { pool: $pool }
          orderBy: date
          orderDirection: desc
          first: 7
        ) {
          feesUSD
          tvlUSD
        }
      }
    `;

    try {
      const data = await this.client.request<any>(query, {
        pool: poolAddress.toLowerCase(),
      });

      if (!data.poolDayDatas || data.poolDayDatas.length === 0) {
        // Fallback to pool-level data
        const pool = data.pool;
        if (
          !pool ||
          !pool.totalValueLockedUSD ||
          Number(pool.totalValueLockedUSD) === 0
        ) {
          return 11.0; // Fallback to historical average for 0.05% pools
        }

        // Estimate daily fees from fee tier and volume (rough approximation)
        const feeTier = Number(pool.feeTier) / 1e6; // Convert from basis points
        const estimatedDailyFees = (Number(pool.volumeUSD) * feeTier) / 7; // Approximate daily from weekly volume
        const tvl = Number(pool.totalValueLockedUSD);
        const dailyApr = (estimatedDailyFees / tvl) * 100;
        return dailyApr * 365;
      }

      // FIXED: Calculate 7-day average APR (much more stable than single day)
      let totalFees = 0;
      let totalTvl = 0;
      let daysCount = 0;

      for (const dayData of data.poolDayDatas) {
        const fees = Number(dayData.feesUSD);
        const tvl = Number(dayData.tvlUSD);
        if (tvl > 0 && fees > 0) {
          totalFees += fees;
          totalTvl += tvl;
          daysCount++;
        }
      }

      if (daysCount === 0 || totalTvl === 0) {
        return 11.0; // Fallback
      }

      // APR = (avg daily fees / avg TVL) * 365 * 100
      const avgDailyFees = totalFees / daysCount;
      const avgTvl = totalTvl / daysCount;
      const dailyRate = avgDailyFees / avgTvl;
      const apr = dailyRate * 365 * 100;

      return apr;
    } catch (error) {
      console.warn(`⚠️  Failed to fetch pool APR: ${error.message}`);
      return 11.0; // Fallback to historical average
    }
  }

  /**
   * Get pool fee tier from The Graph
   * Returns fee tier as decimal (e.g., 0.01 = 1%, 0.0005 = 0.05%)
   */
  async getPoolFeeTier(poolAddress: string): Promise<number> {
    const query = gql`
      query GetPoolFeeTier($pool: String!) {
        pool(id: $pool) {
          feeTier
        }
      }
    `;

    try {
      const data = await this.client.request<any>(query, {
        pool: poolAddress.toLowerCase(),
      });

      if (data.pool?.feeTier !== undefined) {
        // Fee tier is stored as integer in basis points (e.g., 10000 = 1%, 500 = 0.05%)
        // Convert to decimal: divide by 1,000,000
        return Number(data.pool.feeTier) / 1e6;
      }

      // Fallback to 0.05% (most common Uniswap V3 fee tier)
      console.warn(
        `⚠️  Could not fetch fee tier for pool ${poolAddress}, using default 0.05%`,
      );
      return 0.0005;
    } catch (error) {
      console.warn(`⚠️  Failed to fetch pool fee tier: ${error.message}`);
      return 0.0005; // Fallback to 0.05%
    }
  }

  private mapToCandle(data: any): Candle {
    // The Graph returns token1/token0 price ratios
    // For WETH/USDC pool: token0=WETH, token1=USDC
    // The price from subgraph is already human-readable (e.g., 0.00035 USDC per WETH)
    // To get ETH price in USD, we just need to invert: 1 / 0.00035 ≈ $2857

    const convertPrice = (ratio: number): number => {
      if (ratio === 0) return 0;
      return 1 / ratio; // Simple inversion
    };

    return new Candle(
      new Date(data.periodStartUnix * 1000),
      convertPrice(parseFloat(data.open)),
      convertPrice(parseFloat(data.low)), // Note: inversion swaps high/low
      convertPrice(parseFloat(data.high)),
      convertPrice(parseFloat(data.close)),
      parseFloat(data.volumeUSD),
    );
  }
}
