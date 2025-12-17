import { BotState } from '../entities/BotState';
import { Candle } from '../entities/Candle';

export interface IBotStateRepository {
  findByPoolId(poolId: string): Promise<BotState | null>;
  save(state: BotState): Promise<void>;
  saveCandles(candles: Candle[], poolId: string): Promise<void>;
  getCandles(poolId: string, limit: number): Promise<Candle[]>;
}
