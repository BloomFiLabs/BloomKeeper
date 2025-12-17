import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AsterExchangeAdapter } from './AsterExchangeAdapter';
import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  OrderSide,
  OrderType,
} from '../../../domain/value-objects/PerpOrder';
import axios from 'axios';
import * as ethers from 'ethers';

jest.mock('axios');

// Mock ethers properly
jest.mock('ethers', () => {
  const actualEthers = jest.requireActual('ethers');
  const mockAbiCoder = {
    encode: jest.fn().mockReturnValue('0xencoded'),
  };
  const mockWallet = {
    address: '0x' + '1'.repeat(40),
    signingKey: {
      sign: jest.fn().mockReturnValue({
        r: '0x' + '1'.repeat(64),
        s: '0x' + '2'.repeat(64),
        v: 27,
      }),
    },
  };
  return {
    ...actualEthers,
    ethers: {
      ...actualEthers.ethers,
      Wallet: jest.fn().mockImplementation(() => mockWallet),
      AbiCoder: {
        defaultAbiCoder: jest.fn().mockReturnValue(mockAbiCoder),
      },
      keccak256: jest.fn().mockReturnValue('0x' + '3'.repeat(64)),
      getBytes: jest.fn().mockImplementation((x: string) => new Uint8Array(32)),
      toUtf8Bytes: jest
        .fn()
        .mockImplementation((x: string) => new Uint8Array(x.length)),
      concat: jest.fn().mockReturnValue(new Uint8Array(64)),
      Signature: {
        from: jest.fn().mockReturnValue({
          serialized: '0x' + '4'.repeat(130),
        }),
      },
    },
  };
});

describe('AsterExchangeAdapter', () => {
  let adapter: AsterExchangeAdapter;
  let mockConfigService: jest.Mocked<ConfigService>;
  const mockedAxios = axios as jest.Mocked<typeof axios>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          ASTER_BASE_URL: 'https://fapi.asterdex.com',
          ASTER_USER: '0x1111111111111111111111111111111111111111',
          ASTER_SIGNER: '0x2222222222222222222222222222222222222222',
          ASTER_PRIVATE_KEY:
            '0x1234567890123456789012345678901234567890123456789012345678901234',
        };
        return config[key];
      }),
    } as any;

    mockedAxios.create = jest.fn(() => ({
      get: jest.fn(),
      post: jest.fn(),
      delete: jest.fn(),
    })) as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AsterExchangeAdapter,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    adapter = module.get<AsterExchangeAdapter>(AsterExchangeAdapter);
  });

  describe('getConfig', () => {
    it('should return correct config', () => {
      const config = adapter.getConfig();
      expect(config.exchangeType).toBe(ExchangeType.ASTER);
      expect(config.baseUrl).toBe('https://fapi.asterdex.com');
    });
  });

  describe('getExchangeType', () => {
    it('should return ASTER', () => {
      expect(adapter.getExchangeType()).toBe(ExchangeType.ASTER);
    });
  });

  describe('getMarkPrice', () => {
    it('should fetch mark price', async () => {
      const mockClient = mockedAxios.create() as any;
      mockClient.get.mockResolvedValue({
        data: { price: '3000.50' },
      });

      // Mock the internal client
      (adapter as any).client = mockClient;

      const price = await adapter.getMarkPrice('ETHUSDT');
      expect(price).toBe(3000.5);
    });
  });

  describe('placeOrder', () => {
    it('should place market order', async () => {
      const mockClient = mockedAxios.create() as any;
      mockClient.get.mockResolvedValueOnce({
        data: { price: '3000' },
      });
      mockClient.post.mockResolvedValue({
        data: {
          orderId: '12345',
          status: 'FILLED',
          executedQty: '1.0',
          avgPrice: '3000.0',
        },
      });

      (adapter as any).client = mockClient;

      const request = new PerpOrderRequest(
        'ETHUSDT',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      const response = await adapter.placeOrder(request);

      expect(response.orderId).toBe('12345');
      expect(response.status).toBeDefined();
    });
  });

  describe('getPositions', () => {
    it('should fetch positions', async () => {
      const mockClient = mockedAxios.create() as any;
      mockClient.get.mockResolvedValue({
        data: [
          {
            symbol: 'ETHUSDT',
            positionAmt: '1.0',
            entryPrice: '3000',
            markPrice: '3100',
            unRealizedProfit: '100',
            leverage: '5',
            liquidationPrice: '2500',
            initialMargin: '500',
          },
        ],
      });

      (adapter as any).client = mockClient;

      const positions = await adapter.getPositions();

      expect(positions.length).toBeGreaterThan(0);
      expect(positions[0].symbol).toBe('ETHUSDT');
      expect(positions[0].size).toBe(1.0);
    });
  });
});
