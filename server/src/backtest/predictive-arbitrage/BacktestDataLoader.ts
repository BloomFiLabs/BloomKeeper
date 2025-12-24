/**
 * BacktestDataLoader - Loads and aligns historical funding rate data for backtesting
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { BacktestFundingPoint } from './types';

/**
 * Raw historical data structure from disk cache
 */
interface CachedFundingRate {
  symbol: string;
  exchange: string;
  rate: number;
  markPrice?: number;
  timestamp: string;
}

/**
 * Symbol mapping from cached-symbols.json
 */
interface SymbolMapping {
  normalizedSymbol: string;
  exchanges: string[];
  hyperliquidSymbol?: string;
  lighterMarketIndex?: number;
  lighterSymbol?: string;
  asterSymbol?: string;
}

/**
 * Data loading result
 */
export interface LoadedBacktestData {
  symbols: string[];
  startDate: Date;
  endDate: Date;
  totalDataPoints: number;
  dataBySymbol: Map<string, BacktestFundingPoint[]>;
  warnings: string[];
}

/**
 * BacktestDataLoader - Loads historical funding rate data from cache
 */
export class BacktestDataLoader {
  private readonly dataDir: string;
  private readonly symbolsPath: string;
  
  constructor(baseDir: string = process.cwd()) {
    this.dataDir = path.join(baseDir, 'data');
    this.symbolsPath = path.join(baseDir, 'src', 'config', 'cached-symbols.json');
  }
  
  /**
   * Load all available historical data for Hyperliquid/Lighter pairs
   */
  async loadData(options: {
    symbolWhitelist?: string[];
    symbolBlacklist?: string[];
    startDate?: Date;
    endDate?: Date;
  } = {}): Promise<LoadedBacktestData> {
    const warnings: string[] = [];
    
    // Load symbol mappings
    const symbols = await this.loadSymbolMappings(options.symbolWhitelist, options.symbolBlacklist);
    if (symbols.length === 0) {
      throw new Error('No valid Hyperliquid/Lighter symbol pairs found');
    }
    
    // Load cached historical data
    const rawData = await this.loadCachedData();
    if (Object.keys(rawData).length === 0) {
      throw new Error('No cached historical data found. Run the server to collect data first.');
    }
    
    // Align data by symbol and timestamp
    const dataBySymbol = new Map<string, BacktestFundingPoint[]>();
    let globalStartDate: Date | null = null;
    let globalEndDate: Date | null = null;
    let totalDataPoints = 0;
    
    for (const symbol of symbols) {
      const hlKey = `${symbol}_${ExchangeType.HYPERLIQUID}`;
      const lighterKey = `${symbol}_${ExchangeType.LIGHTER}`;
      
      const hlData = rawData[hlKey] || [];
      const lighterData = rawData[lighterKey] || [];
      
      if (hlData.length === 0 && lighterData.length === 0) {
        warnings.push(`No data for ${symbol} on either exchange`);
        continue;
      }
      
      if (hlData.length === 0) {
        warnings.push(`No Hyperliquid data for ${symbol}`);
        continue;
      }
      
      if (lighterData.length === 0) {
        warnings.push(`No Lighter data for ${symbol}`);
        continue;
      }
      
      // Align data points by timestamp (hourly matching)
      const alignedData = this.alignDataPoints(symbol, hlData, lighterData, options.startDate, options.endDate);
      
      if (alignedData.length < 24) {
        warnings.push(`Insufficient aligned data for ${symbol}: only ${alignedData.length} points`);
        continue;
      }
      
      dataBySymbol.set(symbol, alignedData);
      totalDataPoints += alignedData.length;
      
      // Update global date range
      const symbolStart = alignedData[0].timestamp;
      const symbolEnd = alignedData[alignedData.length - 1].timestamp;
      
      if (!globalStartDate || symbolStart < globalStartDate) {
        globalStartDate = symbolStart;
      }
      if (!globalEndDate || symbolEnd > globalEndDate) {
        globalEndDate = symbolEnd;
      }
    }
    
    if (dataBySymbol.size === 0) {
      throw new Error('No valid symbol data after alignment. Check warnings.');
    }
    
    return {
      symbols: Array.from(dataBySymbol.keys()),
      startDate: globalStartDate!,
      endDate: globalEndDate!,
      totalDataPoints,
      dataBySymbol,
      warnings,
    };
  }
  
  /**
   * Load symbol mappings that have both Hyperliquid and Lighter support
   */
  private async loadSymbolMappings(
    whitelist?: string[],
    blacklist?: string[],
  ): Promise<string[]> {
    try {
      const content = fs.readFileSync(this.symbolsPath, 'utf-8');
      const data = JSON.parse(content);
      
      const validSymbols: string[] = [];
      
      for (const mapping of data.symbols as SymbolMapping[]) {
        // Must have both Hyperliquid and Lighter
        if (!mapping.hyperliquidSymbol || mapping.lighterMarketIndex === undefined) {
          continue;
        }
        
        const symbol = mapping.normalizedSymbol;
        
        // Apply whitelist filter
        if (whitelist && whitelist.length > 0 && !whitelist.includes(symbol)) {
          continue;
        }
        
        // Apply blacklist filter
        if (blacklist && blacklist.includes(symbol)) {
          continue;
        }
        
        validSymbols.push(symbol);
      }
      
      return validSymbols;
    } catch (error) {
      console.warn('Could not load symbol mappings, using fallback list');
      // Fallback to common symbols
      return ['BTC', 'ETH', 'SOL', 'DOGE', 'LINK', 'AVAX'];
    }
  }
  
  /**
   * Load cached historical data from disk
   */
  private async loadCachedData(): Promise<Record<string, CachedFundingRate[]>> {
    const filePath = path.join(this.dataDir, 'historical-funding-rates.json');
    
    if (!fs.existsSync(filePath)) {
      return {};
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      // Convert timestamp strings to Date objects
      const result: Record<string, CachedFundingRate[]> = {};
      
      for (const [key, points] of Object.entries(data)) {
        if (Array.isArray(points)) {
          result[key] = (points as any[]).map(p => ({
            ...p,
            timestamp: p.timestamp, // Keep as string for now
          }));
        }
      }
      
      return result;
    } catch (error) {
      console.error('Failed to load cached data:', error);
      return {};
    }
  }
  
  /**
   * Align Hyperliquid and Lighter data points by timestamp
   * Uses 1-hour matching window since both use hourly funding
   */
  private alignDataPoints(
    symbol: string,
    hlData: CachedFundingRate[],
    lighterData: CachedFundingRate[],
    startDate?: Date,
    endDate?: Date,
  ): BacktestFundingPoint[] {
    const MATCH_WINDOW_MS = 60 * 60 * 1000; // 1 hour
    
    // Convert to Date objects and sort
    const hlPoints = hlData
      .map(p => ({ ...p, timestamp: new Date(p.timestamp) }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    const lighterPoints = lighterData
      .map(p => ({ ...p, timestamp: new Date(p.timestamp) }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    const alignedPoints: BacktestFundingPoint[] = [];
    const matchedLighterIndices = new Set<number>();
    
    for (const hlPoint of hlPoints) {
      // Apply date filters
      if (startDate && hlPoint.timestamp < startDate) continue;
      if (endDate && hlPoint.timestamp > endDate) continue;
      
      // Find closest Lighter point within window
      let bestMatch: typeof lighterPoints[0] | null = null;
      let bestMatchIdx = -1;
      let bestTimeDiff = Infinity;
      
      for (let i = 0; i < lighterPoints.length; i++) {
        if (matchedLighterIndices.has(i)) continue;
        
        const timeDiff = Math.abs(hlPoint.timestamp.getTime() - lighterPoints[i].timestamp.getTime());
        
        if (timeDiff < MATCH_WINDOW_MS && timeDiff < bestTimeDiff) {
          bestMatch = lighterPoints[i];
          bestMatchIdx = i;
          bestTimeDiff = timeDiff;
        }
      }
      
      if (bestMatch && bestMatchIdx >= 0) {
        matchedLighterIndices.add(bestMatchIdx);
        
        // Calculate spread: We want to be SHORT on high funding, LONG on low funding
        // Spread = funding we receive (short exchange) - funding we pay (long exchange)
        // Positive spread = profitable when short on higher rate, long on lower rate
        const spread = hlPoint.rate - bestMatch.rate; // If HL > Lighter, short HL long Lighter
        
        alignedPoints.push({
          symbol,
          timestamp: hlPoint.timestamp,
          hyperliquidRate: hlPoint.rate,
          lighterRate: bestMatch.rate,
          spread,
          hyperliquidMarkPrice: hlPoint.markPrice || 0,
          lighterMarkPrice: bestMatch.markPrice || 0,
        });
      }
    }
    
    return alignedPoints.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  
  /**
   * Get summary statistics for loaded data
   */
  getSummaryStats(data: LoadedBacktestData): {
    symbolCount: number;
    totalHours: number;
    avgDataPointsPerSymbol: number;
    dateRange: string;
    spreadStats: {
      avgSpread: number;
      maxSpread: number;
      minSpread: number;
      positiveSpreadPercent: number;
    };
  } {
    const totalHours = Math.round(
      (data.endDate.getTime() - data.startDate.getTime()) / (1000 * 60 * 60)
    );
    
    // Calculate spread statistics across all data
    let allSpreads: number[] = [];
    
    for (const points of data.dataBySymbol.values()) {
      for (const point of points) {
        if (point.spread !== null) {
          allSpreads.push(point.spread);
        }
      }
    }
    
    const avgSpread = allSpreads.length > 0
      ? allSpreads.reduce((a, b) => a + b, 0) / allSpreads.length
      : 0;
    
    const positiveCount = allSpreads.filter(s => s > 0).length;
    
    return {
      symbolCount: data.symbols.length,
      totalHours,
      avgDataPointsPerSymbol: Math.round(data.totalDataPoints / data.symbols.length),
      dateRange: `${data.startDate.toISOString().split('T')[0]} to ${data.endDate.toISOString().split('T')[0]}`,
      spreadStats: {
        avgSpread,
        maxSpread: allSpreads.length > 0 ? Math.max(...allSpreads) : 0,
        minSpread: allSpreads.length > 0 ? Math.min(...allSpreads) : 0,
        positiveSpreadPercent: allSpreads.length > 0 ? (positiveCount / allSpreads.length) * 100 : 0,
      },
    };
  }
}

