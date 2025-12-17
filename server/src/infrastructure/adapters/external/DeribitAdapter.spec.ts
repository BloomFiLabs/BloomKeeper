import { DeribitAdapter } from './DeribitAdapter';
import { Logger } from '@nestjs/common';

// Mock fetch globally
global.fetch = jest.fn();

describe('DeribitAdapter', () => {
  let adapter: DeribitAdapter;

  beforeEach(() => {
    adapter = new DeribitAdapter();
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(adapter).toBeDefined();
  });

  it('should fetch IV for BTC', async () => {
    const mockData = {
      result: {
        data: [
          [Date.now() - 86400000, 50, 55, 48, 52], // [timestamp, open, high, low, close]
          [Date.now(), 52, 54, 51, 53], // Latest candle with IV = 53%
        ],
      },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      json: async () => mockData,
    });

    const iv = await adapter.getImpliedVolatility('BTC');
    expect(iv).toBe(0.53); // 53% / 100
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        'deribit.com/api/v2/public/get_volatility_index_data',
      ),
    );
  });

  it('should fetch IV for ETH', async () => {
    const mockData = {
      result: {
        data: [[Date.now(), 60, 65, 58, 62]],
      },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      json: async () => mockData,
    });

    const iv = await adapter.getImpliedVolatility('ETH');
    expect(iv).toBe(0.62);
  });

  it('should map WBTC to BTC', async () => {
    const mockData = {
      result: {
        data: [[Date.now(), 50, 55, 48, 52]],
      },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      json: async () => mockData,
    });

    const iv = await adapter.getImpliedVolatility('WBTC');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('currency=BTC'),
    );
  });

  it('should throw error when no data available', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      json: async () => ({ result: { data: [] } }),
    });

    await expect(adapter.getImpliedVolatility('BTC')).rejects.toThrow(
      'No volatility data available',
    );
  });

  it('should handle API errors', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    await expect(adapter.getImpliedVolatility('BTC')).rejects.toThrow(
      'Network error',
    );
  });
});
