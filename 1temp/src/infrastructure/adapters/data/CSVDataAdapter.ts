import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';
import { DataAdapter, OHLCVData } from './DataAdapter';
import { Price, Amount, IV, FundingRate } from '@domain/value-objects';

export class CSVDataAdapter implements DataAdapter {
  constructor(private readonly dataDirectory: string) {
    if (!fs.existsSync(dataDirectory)) {
      fs.mkdirSync(dataDirectory, { recursive: true });
    }
  }

  async fetchPrice(asset: string, timestamp: Date): Promise<Price> {
    const data = await this.fetchOHLCV(asset, timestamp, timestamp);
    if (data.length === 0) {
      throw new Error(`No price data found for ${asset} at ${timestamp.toISOString()}`);
    }
    return data[0].close;
  }

  async fetchOHLCV(asset: string, startDate: Date, endDate: Date): Promise<OHLCVData[]> {
    const filePath = this.getFilePath(asset);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Data file not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      cast: true,
    }) as Array<{
      timestamp: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;

    return records
      .filter((record) => {
        const recordDate = new Date(record.timestamp);
        return recordDate >= startDate && recordDate <= endDate;
      })
      .map((record) => ({
        timestamp: new Date(record.timestamp),
        open: Price.create(record.open),
        high: Price.create(record.high),
        low: Price.create(record.low),
        close: Price.create(record.close),
        volume: Amount.create(record.volume),
      }));
  }

  async fetchFundingRate(_asset: string, _timestamp: Date): Promise<FundingRate | null> {
    // CSV adapter may not have funding rate data
    return null;
  }

  async fetchIV(_asset: string, _timestamp: Date): Promise<IV | null> {
    // CSV adapter may not have IV data
    return null;
  }

  async fetchVolume(asset: string, timestamp: Date): Promise<Amount> {
    const data = await this.fetchOHLCV(asset, timestamp, timestamp);
    if (data.length === 0) {
      return Amount.zero();
    }
    return data[0].volume;
  }

  private getFilePath(asset: string): string {
    const fileName = `${asset.replace('/', '-')}.csv`;
    return path.join(this.dataDirectory, fileName);
  }
}

