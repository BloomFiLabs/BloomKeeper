import { Candle } from '../entities/Candle';

export interface IMarketDataProvider {
  getHistory(poolAddress: string, hours: number): Promise<Candle[]>;
  getLatestCandle(poolAddress: string): Promise<Candle>;
  getPoolFeeApr(poolAddress: string): Promise<number>;
  getPoolFeeTier(poolAddress: string): Promise<number>; // Returns fee tier as decimal (e.g., 0.01 = 1%)
}
