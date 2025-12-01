import { Test, TestingModule } from '@nestjs/testing';
import { FundingArbitrageStrategy } from './FundingArbitrageStrategy';
import { FundingRateAggregator, ArbitrageOpportunity } from './FundingRateAggregator';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';
import { PerpOrderRequest, OrderSide, OrderType } from '../value-objects/PerpOrder';

describe('FundingArbitrageStrategy', () => {
  let strategy: FundingArbitrageStrategy;
  let mockAggregator: jest.Mocked<FundingRateAggregator>;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;

  beforeEach(async () => {
    mockAggregator = {
      findArbitrageOpportunities: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FundingArbitrageStrategy,
        { provide: FundingRateAggregator, useValue: mockAggregator },
      ],
    }).compile();

    strategy = module.get<FundingArbitrageStrategy>(FundingArbitrageStrategy);

    // Create mock adapters
    mockAdapters = new Map();
    const asterAdapter = {
      getBalance: jest.fn().mockResolvedValue(50000), // Higher balance
      getMarkPrice: jest.fn().mockResolvedValue(3000),
      placeOrder: jest.fn(),
    } as any;

    const lighterAdapter = {
      getBalance: jest.fn().mockResolvedValue(50000), // Higher balance
      getMarkPrice: jest.fn().mockResolvedValue(3001),
      placeOrder: jest.fn(),
    } as any;

    mockAdapters.set(ExchangeType.ASTER, asterAdapter);
    mockAdapters.set(ExchangeType.LIGHTER, lighterAdapter);
  });

  describe('createExecutionPlan', () => {
    it('should create valid execution plan', async () => {
      const opportunity: ArbitrageOpportunity = {
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longRate: 0.0003,
        shortRate: 0.0001,
        spread: 0.0002,
        expectedReturn: 21.9, // Annualized - much higher return to ensure positive net return
        timestamp: new Date(),
      };

      const plan = await strategy.createExecutionPlan(opportunity, mockAdapters, 20000);

      expect(plan).not.toBeNull();
      expect(plan?.longOrder.side).toBe(OrderSide.LONG);
      expect(plan?.shortOrder.side).toBe(OrderSide.SHORT);
      expect(plan?.positionSize).toBeGreaterThan(0);
      expect(plan?.expectedNetReturn).toBeGreaterThan(0);
    });

    it('should return null if adapters are missing', async () => {
      const opportunity: ArbitrageOpportunity = {
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.ASTER,
        longRate: 0.0003,
        shortRate: 0.0001,
        spread: 0.0002,
        expectedReturn: 0.219,
        timestamp: new Date(),
      };

      const plan = await strategy.createExecutionPlan(opportunity, mockAdapters);

      expect(plan).toBeNull();
    });

    it('should return null if net return is negative', async () => {
      // Mock very high costs
      const opportunity: ArbitrageOpportunity = {
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longRate: 0.00001, // Very small spread
        shortRate: 0.00001,
        spread: 0.00001,
        expectedReturn: 0.001, // Very small return
        timestamp: new Date(),
      };

      const plan = await strategy.createExecutionPlan(opportunity, mockAdapters);

      // With very small spread, costs will exceed returns
      expect(plan).toBeNull();
    });
  });

  describe('executeStrategy', () => {
    it('should execute strategy successfully', async () => {
      const opportunities: ArbitrageOpportunity[] = [
        {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.LIGHTER,
          shortExchange: ExchangeType.ASTER,
          longRate: 0.0003,
          shortRate: 0.0001,
          spread: 0.0002,
          expectedReturn: 21.9, // Much higher return to ensure positive net return
          timestamp: new Date(),
        },
      ];

      mockAggregator.findArbitrageOpportunities.mockResolvedValue(opportunities);

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;

      asterAdapter.placeOrder.mockResolvedValue({
        orderId: 'order1',
        status: require('../value-objects/PerpOrder').OrderStatus.FILLED,
        symbol: 'ETHUSDT',
        side: OrderSide.SHORT,
        isSuccess: () => true,
        isFilled: () => true,
        isActive: () => false,
      } as any);

      lighterAdapter.placeOrder.mockResolvedValue({
        orderId: 'order2',
        status: require('../value-objects/PerpOrder').OrderStatus.FILLED,
        symbol: 'ETHUSDT',
        side: OrderSide.LONG,
        isSuccess: () => true,
        isFilled: () => true,
        isActive: () => false,
      } as any);

      const result = await strategy.executeStrategy(['ETHUSDT'], mockAdapters, undefined, 20000);

      expect(result.success).toBe(true);
      expect(result.opportunitiesEvaluated).toBe(1);
      expect(result.opportunitiesExecuted).toBe(1);
      expect(result.ordersPlaced).toBe(2);
    });

    it('should handle execution errors gracefully', async () => {
      const opportunities: ArbitrageOpportunity[] = [
        {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.LIGHTER,
          shortExchange: ExchangeType.ASTER,
          longRate: 0.0003,
          shortRate: 0.0001,
          spread: 0.0002,
          expectedReturn: 21.9, // Much higher return to ensure plan is created
          timestamp: new Date(),
        },
      ];

      mockAggregator.findArbitrageOpportunities.mockResolvedValue(opportunities);

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      
      // Make one adapter fail
      asterAdapter.placeOrder.mockRejectedValue(new Error('Order failed'));
      lighterAdapter.placeOrder.mockResolvedValue({
        orderId: 'order2',
        status: require('../value-objects/PerpOrder').OrderStatus.FILLED,
        symbol: 'ETHUSDT',
        side: OrderSide.LONG,
        isSuccess: () => true,
        isFilled: () => true,
        isActive: () => false,
      } as any);

      const result = await strategy.executeStrategy(['ETHUSDT'], mockAdapters, undefined, 20000);

      expect(result.success).toBe(true); // Strategy completes even with errors
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

