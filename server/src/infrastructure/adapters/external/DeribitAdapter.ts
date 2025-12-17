import { Injectable, Logger } from '@nestjs/common';
import { IVolatilityDataProvider } from '../../../domain/ports/IVolatilityDataProvider';

@Injectable()
export class DeribitAdapter implements IVolatilityDataProvider {
  private readonly logger = new Logger(DeribitAdapter.name);
  private readonly BASE_URL = 'https://www.deribit.com/api/v2';

  async getImpliedVolatility(asset: string): Promise<number> {
    const currency = this.mapAssetToCurrency(asset);
    try {
      // Fetch the latest volatility index (DVOL) data
      // Using resolution '1D' to get the latest daily candle which represents the index value
      const end = Date.now();
      const start = end - 24 * 60 * 60 * 1000; // Last 24 hours

      const url = `${this.BASE_URL}/public/get_volatility_index_data?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=1D`;

      const response = await fetch(url);
      const data = await response.json();

      if (!data.result || !data.result.data || data.result.data.length === 0) {
        throw new Error(`No volatility data available for ${currency}`);
      }

      // data.result.data is an array of [timestamp, open, high, low, close]
      // We take the close of the latest candle as the current IV
      const latestCandle = data.result.data[data.result.data.length - 1];
      const closeIv = latestCandle[4]; // Index 4 is close

      // DVOL is usually scaled by 1 (e.g., 50.5 means 50.5%)
      // We convert it to decimal (0.505)
      return closeIv / 100;
    } catch (error) {
      this.logger.error(
        `Failed to fetch IV from Deribit for ${asset}: ${error.message}`,
      );
      throw error;
    }
  }

  private mapAssetToCurrency(asset: string): string {
    // Basic mapping, can be improved
    if (asset.toLowerCase().includes('btc')) return 'BTC';
    if (asset.toLowerCase().includes('eth')) return 'ETH';
    if (asset.toLowerCase().includes('sol')) return 'SOL';
    // Default to ETH or throw if strictly required
    return 'ETH';
  }
}
