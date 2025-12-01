import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

/**
 * AsterFundingDataProvider - Fetches funding rate data from Aster DEX
 * 
 * Note: Aster DEX API structure may vary - this is a basic implementation
 * that may need adjustment based on actual API endpoints
 */
@Injectable()
export class AsterFundingDataProvider {
  private readonly logger = new Logger(AsterFundingDataProvider.name);
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    // Remove trailing slash if present (causes 403 errors)
    let baseUrl = this.configService.get<string>('ASTER_BASE_URL') || 'https://fapi.asterdex.com';
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
    });
  }

  /**
   * Get current funding rate for a symbol
   * @param symbol Trading symbol (e.g., 'ETHUSDT', 'BNBUSDT')
   * @returns Funding rate as decimal (e.g., 0.0001 = 0.01%)
   */
  async getCurrentFundingRate(symbol: string): Promise<number> {
    try {
      // Aster DEX funding rate endpoint (adjust based on actual API)
      const response = await this.client.get('/fapi/v1/premiumIndex', {
        params: { symbol },
      });

      // Aster may return funding rate in different format - adjust as needed
      const fundingRate = parseFloat(response.data.lastFundingRate || response.data.fundingRate || '0');
      
      return fundingRate;
    } catch (error: any) {
      this.logger.error(`Failed to get funding rate for ${symbol}: ${error.message}`);
      throw new Error(`Failed to get Aster funding rate: ${error.message}`);
    }
  }

  /**
   * Get predicted next funding rate
   * @param symbol Trading symbol
   * @returns Predicted funding rate as decimal
   */
  async getPredictedFundingRate(symbol: string): Promise<number> {
    try {
      // Use current funding rate as prediction (Aster may not provide prediction)
      return await this.getCurrentFundingRate(symbol);
    } catch (error: any) {
      this.logger.error(`Failed to get predicted funding rate for ${symbol}: ${error.message}`);
      throw new Error(`Failed to get Aster predicted funding rate: ${error.message}`);
    }
  }

  /**
   * Get open interest for a symbol
   * @param symbol Trading symbol
   * @returns Open interest in USD
   */
  async getOpenInterest(symbol: string): Promise<number> {
    try {
      const response = await this.client.get('/fapi/v1/openInterest', {
        params: { symbol },
      });

      const openInterest = parseFloat(response.data.openInterest || '0');
      const markPrice = parseFloat(response.data.markPrice || await this.getMarkPrice(symbol));
      
      return openInterest * markPrice; // Convert to USD value
    } catch (error: any) {
      this.logger.error(`Failed to get open interest for ${symbol}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get mark price for a symbol
   * @param symbol Trading symbol
   * @returns Mark price
   */
  async getMarkPrice(symbol: string): Promise<number> {
    try {
      const response = await this.client.get('/fapi/v1/ticker/price', {
        params: { symbol },
      });

      return parseFloat(response.data.price);
    } catch (error: any) {
      this.logger.error(`Failed to get mark price for ${symbol}: ${error.message}`);
      throw new Error(`Failed to get Aster mark price: ${error.message}`);
    }
  }

  /**
   * Get all available trading symbols from Aster
   * @returns Array of symbol strings (e.g., ['ETHUSDT', 'BTCUSDT'])
   */
  async getAvailableSymbols(): Promise<string[]> {
    try {
      const response = await this.client.get('/fapi/v1/exchangeInfo');
      
      if (!response.data || !response.data.symbols) {
        this.logger.warn('Aster exchangeInfo returned no symbols');
        return [];
      }

      // Filter for perpetual contracts (contractType: PERPETUAL)
      const symbols = response.data.symbols
        .filter((s: any) => s.contractType === 'PERPETUAL' && s.status === 'TRADING')
        .map((s: any) => s.symbol);

      this.logger.debug(`Found ${symbols.length} available perpetual symbols on Aster`);
      return symbols;
    } catch (error: any) {
      this.logger.error(`Failed to get available symbols from Aster: ${error.message}`);
      // Return empty array instead of throwing to allow system to continue
      return [];
    }
  }
}

