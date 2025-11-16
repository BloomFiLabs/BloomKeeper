/**
 * Data Extrapolator
 * Extends historical data to simulate longer holding periods
 * Uses patterns from historical data to forecast/extrapolate forward
 */

import { DataAdapter, OHLCVData } from './DataAdapter';
import { Price, Amount, FundingRate, IV } from '@domain/value-objects';

export interface ExtrapolationConfig {
  method: 'repeat' | 'forecast' | 'trend';
  volatilityMultiplier?: number; // For forecast method
}

/**
 * Data adapter wrapper that extrapolates data beyond available range
 */
export class DataExtrapolatorAdapter implements DataAdapter {
  private baseAdapter: DataAdapter;
  private config: ExtrapolationConfig;
  private cachedData: Map<string, OHLCVData[]> = new Map();
  private dataStartDate?: Date;
  private dataEndDate?: Date;

  constructor(baseAdapter: DataAdapter, config: ExtrapolationConfig = { method: 'repeat' }) {
    this.baseAdapter = baseAdapter;
    this.config = config;
  }

  /**
   * Pre-load and cache historical data
   */
  async preloadData(asset: string, startDate: Date, endDate: Date): Promise<void> {
    const data = await this.baseAdapter.fetchOHLCV(asset, startDate, endDate);
    this.cachedData.set(asset, data);
    
    if (data.length > 0) {
      this.dataStartDate = data[0].timestamp;
      this.dataEndDate = data[data.length - 1].timestamp;
    }
  }

  async fetchPrice(asset: string, timestamp: Date): Promise<Price> {
    const data = await this.fetchOHLCV(asset, timestamp, timestamp);
    if (data.length === 0) {
      throw new Error(`No price data available for ${asset} at ${timestamp.toISOString()}`);
    }
    return data[0].close;
  }

  async fetchOHLCV(asset: string, startDate: Date, endDate: Date): Promise<OHLCVData[]> {
    // Try to fetch from base adapter first
    try {
      const baseData = await this.baseAdapter.fetchOHLCV(asset, startDate, endDate);
      if (baseData.length > 0) {
        return baseData;
      }
    } catch (error) {
      // Fall through to extrapolation
    }

    // Get cached historical data
    let historicalData = this.cachedData.get(asset);
    if (!historicalData || historicalData.length === 0) {
      // Try to fetch historical data
      try {
        historicalData = await this.baseAdapter.fetchOHLCV(asset, startDate, endDate);
        this.cachedData.set(asset, historicalData);
      } catch (error) {
        throw new Error(`No historical data available for ${asset} to extrapolate from`);
      }
    }

    if (historicalData.length === 0) {
      throw new Error(`No historical data available for ${asset}`);
    }

    // Determine if we need to extrapolate
    const firstHistoricalDate = historicalData[0].timestamp;
    const lastHistoricalDate = historicalData[historicalData.length - 1].timestamp;

    // If requested range is within historical data, return it
    if (startDate >= firstHistoricalDate && endDate <= lastHistoricalDate) {
      return historicalData.filter(
        (d) => d.timestamp >= startDate && d.timestamp <= endDate
      );
    }

    // Need to extrapolate
    return this.extrapolateData(historicalData, startDate, endDate);
  }

  /**
   * Extrapolate data using configured method
   */
  private extrapolateData(
    historicalData: OHLCVData[],
    startDate: Date,
    endDate: Date
  ): OHLCVData[] {
    const result: OHLCVData[] = [];

    // Filter historical data to requested range (if any overlap)
    const relevantHistorical = historicalData.filter(
      (d) => d.timestamp >= startDate && d.timestamp <= endDate
    );

    result.push(...relevantHistorical);

    // If we need data beyond historical range
    if (endDate > historicalData[historicalData.length - 1].timestamp) {
      const lastHistorical = historicalData[historicalData.length - 1];
      const extrapolated = this.generateFutureData(
        historicalData,
        lastHistorical.timestamp,
        endDate
      );
      result.push(...extrapolated);
    }

    // If we need data before historical range
    if (startDate < historicalData[0].timestamp) {
      const firstHistorical = historicalData[0];
      const extrapolated = this.generatePastData(
        historicalData,
        startDate,
        firstHistorical.timestamp
      );
      result.unshift(...extrapolated);
    }

    return result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Generate future data using repeat method
   */
  private generateFutureData(
    historicalData: OHLCVData[],
    fromDate: Date,
    toDate: Date
  ): OHLCVData[] {
    const result: OHLCVData[] = [];
    const daysDiff = Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));
    
    // Use last N days of historical data as pattern
    const patternLength = Math.min(30, historicalData.length); // Use last 30 days as pattern
    const pattern = historicalData.slice(-patternLength);

    let currentDate = new Date(fromDate);
    currentDate.setDate(currentDate.getDate() + 1); // Start from day after last historical

    let patternIndex = 0;
    for (let i = 0; i < daysDiff && currentDate <= toDate; i++) {
      const patternDay = pattern[patternIndex % pattern.length];
      
      // Create new data point based on pattern
      const newData: OHLCVData = {
        timestamp: new Date(currentDate),
        open: Price.create(patternDay.open.value),
        high: Price.create(patternDay.high.value),
        low: Price.create(patternDay.low.value),
        close: Price.create(patternDay.close.value),
        volume: Amount.create(patternDay.volume.value),
      };

      result.push(newData);
      
      currentDate.setDate(currentDate.getDate() + 1);
      patternIndex++;
    }

    return result;
  }

  /**
   * Generate past data (similar to future)
   */
  private generatePastData(
    historicalData: OHLCVData[],
    fromDate: Date,
    toDate: Date
  ): OHLCVData[] {
    // Use first N days as pattern
    const patternLength = Math.min(30, historicalData.length);
    const pattern = historicalData.slice(0, patternLength);

    const result: OHLCVData[] = [];
    const daysDiff = Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));
    
    let currentDate = new Date(fromDate);
    let patternIndex = pattern.length - 1; // Start from end of pattern (go backwards)

    for (let i = 0; i < daysDiff && currentDate < toDate; i++) {
      const patternDay = pattern[patternIndex % pattern.length];
      
      const newData: OHLCVData = {
        timestamp: new Date(currentDate),
        open: Price.create(patternDay.open.value),
        high: Price.create(patternDay.high.value),
        low: Price.create(patternDay.low.value),
        close: Price.create(patternDay.close.value),
        volume: Amount.create(patternDay.volume.value),
      };

      result.push(newData);
      
      currentDate.setDate(currentDate.getDate() + 1);
      patternIndex--;
      if (patternIndex < 0) patternIndex = pattern.length - 1;
    }

    return result.reverse(); // Reverse to get chronological order
  }

  async fetchVolume(asset: string, timestamp: Date): Promise<Amount> {
    const data = await this.fetchOHLCV(asset, timestamp, timestamp);
    if (data.length === 0) {
      return Amount.zero();
    }
    return data[0].volume;
  }

  async fetchFundingRate(_asset: string, _timestamp: Date): Promise<FundingRate | null> {
    return this.baseAdapter.fetchFundingRate(_asset, _timestamp);
  }

  async fetchIV(_asset: string, _timestamp: Date): Promise<IV | null> {
    return this.baseAdapter.fetchIV(_asset, _timestamp);
  }
}


