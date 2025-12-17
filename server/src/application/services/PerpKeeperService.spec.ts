import { Test, TestingModule } from '@nestjs/testing';
import { PerpKeeperService } from './PerpKeeperService';
import { AsterExchangeAdapter } from '../../infrastructure/adapters/aster/AsterExchangeAdapter';
import { LighterExchangeAdapter } from '../../infrastructure/adapters/lighter/LighterExchangeAdapter';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  OrderSide,
  OrderType,
  OrderStatus,
} from '../../domain/value-objects/PerpOrder';

// Mock Hyperliquid adapter to avoid ESM import issues
jest.mock(
  '../../infrastructure/adapters/hyperliquid/HyperliquidExchangeAdapter',
  () => {
    const mockHyperliquidClass = jest.fn().mockImplementation(() => ({
      getConfig: jest.fn(),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.HYPERLIQUID),
      placeOrder: jest.fn(),
      getPosition: jest.fn(),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn(),
      cancelAllOrders: jest.fn(),
      getOrderStatus: jest.fn(),
      getMarkPrice: jest.fn(),
      getBalance: jest.fn(),
      getEquity: jest.fn(),
      isReady: jest.fn().mockResolvedValue(true),
      testConnection: jest.fn().mockResolvedValue(undefined),
    }));
    return {
      HyperliquidExchangeAdapter: mockHyperliquidClass,
    };
  },
);

const {
  HyperliquidExchangeAdapter,
} = require('../../infrastructure/adapters/hyperliquid/HyperliquidExchangeAdapter');

describe('PerpKeeperService', () => {
  let service: PerpKeeperService;
  let mockAsterAdapter: jest.Mocked<AsterExchangeAdapter>;
  let mockLighterAdapter: jest.Mocked<LighterExchangeAdapter>;
  let mockHyperliquidAdapter: any;

  beforeEach(async () => {
    mockAsterAdapter = {
      getConfig: jest.fn(),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.ASTER),
      placeOrder: jest.fn(),
      getPosition: jest.fn(),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn(),
      cancelAllOrders: jest.fn(),
      getOrderStatus: jest.fn(),
      getMarkPrice: jest.fn(),
      getBalance: jest.fn(),
      getEquity: jest.fn(),
      isReady: jest.fn().mockResolvedValue(true),
      testConnection: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockLighterAdapter = {
      getConfig: jest.fn(),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.LIGHTER),
      placeOrder: jest.fn(),
      getPosition: jest.fn(),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn(),
      cancelAllOrders: jest.fn(),
      getOrderStatus: jest.fn(),
      getMarkPrice: jest.fn(),
      getBalance: jest.fn(),
      getEquity: jest.fn(),
      isReady: jest.fn().mockResolvedValue(true),
      testConnection: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockHyperliquidAdapter = new HyperliquidExchangeAdapter();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PerpKeeperService,
        { provide: AsterExchangeAdapter, useValue: mockAsterAdapter },
        { provide: LighterExchangeAdapter, useValue: mockLighterAdapter },
        {
          provide: HyperliquidExchangeAdapter,
          useValue: mockHyperliquidAdapter,
        },
      ],
    }).compile();

    service = module.get<PerpKeeperService>(PerpKeeperService);
  });

  describe('getExchangeAdapter', () => {
    it('should return adapter for valid exchange type', () => {
      const adapter = service.getExchangeAdapter(ExchangeType.ASTER);
      expect(adapter).toBe(mockAsterAdapter);
    });

    it('should throw error for invalid exchange type', () => {
      expect(() => {
        service.getExchangeAdapter('INVALID' as ExchangeType);
      }).toThrow('Exchange adapter not found');
    });
  });

  describe('placeOrder', () => {
    it('should place order on specified exchange', async () => {
      const request = new PerpOrderRequest(
        'ETHUSDT',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      mockAsterAdapter.placeOrder.mockResolvedValue({
        orderId: 'order123',
        status: OrderStatus.SUBMITTED,
        symbol: 'ETHUSDT',
        side: OrderSide.LONG,
        isSuccess: () => true,
      } as any);

      const response = await service.placeOrder(ExchangeType.ASTER, request);

      expect(response.orderId).toBe('order123');
      expect(mockAsterAdapter.placeOrder).toHaveBeenCalledWith(request);
    });
  });

  describe('getAllPositions', () => {
    it('should aggregate positions from all exchanges', async () => {
      mockAsterAdapter.getPositions.mockResolvedValue([]);
      mockLighterAdapter.getPositions.mockResolvedValue([]);
      mockHyperliquidAdapter.getPositions.mockResolvedValue([]);

      const positions = await service.getAllPositions();

      expect(Array.isArray(positions)).toBe(true);
      expect(mockAsterAdapter.getPositions).toHaveBeenCalled();
      expect(mockLighterAdapter.getPositions).toHaveBeenCalled();
      expect(mockHyperliquidAdapter.getPositions).toHaveBeenCalled();
    });
  });

  describe('areExchangesReady', () => {
    it('should return true when all exchanges are ready', async () => {
      const ready = await service.areExchangesReady();
      expect(ready).toBe(true);
    });

    it('should return false when any exchange is not ready', async () => {
      mockAsterAdapter.isReady.mockResolvedValue(false);

      const ready = await service.areExchangesReady();
      expect(ready).toBe(false);
    });
  });

  describe('testAllConnections', () => {
    it('should test all connections successfully', async () => {
      await expect(service.testAllConnections()).resolves.not.toThrow();
    });

    it('should throw error if any connection fails', async () => {
      mockAsterAdapter.testConnection.mockRejectedValue(
        new Error('Connection failed'),
      );

      await expect(service.testAllConnections()).rejects.toThrow();
    });
  });
});
