import { ExchangeType } from '../value-objects/ExchangeConfig';

/**
 * Standardized funding rate data returned by all exchange providers
 */
export interface FundingRateData {
  exchange: ExchangeType;
  symbol: string; // Normalized symbol (e.g., "ETH")
  currentRate: number;
  predictedRate: number;
  markPrice: number;
  openInterest: number | undefined;
  volume24h: number | undefined;
  timestamp: Date;
}

/**
 * Request for funding data - uses normalized symbol
 */
export interface FundingDataRequest {
  normalizedSymbol: string; // Common symbol (e.g., "ETH")
  exchangeSymbol: string; // Exchange-specific symbol (e.g., "ETHUSDT" for Aster)
  marketIndex?: number; // For exchanges like Lighter that use numeric IDs
}

/**
 * Interface for funding data providers
 * Each exchange adapter should implement this interface
 * to provide standardized funding rate data
 */
export interface IFundingDataProvider {
  /**
   * Get the exchange type this provider handles
   */
  getExchangeType(): ExchangeType;

  /**
   * Get all funding data for a symbol in a single call
   * This is more efficient than calling individual methods
   * 
   * @param request - The funding data request with symbol info
   * @returns FundingRateData or null if symbol not supported/data unavailable
   */
  getFundingData(request: FundingDataRequest): Promise<FundingRateData | null>;

  /**
   * Check if this provider supports the given symbol
   */
  supportsSymbol(normalizedSymbol: string): boolean;

  /**
   * Get the exchange-specific symbol for a normalized symbol
   * Returns undefined if symbol not supported
   */
  getExchangeSymbol(normalizedSymbol: string): string | number | undefined;
}

