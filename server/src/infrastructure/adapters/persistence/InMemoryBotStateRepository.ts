import { Injectable, Logger } from '@nestjs/common';
import { IBotStateRepository } from '../../../domain/ports/IBotStateRepository';
import { BotState } from '../../../domain/entities/BotState';
import { Candle } from '../../../domain/entities/Candle';
import { Volatility } from '../../../domain/value-objects/Volatility';
import { HurstExponent } from '../../../domain/value-objects/HurstExponent';

@Injectable()
export class InMemoryBotStateRepository implements IBotStateRepository {
  private readonly logger = new Logger(InMemoryBotStateRepository.name);
  private readonly states = new Map<string, BotState>();
  private readonly candles = new Map<string, Candle[]>();

  async findByPoolId(poolId: string): Promise<BotState | null> {
    return this.states.get(poolId) || null;
  }

  async save(state: BotState): Promise<void> {
    this.states.set(state.poolId, state);
    this.logger.debug(`Saved state for pool ${state.poolId} in memory`);
  }

  async saveCandles(candles: Candle[], poolId: string): Promise<void> {
    const existing = this.candles.get(poolId) || [];
    const existingTimestamps = new Set(existing.map((c) => c.timestamp.getTime()));

    // Add new candles, avoiding duplicates
    const newCandles = candles.filter(
      (c) => !existingTimestamps.has(c.timestamp.getTime()),
    );

    const allCandles = [...existing, ...newCandles].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    // Keep only last 1000 candles per pool
    this.candles.set(poolId, allCandles.slice(-1000));
    this.logger.debug(`Saved ${newCandles.length} candles for pool ${poolId} in memory`);
  }

  async getCandles(poolId: string, limit: number): Promise<Candle[]> {
    const poolCandles = this.candles.get(poolId) || [];
    return poolCandles.slice(-limit);
  }

  // Utility method to clear all data (useful for testing)
  clear(): void {
    this.states.clear();
    this.candles.clear();
    this.logger.debug('Cleared all in-memory state');
  }
}

