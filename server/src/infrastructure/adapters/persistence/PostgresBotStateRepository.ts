import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IBotStateRepository } from '../../../domain/ports/IBotStateRepository';
import { BotState } from '../../../domain/entities/BotState';
import { Candle } from '../../../domain/entities/Candle';
import { BotStateEntity } from './entities/BotState.entity';
import { CandleEntity } from './entities/Candle.entity';
import { Volatility } from '../../../domain/value-objects/Volatility';
import { HurstExponent } from '../../../domain/value-objects/HurstExponent';

@Injectable()
export class PostgresBotStateRepository implements IBotStateRepository {
  constructor(
    @InjectRepository(BotStateEntity)
    private readonly botStateRepo: Repository<BotStateEntity>,
    @InjectRepository(CandleEntity)
    private readonly candleRepo: Repository<CandleEntity>,
  ) {}

  async findByPoolId(poolId: string): Promise<BotState | null> {
    const entity = await this.botStateRepo.findOne({ where: { poolId } });
    if (!entity) return null;

    return new BotState(
      entity.poolId,
      entity.poolId,
      entity.priceLower,
      entity.priceUpper,
      entity.lastRebalancePrice,
      entity.lastRebalanceAt,
      entity.currentVolatility
        ? new Volatility(entity.currentVolatility)
        : undefined,
      entity.currentHurst ? new HurstExponent(entity.currentHurst) : undefined,
      entity.isActive,
    );
  }

  async save(state: BotState): Promise<void> {
    const entity = new BotStateEntity();
    entity.poolId = state.poolId;
    entity.priceLower = state.priceLower;
    entity.priceUpper = state.priceUpper;
    entity.lastRebalancePrice = state.lastRebalancePrice;
    entity.lastRebalanceAt = state.lastRebalanceAt;
    entity.currentVolatility = state.currentVolatility?.value ?? 0; // Default to 0 or handle null in entity
    entity.currentHurst = state.currentHurst?.value ?? 0;
    entity.isActive = state.isActive;

    await this.botStateRepo.save(entity);
  }

  async saveCandles(candles: Candle[], poolId: string): Promise<void> {
    const entities = candles.map((c) => {
      const entity = new CandleEntity();
      entity.poolAddress = poolId;
      entity.timestamp = c.timestamp;
      entity.open = c.open;
      entity.high = c.high;
      entity.low = c.low;
      entity.close = c.close;
      entity.volume = c.volume;
      return entity;
    });

    // Use upsert to handle duplicates
    await this.candleRepo.upsert(entities, ['poolAddress', 'timestamp']);
  }

  async getCandles(poolId: string, limit: number): Promise<Candle[]> {
    const entities = await this.candleRepo.find({
      where: { poolAddress: poolId },
      order: { timestamp: 'DESC' },
      take: limit,
    });

    // Return in ascending order for analysis
    return entities
      .reverse()
      .map(
        (e) =>
          new Candle(e.timestamp, e.open, e.high, e.low, e.close, e.volume),
      );
  }
}
