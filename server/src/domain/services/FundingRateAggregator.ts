import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { AsterFundingDataProvider } from '../../infrastructure/adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../../infrastructure/adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../../infrastructure/adapters/hyperliquid/HyperLiquidDataProvider';
import { HyperLiquidWebSocketProvider } from '../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import * as cliProgress from 'cli-progress';

/**
 * Funding rate data for a specific exchange and symbol
 */
export interface ExchangeFundingRate {
  exchange: ExchangeType;
  symbol: string;
  currentRate: number;
  predictedRate: number;
  markPrice: number;
  openInterest: number;
  timestamp: Date;
}

/**
 * Funding rate comparison for a symbol across exchanges
 */
export interface FundingRateComparison {
  symbol: string;
  rates: ExchangeFundingRate[];
  highestRate: ExchangeFundingRate | null;
  lowestRate: ExchangeFundingRate | null;
  spread: number; // Difference between highest and lowest
  timestamp: Date;
}

/**
 * Arbitrage opportunity
 */
export interface ArbitrageOpportunity {
  symbol: string;
  longExchange: ExchangeType; // Exchange to go long on (should have negative funding rate to receive funding)
  shortExchange: ExchangeType; // Exchange to go short on (should have positive funding rate to receive funding)
  longRate: number; // Funding rate on long exchange (negative = we receive, positive = we pay)
  shortRate: number; // Funding rate on short exchange (positive = we receive, negative = we pay)
  spread: number; // Absolute difference
  expectedReturn: number; // Annualized return estimate
  longMarkPrice?: number; // Mark price for long exchange (from funding rate data)
  shortMarkPrice?: number; // Mark price for short exchange (from funding rate data)
  timestamp: Date;
}

/**
 * Exchange-specific symbol mapping
 */
export interface ExchangeSymbolMapping {
  normalizedSymbol: string; // Common symbol (e.g., "ETH")
  asterSymbol?: string; // Aster format (e.g., "ETHUSDT")
  lighterMarketIndex?: number; // Lighter market index (e.g., 0)
  lighterSymbol?: string; // Lighter symbol name (e.g., "ETH")
  hyperliquidSymbol?: string; // Hyperliquid format (e.g., "ETH")
}

/**
 * Allowed assets with high liquidity - orchestrator will only process these
 * Assets must be available on at least 2 perpetual exchanges
 * Auto-discovered from Lighter + Hyperliquid (85 common assets)
 */
const ALLOWED_ASSETS = new Set([
  '0G',
  '2Z',
  'AAVE',
  'ADA',
  'AERO',
  'AI16Z',
  'APEX',
  'APT',
  'ARB',
  'ASTER',
  'AVAX',
  'AVNT',
  'BCH',
  'BERA',
  'BNB',
  'BTC',
  'CC',
  'CRV',
  'DOGE',
  'DOT',
  'DYDX',
  'EIGEN',
  'ENA',
  'ETH',
  'ETHFI',
  'FARTCOIN',
  'FIL',
  'GMX',
  'GRASS',
  'HBAR',
  'HYPE',
  'ICP',
  'IP',
  'JUP',
  'KAITO',
  'LAUNCHCOIN',
  'LDO',
  'LINEA',
  'LINK',
  'LTC',
  'MEGA',
  'MET',
  'MKR',
  'MNT',
  'MON',
  'MORPHO',
  'NEAR',
  'ONDO',
  'OP',
  'PAXG',
  'PENDLE',
  'PENGU',
  'POL',
  'POPCAT',
  'PROVE',
  'PUMP',
  'PYTH',
  'RESOLV',
  'S',
  'SEI',
  'SKY',
  'SOL',
  'SPX',
  'STBL',
  'STRK',
  'SUI',
  'SYRUP',
  'TAO',
  'TIA',
  'TON',
  'TRUMP',
  'TRX',
  'UNI',
  'VIRTUAL',
  'VVV',
  'WIF',
  'WLD',
  'WLFI',
  'XPL',
  'XRP',
  'YZY',
  'ZEC',
  'ZK',
  'ZORA',
  'ZRO',
]);

/**
 * FundingRateAggregator - Aggregates funding rates from all exchanges
 */
@Injectable()
export class FundingRateAggregator {
  private readonly logger = new Logger(FundingRateAggregator.name);
  private symbolMappings: Map<string, ExchangeSymbolMapping> = new Map(); // normalizedSymbol -> mapping

  constructor(
    private readonly asterProvider: AsterFundingDataProvider,
    private readonly lighterProvider: LighterFundingDataProvider,
    private readonly hyperliquidProvider: HyperLiquidDataProvider,
    private readonly hyperliquidWsProvider: HyperLiquidWebSocketProvider,
  ) {}

  /**
   * Normalize symbol name across exchanges
   * Aster: ETHUSDT -> ETH
   * Hyperliquid: ETH -> ETH
   * Lighter: ETH -> ETH
   */
  private normalizeSymbol(symbol: string): string {
    return symbol
      .replace('USDT', '')
      .replace('USDC', '')
      .replace('-PERP', '')
      .replace('PERP', '')
      .toUpperCase();
  }

  /**
   * Discover all common assets across all exchanges
   * Returns array of normalized symbol names that are available on at least 2 exchanges
   * Also builds symbol mappings for exchange-specific formats
   */
  async discoverCommonAssets(): Promise<string[]> {
    this.logger.log('Discovering all available assets across exchanges...');

    try {
      // Get all assets from each exchange
      const [asterSymbols, lighterMarkets, hyperliquidAssets] = await Promise.all([
        this.asterProvider.getAvailableSymbols().catch(() => []),
        this.lighterProvider.getAvailableMarkets().catch(() => []),
        this.hyperliquidProvider.getAvailableAssets().catch(() => []),
      ]);

      // Build symbol mappings
      this.symbolMappings.clear();
      
      // Process Aster symbols (format: "ETHUSDT", "BTCUSDT")
      for (const asterSymbol of asterSymbols) {
        const normalized = this.normalizeSymbol(asterSymbol);
        if (!this.symbolMappings.has(normalized)) {
          this.symbolMappings.set(normalized, { normalizedSymbol: normalized });
        }
        this.symbolMappings.get(normalized)!.asterSymbol = asterSymbol;
      }

      // Process Lighter markets (format: {marketIndex: 0, symbol: "ETH"})
      for (const market of lighterMarkets) {
        const normalized = this.normalizeSymbol(market.symbol);
        if (!this.symbolMappings.has(normalized)) {
          this.symbolMappings.set(normalized, { normalizedSymbol: normalized });
        }
        const mapping = this.symbolMappings.get(normalized)!;
        mapping.lighterMarketIndex = market.marketIndex;
        mapping.lighterSymbol = market.symbol;
      }

      // Process Hyperliquid assets (format: "ETH", "BTC")
      for (const hlAsset of hyperliquidAssets) {
        const normalized = this.normalizeSymbol(hlAsset);
        if (!this.symbolMappings.has(normalized)) {
          this.symbolMappings.set(normalized, { normalizedSymbol: normalized });
        }
        this.symbolMappings.get(normalized)!.hyperliquidSymbol = hlAsset;
      }

      // Subscribe to all Hyperliquid assets via WebSocket (reduces rate limits)
      if (this.hyperliquidWsProvider.isWsConnected() && hyperliquidAssets.length > 0) {
        this.hyperliquidWsProvider.subscribeToAssets(hyperliquidAssets);
        this.logger.log(`Subscribed to ${hyperliquidAssets.length} Hyperliquid assets via WebSocket`);
      }

      // Find common assets (available on at least 2 exchanges)
      const commonAssets: string[] = [];
      for (const [normalized, mapping] of this.symbolMappings.entries()) {
        let exchangeCount = 0;
        if (mapping.asterSymbol) exchangeCount++;
        if (mapping.lighterMarketIndex !== undefined) exchangeCount++;
        if (mapping.hyperliquidSymbol) exchangeCount++;

        // Only include if available on at least 2 exchanges (required for arbitrage)
        // AND if it's in the allowed assets list
        if (exchangeCount >= 2 && ALLOWED_ASSETS.has(normalized)) {
          commonAssets.push(normalized);
          this.logger.debug(
            `Mapped ${normalized}: Aster=${mapping.asterSymbol || 'N/A'}, ` +
            `Lighter=${mapping.lighterMarketIndex !== undefined ? `index ${mapping.lighterMarketIndex}` : 'N/A'}, ` +
            `Hyperliquid=${mapping.hyperliquidSymbol || 'N/A'}`
          );
        } else if (exchangeCount >= 2) {
          this.logger.debug(
            `Skipping ${normalized} (not in allowed assets list)`
          );
        }
      }

      this.logger.log(
        `Discovered ${commonAssets.length} common assets (filtered to high-liquidity assets): ${commonAssets.join(', ')}`
      );

      return commonAssets.sort();
    } catch (error: any) {
      this.logger.error(`Failed to discover common assets: ${error.message}`);
      // Fallback to default symbols if discovery fails
      return ['ETH', 'BTC'];
    }
  }

  /**
   * Get exchange-specific symbol for a normalized symbol
   */
  getExchangeSymbol(normalizedSymbol: string, exchange: ExchangeType): string | number | undefined {
    const mapping = this.symbolMappings.get(normalizedSymbol);
    if (!mapping) return undefined;

    switch (exchange) {
      case ExchangeType.ASTER:
        return mapping.asterSymbol;
      case ExchangeType.LIGHTER:
        return mapping.lighterMarketIndex;
      case ExchangeType.HYPERLIQUID:
        return mapping.hyperliquidSymbol;
      default:
        return undefined;
    }
  }

  /**
   * Get full symbol mapping for a normalized symbol
   */
  getSymbolMapping(normalizedSymbol: string): ExchangeSymbolMapping | undefined {
    return this.symbolMappings.get(normalizedSymbol);
  }

  /**
   * Get funding rates for a symbol across all exchanges
   * @param symbol Normalized symbol (e.g., 'ETH', 'BTC')
   */
  async getFundingRates(symbol: string): Promise<ExchangeFundingRate[]> {
    const rates: ExchangeFundingRate[] = [];

    // Get Aster funding rate
    // Use exchange-specific symbol format from mapping
    try {
      const mapping = this.getSymbolMapping(symbol);
      const asterSymbol = mapping?.asterSymbol;
      
      if (!asterSymbol) {
        // No mapping - skip silently
      } else {
        const asterRate = await this.asterProvider.getCurrentFundingRate(asterSymbol);
        const asterPredicted = await this.asterProvider.getPredictedFundingRate(asterSymbol);
        const asterMarkPrice = await this.asterProvider.getMarkPrice(asterSymbol);
        const asterOI = await this.asterProvider.getOpenInterest(asterSymbol);

        rates.push({
          exchange: ExchangeType.ASTER,
          symbol, // Use normalized symbol
          currentRate: asterRate,
          predictedRate: asterPredicted,
          markPrice: asterMarkPrice,
          openInterest: asterOI,
          timestamp: new Date(),
        });
      }
    } catch (error: any) {
      // Only log actual errors (not missing mappings)
      if (error.message && !error.message.includes('not found') && !error.message.includes('No funding rates')) {
        this.logger.error(`Failed to get Aster funding rate for ${symbol}: ${error.message}`);
      }
    }

    // Get Lighter funding rate
    // Use exchange-specific market index from mapping
    try {
      const mapping = this.getSymbolMapping(symbol);
      const marketIndex = mapping?.lighterMarketIndex;
      
      if (marketIndex === undefined) {
        // No mapping - skip silently
      } else {
        const lighterRate = await this.lighterProvider.getCurrentFundingRate(marketIndex);
        
        // Try to get additional data, but don't fail if mark price is unavailable
        try {
          const lighterPredicted = await this.lighterProvider.getPredictedFundingRate(marketIndex);
          const lighterMarkPrice = await this.lighterProvider.getMarkPrice(marketIndex);
          const lighterOI = await this.lighterProvider.getOpenInterest(marketIndex);

          rates.push({
            exchange: ExchangeType.LIGHTER,
            symbol,
            currentRate: lighterRate,
            predictedRate: lighterPredicted,
            markPrice: lighterMarkPrice,
            openInterest: lighterOI,
            timestamp: new Date(),
          });
        } catch (markPriceError: any) {
          // If mark price fails but we have funding rate, still add it (mark price might not be critical)
          // Only add if funding rate is non-zero (indicates active market)
          if (lighterRate !== 0) {
            rates.push({
              exchange: ExchangeType.LIGHTER,
              symbol,
              currentRate: lighterRate,
              predictedRate: lighterRate, // Use current as predicted if we can't get predicted
              markPrice: 0, // Will be skipped in execution if needed
              openInterest: 0,
              timestamp: new Date(),
            });
          }
          // If funding rate is 0 and mark price unavailable, skip silently
        }
      }
    } catch (error: any) {
      // Only log actual errors (not missing mappings)
      if (error.message && !error.message.includes('not found') && !error.message.includes('No funding rates')) {
        this.logger.error(`Failed to get Lighter funding rate for ${symbol}: ${error.message}`);
      }
    }

    // Get Hyperliquid funding rate
    // Use exchange-specific symbol format from mapping
    try {
      const mapping = this.getSymbolMapping(symbol);
      const hlSymbol = mapping?.hyperliquidSymbol;
      
      if (!hlSymbol) {
        // No mapping - skip silently
      } else {
        const hlRate = await this.hyperliquidProvider.getCurrentFundingRate(hlSymbol);
        const hlPredicted = await this.hyperliquidProvider.getPredictedFundingRate(hlSymbol);
        const hlMarkPrice = await this.hyperliquidProvider.getMarkPrice(hlSymbol);
        const hlOI = await this.hyperliquidProvider.getOpenInterest(hlSymbol);

        rates.push({
          exchange: ExchangeType.HYPERLIQUID,
          symbol,
          currentRate: hlRate,
          predictedRate: hlPredicted,
          markPrice: hlMarkPrice,
          openInterest: hlOI,
          timestamp: new Date(),
        });
      }
    } catch (error: any) {
      // Only log actual errors (not missing mappings)
      if (error.message && !error.message.includes('not found') && !error.message.includes('No funding rates')) {
        this.logger.error(`Failed to get Hyperliquid funding rate for ${symbol}: ${error.message}`);
      }
    }

    return rates;
  }

  /**
   * Compare funding rates across exchanges for a symbol
   */
  async compareFundingRates(symbol: string): Promise<FundingRateComparison> {
    const rates = await this.getFundingRates(symbol);

    if (rates.length === 0) {
      throw new Error(`No funding rates available for ${symbol}`);
    }

    const sortedRates = [...rates].sort((a, b) => b.currentRate - a.currentRate);
    const highestRate = sortedRates[0];
    const lowestRate = sortedRates[sortedRates.length - 1];
    const spread = highestRate.currentRate - lowestRate.currentRate;

    return {
      symbol,
      rates,
      highestRate,
      lowestRate,
      spread,
      timestamp: new Date(),
    };
  }

  /**
   * Find arbitrage opportunities across all exchanges
   * 
   * Strategy: Find exchanges where we can:
   * - Go LONG on exchange with highest positive funding rate (receive funding)
   * - Go SHORT on exchange with lowest (most negative) funding rate (receive funding)
   */
  async findArbitrageOpportunities(
    symbols: string[],
    minSpread: number = 0.0001, // Minimum spread to consider (0.01%)
    showProgress: boolean = true,
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    // Create progress bar if requested
    let progressBar: cliProgress.SingleBar | null = null;
    if (showProgress) {
      progressBar = new cliProgress.SingleBar({
        format: '🔍 Searching opportunities |{bar}| {percentage}% | {value}/{total} symbols | {opportunities} opportunities found',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      });
      progressBar.start(symbols.length, 0, { opportunities: 0 });
    }

    // Process symbols in parallel batches to avoid rate limits
    // Process 5 symbols at a time with a small delay between batches
    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 1000; // 1 second between batches

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.allSettled(
        batch.map(async (symbol) => {
          try {
            const comparison = await this.compareFundingRates(symbol);

            if (comparison.rates.length < 2) {
              return []; // Need at least 2 exchanges to arbitrage
            }

            const symbolOpportunities: ArbitrageOpportunity[] = [];

            // Find best long opportunity (most negative rate)
            // When funding rate is negative, longs RECEIVE funding (shorts pay longs)
            // So we want to go LONG where rate is most negative (we receive the most)
            const negativeRates = comparison.rates.filter((r) => r.currentRate < 0);
            const bestLong = negativeRates.length > 0
              ? negativeRates.reduce((best, current) => current.currentRate < best.currentRate ? current : best)
              : null;

            // Find best short opportunity (highest positive rate)
            // When funding rate is positive, shorts RECEIVE funding (longs pay shorts)
            // So we want to go SHORT where rate is most positive (we receive the most)
            const positiveRates = comparison.rates.filter((r) => r.currentRate > 0);
            const bestShort = positiveRates.length > 0 
              ? positiveRates.reduce((best, current) => current.currentRate > best.currentRate ? current : best)
              : null;

            // If we have both long and short opportunities, create arbitrage
            if (bestLong && bestShort && bestLong.exchange !== bestShort.exchange) {
              const spread = bestLong.currentRate - bestShort.currentRate;
              
              if (Math.abs(spread) >= minSpread) {
                // Calculate expected annualized return
                // Funding rates are typically hourly (e.g., 0.0013% per hour ≈ 10% annualized)
                const periodsPerDay = 24; // Hourly funding periods
                const periodsPerYear = periodsPerDay * 365;
                const expectedReturn = Math.abs(spread) * periodsPerYear;

                symbolOpportunities.push({
                  symbol,
                  longExchange: bestLong.exchange,
                  shortExchange: bestShort.exchange,
                  longRate: bestLong.currentRate,
                  shortRate: bestShort.currentRate,
                  spread: Math.abs(spread),
                  expectedReturn,
                  longMarkPrice: bestLong.markPrice > 0 ? bestLong.markPrice : undefined,
                  shortMarkPrice: bestShort.markPrice > 0 ? bestShort.markPrice : undefined,
                  timestamp: new Date(),
                });
              }
            }

            // Also check for simple spread arbitrage (long on lowest/most negative, short on highest/most positive)
            // Long on most negative rate (receive funding), Short on most positive rate (receive funding)
            if (comparison.highestRate && comparison.lowestRate && 
                comparison.highestRate.exchange !== comparison.lowestRate.exchange) {
              const spread = comparison.highestRate.currentRate - comparison.lowestRate.currentRate;
              
              if (spread >= minSpread) {
                // Funding rates are typically hourly
                const periodsPerDay = 24; // Hourly funding periods
                const periodsPerYear = periodsPerDay * 365;
                const expectedReturn = spread * periodsPerYear;

                const highestRate = comparison.highestRate; // Most positive (go SHORT here to receive)
                const lowestRate = comparison.lowestRate;  // Most negative (go LONG here to receive)
                const highestMarkPrice = highestRate.markPrice > 0 ? highestRate.markPrice : undefined;
                const lowestMarkPrice = lowestRate.markPrice > 0 ? lowestRate.markPrice : undefined;

                symbolOpportunities.push({
                  symbol,
                  longExchange: lowestRate.exchange,   // Long on most negative (receive funding)
                  shortExchange: highestRate.exchange, // Short on most positive (receive funding)
                  longRate: lowestRate.currentRate,
                  shortRate: highestRate.currentRate,
                  spread,
                  expectedReturn,
                  longMarkPrice: lowestMarkPrice,
                  shortMarkPrice: highestMarkPrice,
                  timestamp: new Date(),
                });
              }
            }

            return symbolOpportunities;
          } catch (error: any) {
            // Only log actual errors (not expected failures like missing data)
            if (error.message && !error.message.includes('No funding rates')) {
              this.logger.error(`Failed to find opportunities for ${symbol}: ${error.message}`);
            }
            return [];
          }
        })
      );

      // Collect results from batch
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          opportunities.push(...result.value);
        }
      }

      // Update progress bar
      if (progressBar) {
        const processed = Math.min(i + BATCH_SIZE, symbols.length);
        progressBar.update(processed, { opportunities: opportunities.length });
      }

      // Add delay between batches to avoid rate limits (except for last batch)
      if (i + BATCH_SIZE < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // Complete progress bar
    if (progressBar) {
      progressBar.update(symbols.length, { opportunities: opportunities.length });
      progressBar.stop();
    }

    // Sort by expected return (highest first)
    return opportunities.sort((a, b) => b.expectedReturn - a.expectedReturn);
  }
}

