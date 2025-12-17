import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { IBotStateRepository } from '../../../domain/ports/IBotStateRepository';
import { BotState } from '../../../domain/entities/BotState';
import { Candle } from '../../../domain/entities/Candle';
import { Volatility } from '../../../domain/value-objects/Volatility';
import { HurstExponent } from '../../../domain/value-objects/HurstExponent';

interface FileState {
  poolId: string;
  priceLower: number;
  priceUpper: number;
  lastRebalancePrice: number;
  lastRebalanceAt: string; // ISO string
  currentVolatility?: number;
  currentHurst?: number;
  isActive: boolean;
}

interface FileStorage {
  states: Record<string, FileState>;
  candles: Record<
    string,
    Array<{
      timestamp: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>
  >;
}

@Injectable()
export class FileBotStateRepository implements IBotStateRepository {
  private readonly logger = new Logger(FileBotStateRepository.name);
  private readonly storagePath: string;
  private cache: FileStorage | null = null;

  constructor(private configService: ConfigService) {
    const dataDir = this.configService.get<string>(
      'STORAGE_DATA_DIR',
      './data',
    );
    this.storagePath = path.resolve(dataDir, 'bot_state.json');
    this.ensureDataDirectory(dataDir);
  }

  private async ensureDataDirectory(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      this.logger.error(`Failed to create data directory: ${error.message}`);
    }
  }

  private async loadStorage(): Promise<FileStorage> {
    if (this.cache) return this.cache;

    try {
      const data = await fs.readFile(this.storagePath, 'utf-8');
      this.cache = JSON.parse(data);
      return this.cache!;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, create empty storage
        this.cache = { states: {}, candles: {} };
        await this.saveStorage();
        return this.cache;
      }
      this.logger.error(`Failed to load storage: ${error.message}`);
      throw error;
    }
  }

  private async saveStorage(): Promise<void> {
    if (!this.cache) return;

    try {
      // Write atomically by writing to temp file then renaming
      const tempPath = `${this.storagePath}.tmp`;
      await fs.writeFile(
        tempPath,
        JSON.stringify(this.cache, null, 2),
        'utf-8',
      );
      await fs.rename(tempPath, this.storagePath);
    } catch (error) {
      this.logger.error(`Failed to save storage: ${error.message}`);
      throw error;
    }
  }

  async findByPoolId(poolId: string): Promise<BotState | null> {
    const storage = await this.loadStorage();
    const state = storage.states[poolId];
    if (!state) return null;

    return new BotState(
      state.poolId,
      state.poolId,
      state.priceLower,
      state.priceUpper,
      state.lastRebalancePrice,
      new Date(state.lastRebalanceAt),
      state.currentVolatility
        ? new Volatility(state.currentVolatility)
        : undefined,
      state.currentHurst ? new HurstExponent(state.currentHurst) : undefined,
      state.isActive,
    );
  }

  async save(state: BotState): Promise<void> {
    const storage = await this.loadStorage();
    storage.states[state.poolId] = {
      poolId: state.poolId,
      priceLower: state.priceLower,
      priceUpper: state.priceUpper,
      lastRebalancePrice: state.lastRebalancePrice,
      lastRebalanceAt: state.lastRebalanceAt.toISOString(),
      currentVolatility: state.currentVolatility?.value,
      currentHurst: state.currentHurst?.value,
      isActive: state.isActive,
    };
    await this.saveStorage();
  }

  async saveCandles(candles: Candle[], poolId: string): Promise<void> {
    const storage = await this.loadStorage();
    if (!storage.candles[poolId]) {
      storage.candles[poolId] = [];
    }

    const existingTimestamps = new Set(
      storage.candles[poolId].map((c) => c.timestamp),
    );

    // Add new candles, avoiding duplicates
    for (const candle of candles) {
      const timestamp = candle.timestamp.toISOString();
      if (!existingTimestamps.has(timestamp)) {
        storage.candles[poolId].push({
          timestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        });
      }
    }

    // Sort by timestamp and keep only recent candles (last 1000 per pool)
    storage.candles[poolId].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    if (storage.candles[poolId].length > 1000) {
      storage.candles[poolId] = storage.candles[poolId].slice(-1000);
    }

    await this.saveStorage();
  }

  async getCandles(poolId: string, limit: number): Promise<Candle[]> {
    const storage = await this.loadStorage();
    const candles = storage.candles[poolId] || [];

    // Return most recent candles
    return candles
      .slice(-limit)
      .map(
        (c) =>
          new Candle(
            new Date(c.timestamp),
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume,
          ),
      );
  }
}
