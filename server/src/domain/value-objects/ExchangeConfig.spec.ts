import { ExchangeConfig, ExchangeType } from './ExchangeConfig';

describe('ExchangeConfig', () => {
  it('should create valid Aster config', () => {
    const config = new ExchangeConfig(
      ExchangeType.ASTER,
      'https://fapi.asterdex.com',
      undefined,
      undefined,
      '0x1234567890123456789012345678901234567890123456789012345678901234',
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    );

    expect(config.exchangeType).toBe(ExchangeType.ASTER);
    expect(config.isAster()).toBe(true);
    expect(config.isLighter()).toBe(false);
    expect(config.isHyperliquid()).toBe(false);
  });

  it('should create valid Lighter config', () => {
    const config = new ExchangeConfig(
      ExchangeType.LIGHTER,
      'https://mainnet.zklighter.elliot.ai',
      'api-key-123',
      undefined,
      undefined,
      undefined,
      undefined,
      1000,
      1,
    );

    expect(config.isLighter()).toBe(true);
    expect(config.accountIndex).toBe(1000);
    expect(config.apiKeyIndex).toBe(1);
  });

  it('should create valid Hyperliquid config', () => {
    const config = new ExchangeConfig(
      ExchangeType.HYPERLIQUID,
      'https://api.hyperliquid.xyz',
      undefined,
      undefined,
      '0x1234567890123456789012345678901234567890123456789012345678901234',
    );

    expect(config.isHyperliquid()).toBe(true);
  });

  it('should throw error for Aster without required fields', () => {
    expect(() => {
      new ExchangeConfig(ExchangeType.ASTER, 'https://fapi.asterdex.com');
    }).toThrow(
      'Aster exchange requires userAddress, signerAddress, and privateKey',
    );
  });

  it('should throw error for Lighter without apiKey', () => {
    expect(() => {
      new ExchangeConfig(
        ExchangeType.LIGHTER,
        'https://mainnet.zklighter.elliot.ai',
      );
    }).toThrow('Lighter exchange requires apiKey');
  });

  it('should throw error for Hyperliquid without privateKey', () => {
    expect(() => {
      new ExchangeConfig(
        ExchangeType.HYPERLIQUID,
        'https://api.hyperliquid.xyz',
      );
    }).toThrow('Hyperliquid exchange requires privateKey');
  });

  it('should return default timeout', () => {
    const config = new ExchangeConfig(
      ExchangeType.HYPERLIQUID,
      'https://api.hyperliquid.xyz',
      undefined,
      undefined,
      '0x1234567890123456789012345678901234567890123456789012345678901234',
    );

    expect(config.getTimeout()).toBe(30000);
  });

  it('should return custom timeout', () => {
    const config = new ExchangeConfig(
      ExchangeType.HYPERLIQUID,
      'https://api.hyperliquid.xyz',
      undefined,
      undefined,
      '0x1234567890123456789012345678901234567890123456789012345678901234',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      60000,
    );

    expect(config.getTimeout()).toBe(60000);
  });
});
