/**
 * Data adapter that calculates IV from historical price data
 * Extends CSV adapter to automatically calculate IV
 */

import { CSVDataAdapter } from './CSVDataAdapter';
import { IV } from '@domain/value-objects';
import { calculateRollingIV, calculateGarmanKlassIV, PricePoint } from '@shared/utils/IVCalculator';
import { OHLCVData } from './DataAdapter';

export class IVCalculatorAdapter extends CSVDataAdapter {
  private ivCache: Map<string, Map<number, number>> = new Map();

  /**
   * Calculate IV from OHLCV data using Garman-Klass estimator
   */
  async fetchIV(asset: string, timestamp: Date): Promise<IV | null> {
    // Check cache first
    const cacheKey = asset;
    const timestampKey = timestamp.getTime();
    
    if (this.ivCache.has(cacheKey)) {
      const assetCache = this.ivCache.get(cacheKey)!;
      if (assetCache.has(timestampKey)) {
        return IV.create(assetCache.get(timestampKey)!);
      }
    }

    // Fetch OHLCV data for calculation
    // Get data from 30 days before to current date for rolling window
    const startDate = new Date(timestamp);
    startDate.setDate(startDate.getDate() - 30);
    
    try {
      const ohlcvData = await this.fetchOHLCV(asset, startDate, timestamp);
      
      if (ohlcvData.length < 2) {
        return null;
      }

      // Convert to format for Garman-Klass calculation
      const pricePoints = ohlcvData.map((d) => ({
        timestamp: d.timestamp,
        open: d.open.value,
        high: d.high.value,
        low: d.low.value,
        close: d.close.value,
      }));

      // Calculate IV using Garman-Klass estimator
      const ivPoints = calculateGarmanKlassIV(pricePoints);
      
      // Find IV for the requested timestamp
      const ivPoint = ivPoints.find(
        (p) => p.timestamp.getTime() === timestampKey
      );

      if (ivPoint) {
        // Cache the result
        if (!this.ivCache.has(cacheKey)) {
          this.ivCache.set(cacheKey, new Map());
        }
        this.ivCache.get(cacheKey)!.set(timestampKey, ivPoint.iv);
        
        return IV.create(ivPoint.iv);
      }

      // If exact match not found, use most recent IV
      if (ivPoints.length > 0) {
        const latestIV = ivPoints[ivPoints.length - 1].iv;
        return IV.create(latestIV);
      }

      return null;
    } catch (error) {
      // If data fetch fails, return null
      return null;
    }
  }

  /**
   * Pre-calculate IV for a date range to improve performance
   */
  async precalculateIV(asset: string, startDate: Date, endDate: Date): Promise<void> {
    const ohlcvData = await this.fetchOHLCV(asset, startDate, endDate);
    
    if (ohlcvData.length < 2) {
      return;
    }

    // Convert to format for calculation
    const pricePoints = ohlcvData.map((d) => ({
      timestamp: d.timestamp,
      open: d.open.value,
      high: d.high.value,
      low: d.low.value,
      close: d.close.value,
    }));

    // Calculate IV for all points
    const ivPoints = calculateGarmanKlassIV(pricePoints);

    // Cache all results
    const cacheKey = asset;
    if (!this.ivCache.has(cacheKey)) {
      this.ivCache.set(cacheKey, new Map());
    }
    const assetCache = this.ivCache.get(cacheKey)!;

    for (const ivPoint of ivPoints) {
      assetCache.set(ivPoint.timestamp.getTime(), ivPoint.iv);
    }
  }
}


