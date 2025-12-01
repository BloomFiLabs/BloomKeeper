import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { IBotStateRepository } from '../../../domain/ports/IBotStateRepository';
import { BotState } from '../../../domain/entities/BotState';
import { Candle } from '../../../domain/entities/Candle';
import { Volatility } from '../../../domain/value-objects/Volatility';
import { HurstExponent } from '../../../domain/value-objects/HurstExponent';

@Injectable()
export class PrismaBotStateRepository implements IBotStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByPoolId(poolId: string): Promise<BotState | null> {
    const entity = await this.prisma.client.botState.findUnique({
      where: { poolId },
    });

    if (!entity) return null;

    return new BotState(
      entity.poolId,
      entity.poolId,
      entity.priceLower,
      entity.priceUpper,
      entity.lastRebalancePrice,
      entity.lastRebalanceAt,
      entity.currentVolatility ? new Volatility(entity.currentVolatility) : undefined,
      entity.currentHurst ? new HurstExponent(entity.currentHurst) : undefined,
      entity.isActive,
    );
  }

  async save(state: BotState): Promise<void> {
    await this.prisma.client.botState.upsert({
      where: { poolId: state.poolId },
      update: {
        priceLower: state.priceLower,
        priceUpper: state.priceUpper,
        lastRebalancePrice: state.lastRebalancePrice,
        lastRebalanceAt: state.lastRebalanceAt,
        currentVolatility: state.currentVolatility?.value ?? null,
        currentHurst: state.currentHurst?.value ?? null,
        isActive: state.isActive,
      },
      create: {
        poolId: state.poolId,
        priceLower: state.priceLower,
        priceUpper: state.priceUpper,
        lastRebalancePrice: state.lastRebalancePrice,
        lastRebalanceAt: state.lastRebalanceAt,
        currentVolatility: state.currentVolatility?.value ?? null,
        currentHurst: state.currentHurst?.value ?? null,
        isActive: state.isActive,
      },
    });
  }

  async saveCandles(candles: Candle[], poolId: string): Promise<void> {
    const data = candles.map((candle) => ({
      poolAddress: poolId,
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));

    // Use createMany with skipDuplicates for efficient bulk insert
    await this.prisma.client.candle.createMany({
      data,
      skipDuplicates: true,
    });
  }

  async getCandles(poolId: string, limit: number): Promise<Candle[]> {
    const entities = await this.prisma.client.candle.findMany({
      where: { poolAddress: poolId },
      orderBy: { timestamp: 'asc' },
      take: limit,
    });

    return entities.map(
      (e) => new Candle(e.timestamp, e.open, e.high, e.low, e.close, e.volume),
    );
  }
}

