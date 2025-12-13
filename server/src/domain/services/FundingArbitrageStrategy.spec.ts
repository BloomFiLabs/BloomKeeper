import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FundingArbitrageStrategy } from './FundingArbitrageStrategy';
import {
  FundingRateAggregator,
  ArbitrageOpportunity,
} from './FundingRateAggregator';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';
import {
  PerpOrderRequest,
  OrderSide,
  OrderType,
} from '../value-objects/PerpOrder';
import { StrategyConfig } from '../value-objects/StrategyConfig';
import { Percentage } from '../value-objects/Percentage';

// Import the strategy rule modules
import { PortfolioOptimizer } from './strategy-rules/PortfolioOptimizer';
import { OrderExecutor } from './strategy-rules/OrderExecutor';
import { PositionManager } from './strategy-rules/PositionManager';
import { BalanceManager } from './strategy-rules/BalanceManager';
import { OpportunityEvaluator } from './strategy-rules/OpportunityEvaluator';
import { ExecutionPlanBuilder } from './strategy-rules/ExecutionPlanBuilder';
import { CostCalculator } from './strategy-rules/CostCalculator';

describe('FundingArbitrageStrategy', () => {
  let strategy: FundingArbitrageStrategy;
  let mockAggregator: jest.Mocked<FundingRateAggregator>;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;

  // Create a minimal mock implementation
  const createMockStrategy = () => {
    // Create minimal mocks for all dependencies
    mockAggregator = {
      findArbitrageOpportunities: jest.fn(),
      getExchangeSymbol: jest.fn((symbol: string) => symbol),
      getFundingRates: jest.fn().mockResolvedValue([]),
      compareFundingRates: jest.fn(),
    } as any;

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'KEEPER_LEVERAGE') return '2';
        return undefined;
      }),
    };

    const mockHistoricalService = {
      getHistoricalMetrics: jest.fn().mockReturnValue(null),
      getWeightedAverageRate: jest.fn().mockImplementation((symbol, exchange, rate) => rate),
      getSpreadVolatilityMetrics: jest.fn().mockReturnValue(null),
    } as any;

    const mockLossTracker = {
      recordPositionEntry: jest.fn(),
      recordPositionExit: jest.fn(),
      getRemainingBreakEvenHours: jest.fn().mockReturnValue({
        remainingBreakEvenHours: 0,
        remainingCost: 0,
        hoursHeld: 0,
      }),
    } as any;

    const mockPortfolioRiskAnalyzer = {
      analyzePortfolio: jest.fn(),
      calculatePortfolioRiskMetrics: jest.fn().mockResolvedValue({}),
    } as any;

    const mockPortfolioOptimizer = {
      calculateMaxPortfolioFor35APY: jest.fn().mockResolvedValue({ maxPortfolio: 10000, breakEvenHours: 1 }),
      calculateOptimalPortfolioAllocation: jest.fn().mockResolvedValue([]),
    } as any;

    const mockOrderExecutor = {
      executeMultiplePositions: jest.fn().mockResolvedValue({ isSuccess: () => true, value: { successfulExecutions: 0, totalOrders: 0, totalExpectedReturn: 0 } }),
      executeSinglePosition: jest.fn().mockResolvedValue({ isSuccess: () => true, value: {} }),
    } as any;

    const mockPositionManager = {
      getAllPositions: jest.fn().mockResolvedValue({ isSuccess: () => true, value: [] }),
      closeAllPositions: jest.fn().mockResolvedValue({ isSuccess: () => true, value: { closed: [], stillOpen: [] } }),
      detectSingleLegPositions: jest.fn().mockReturnValue([]),
      handleAsymmetricFills: jest.fn().mockResolvedValue({ isSuccess: () => true }),
    } as any;

    const mockBalanceManager = {
      getWalletUsdcBalance: jest.fn().mockResolvedValue({ isSuccess: () => true, value: 0 }),
      attemptRebalanceForOpportunity: jest.fn().mockResolvedValue({ isSuccess: () => true, value: false }),
      checkAndDepositWalletFunds: jest.fn().mockResolvedValue({ isSuccess: () => true }),
    } as any;

    const mockOpportunityEvaluator = {
      evaluateOpportunityWithHistory: jest.fn().mockReturnValue({ isSuccess: () => true, value: { breakEvenHours: 1, historicalMetrics: { long: null, short: null }, worstCaseBreakEvenHours: 1, consistencyScore: 0.5 } }),
      shouldRebalance: jest.fn().mockResolvedValue({ isSuccess: () => true, value: { shouldRebalance: false, reason: 'test' } }),
      evaluateCurrentPositionPerformance: jest.fn().mockResolvedValue({ isSuccess: () => true, value: {} }),
    } as any;

    const mockExecutionPlanBuilder = {
      buildPlan: jest.fn().mockResolvedValue({ isSuccess: () => true, value: null }),
    } as any;

    const mockCostCalculator = {
      calculateTotalCosts: jest.fn().mockReturnValue(0),
      calculateSlippageCost: jest.fn().mockReturnValue(0),
      predictFundingRateImpact: jest.fn().mockReturnValue(0),
    } as any;

    const strategyConfig = StrategyConfig.withDefaults(2.0);

    // Create the strategy directly without NestJS DI
    return new FundingArbitrageStrategy(
      mockAggregator,
      mockConfigService as any,
      mockHistoricalService,
      mockLossTracker,
      mockPortfolioRiskAnalyzer,
      mockPortfolioOptimizer,
      mockOrderExecutor,
      mockPositionManager,
      mockBalanceManager,
      mockOpportunityEvaluator,
      mockExecutionPlanBuilder,
      mockCostCalculator,
      strategyConfig,
      undefined, // performanceLogger
      undefined, // balanceRebalancer
      undefined, // eventBus
      undefined, // idleFundsManager
    );
  };

  beforeEach(() => {
    strategy = createMockStrategy();

    // Create mock adapters
    mockAdapters = new Map();
    const asterAdapter = {
      getBalance: jest.fn().mockResolvedValue(50000),
      getMarkPrice: jest.fn().mockResolvedValue(3000),
      getPositions: jest.fn().mockResolvedValue([]),
      getBestBidAsk: jest.fn().mockResolvedValue({
        bestBid: 2999,
        bestAsk: 3001,
      }),
      placeOrder: jest.fn(),
    } as any;

    const lighterAdapter = {
      getBalance: jest.fn().mockResolvedValue(50000),
      getMarkPrice: jest.fn().mockResolvedValue(3001),
      getPositions: jest.fn().mockResolvedValue([]),
      getBestBidAsk: jest.fn().mockResolvedValue({
        bestBid: 3000,
        bestAsk: 3002,
      }),
      placeOrder: jest.fn(),
    } as any;

    const hyperliquidAdapter = {
      getBalance: jest.fn().mockResolvedValue(50000),
      getMarkPrice: jest.fn().mockResolvedValue(3000),
      getPositions: jest.fn().mockResolvedValue([]),
      getBestBidAsk: jest.fn().mockResolvedValue({
        bestBid: 2999,
        bestAsk: 3001,
      }),
      placeOrder: jest.fn(),
    } as any;

    mockAdapters.set(ExchangeType.ASTER, asterAdapter);
    mockAdapters.set(ExchangeType.LIGHTER, lighterAdapter);
    mockAdapters.set(ExchangeType.HYPERLIQUID, hyperliquidAdapter);
  });

  describe('Position Stickiness', () => {
    describe('recordPositionOpenTime / removePositionOpenTime / getPositionAgeHours', () => {
      it('should record and retrieve position open time', () => {
        // Record a position open time
        strategy.recordPositionOpenTime('ETH', ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER);
        
        // Get the age - should be very small (just opened)
        const ageHours = strategy.getPositionAgeHours('ETH', ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER);
        
        expect(ageHours).not.toBeNull();
        expect(ageHours).toBeGreaterThanOrEqual(0);
        expect(ageHours).toBeLessThan(0.01); // Less than ~36 seconds
      });

      it('should return null for untracked positions', () => {
        const ageHours = strategy.getPositionAgeHours('BTC', ExchangeType.ASTER, ExchangeType.LIGHTER);
        
        // Untracked positions return null (assumed old enough)
        expect(ageHours).toBeNull();
      });

      it('should remove position open time tracking', () => {
        // Record then remove
        strategy.recordPositionOpenTime('SOL', ExchangeType.HYPERLIQUID, ExchangeType.ASTER);
        strategy.removePositionOpenTime('SOL', ExchangeType.HYPERLIQUID, ExchangeType.ASTER);
        
        // Should return null after removal
        const ageHours = strategy.getPositionAgeHours('SOL', ExchangeType.HYPERLIQUID, ExchangeType.ASTER);
        expect(ageHours).toBeNull();
      });

      it('should track multiple positions independently', () => {
        strategy.recordPositionOpenTime('ETH', ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER);
        strategy.recordPositionOpenTime('BTC', ExchangeType.ASTER, ExchangeType.LIGHTER);
        
        // Both should be tracked
        expect(strategy.getPositionAgeHours('ETH', ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER)).not.toBeNull();
        expect(strategy.getPositionAgeHours('BTC', ExchangeType.ASTER, ExchangeType.LIGHTER)).not.toBeNull();
        
        // Remove one
        strategy.removePositionOpenTime('ETH', ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER);
        
        // ETH should be null, BTC should still be tracked
        expect(strategy.getPositionAgeHours('ETH', ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER)).toBeNull();
        expect(strategy.getPositionAgeHours('BTC', ExchangeType.ASTER, ExchangeType.LIGHTER)).not.toBeNull();
      });
    });

    describe('getCurrentSpreadForPosition', () => {
      it('should calculate positive spread correctly', async () => {
        // Mock the aggregator to return specific funding rates
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: 0.0003 },  // High rate on short side
          { exchange: ExchangeType.ASTER, currentRate: 0.0001 },    // Low rate on long side
        ]);

        const spread = await strategy.getCurrentSpreadForPosition(
          'ETH',
          ExchangeType.ASTER,    // Long exchange (low rate = we pay less)
          ExchangeType.LIGHTER,  // Short exchange (high rate = we receive more)
        );

        // Spread = shortRate - longRate = 0.0003 - 0.0001 = 0.0002
        expect(spread).toBeCloseTo(0.0002, 6);
      });

      it('should calculate negative spread correctly', async () => {
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: 0.0001 },  // Low rate on short side
          { exchange: ExchangeType.ASTER, currentRate: 0.0003 },    // High rate on long side
        ]);

        const spread = await strategy.getCurrentSpreadForPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
        );

        // Spread = shortRate - longRate = 0.0001 - 0.0003 = -0.0002 (losing money)
        expect(spread).toBeCloseTo(-0.0002, 6);
      });

      it('should return null when funding rates are unavailable', async () => {
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([]);

        const spread = await strategy.getCurrentSpreadForPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
        );

        expect(spread).toBeNull();
      });

      it('should return null when one exchange rate is missing', async () => {
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: 0.0003 },
          // ASTER rate missing
        ]);

        const spread = await strategy.getCurrentSpreadForPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
        );

        expect(spread).toBeNull();
      });

      it('should handle API errors gracefully', async () => {
        mockAggregator.getFundingRates = jest.fn().mockRejectedValue(new Error('API Error'));

        const spread = await strategy.getCurrentSpreadForPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
        );

        expect(spread).toBeNull();
      });
    });

    describe('shouldKeepPosition', () => {
      beforeEach(() => {
        // Default mock: return positive spread
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: 0.0003 },
          { exchange: ExchangeType.ASTER, currentRate: 0.0001 },
        ]);
      });

      it('should keep position with positive spread above threshold', async () => {
        const result = await strategy.shouldKeepPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
          null, // No better opportunity
        );

        expect(result.shouldKeep).toBe(true);
        expect(result.reason).toContain('keeping');
      });

      it('should close position with severely negative spread', async () => {
        // Mock severely negative spread (< -0.02% = closeThreshold * 2)
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: -0.0005 },  // Negative on short
          { exchange: ExchangeType.ASTER, currentRate: 0.0002 },     // Positive on long
        ]);

        const result = await strategy.shouldKeepPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
          null,
        );

        // Spread = -0.0005 - 0.0002 = -0.0007 (severely negative)
        expect(result.shouldKeep).toBe(false);
        expect(result.reason).toContain('severely negative');
      });

      it('should keep young position with positive spread', async () => {
        // Record position as just opened
        strategy.recordPositionOpenTime('ETH', ExchangeType.ASTER, ExchangeType.LIGHTER);

        const result = await strategy.shouldKeepPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
          0.0005, // Better opportunity exists
        );

        // Young position with positive spread should be kept
        expect(result.shouldKeep).toBe(true);
        expect(result.reason).toContain('young');

        // Cleanup
        strategy.removePositionOpenTime('ETH', ExchangeType.ASTER, ExchangeType.LIGHTER);
      });

      it('should keep position when unable to get current spread (conservative)', async () => {
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([]);

        const result = await strategy.shouldKeepPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
          null,
        );

        expect(result.shouldKeep).toBe(true);
        expect(result.reason).toContain('Cannot determine');
        expect(result.reason).toContain('conservative');
      });

      it('should close position at or below close threshold', async () => {
        // Mock spread exactly at threshold (-0.0001)
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: 0.0001 },
          { exchange: ExchangeType.ASTER, currentRate: 0.0002 },
        ]);

        const result = await strategy.shouldKeepPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
          null,
        );

        // Spread = 0.0001 - 0.0002 = -0.0001 (at threshold)
        expect(result.shouldKeep).toBe(false);
        expect(result.reason).toContain('close threshold');
      });

      it('should replace position when new opportunity is significantly better', async () => {
        // Current spread is positive but modest
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: 0.00015 },
          { exchange: ExchangeType.ASTER, currentRate: 0.0001 },
        ]);
        // Current spread = 0.00015 - 0.0001 = 0.00005 (0.005%)

        // For Aster/Lighter: churn cost = 2 * (takerFee_Aster + takerFee_Lighter) = 2 * (0.0004 + 0) = 0.0008
        // Required improvement = 0.0008 * 2 (multiplier) = 0.0016
        // New spread must be > 0.00005 + 0.0016 = 0.00165 to trigger replacement
        const result = await strategy.shouldKeepPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
          0.003, // Much better opportunity (0.3%)
        );

        // Since current spread is 0.00005 and new is 0.003, improvement is 0.00295
        // 0.00295 > 0.0016, so should replace
        expect(result.shouldKeep).toBe(false);
        expect(result.reason).toContain('replacing');
      });

      it('should keep position when new opportunity is not significantly better', async () => {
        // Current spread is positive
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: 0.0003 },
          { exchange: ExchangeType.ASTER, currentRate: 0.0001 },
        ]);
        // Current spread = 0.0002 (0.02%)

        // New opportunity with only slightly better spread
        const result = await strategy.shouldKeepPosition(
          'ETH',
          ExchangeType.ASTER,
          ExchangeType.LIGHTER,
          0.00025, // Only 0.00005 better (not worth churn cost of 0.0016)
        );

        expect(result.shouldKeep).toBe(true);
        expect(result.reason).toContain('keeping');
      });
    });

    describe('filterPositionsToCloseWithStickiness', () => {
      const createMockPosition = (
        symbol: string,
        exchange: ExchangeType,
        side: OrderSide,
      ): any => ({
        symbol,
        exchangeType: exchange,
        side,
        size: 1,
        entryPrice: 3000,
        markPrice: 3000,
        unrealizedPnl: 0,
        getPositionValue: () => 3000,
      });

      it('should keep positions with positive spread', async () => {
        // Mock positive spread
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: 0.0003 },
          { exchange: ExchangeType.ASTER, currentRate: 0.0001 },
        ]);

        const positionsToClose = [
          createMockPosition('ETH', ExchangeType.ASTER, OrderSide.LONG),
          createMockPosition('ETH', ExchangeType.LIGHTER, OrderSide.SHORT),
        ];

        const existingPositionsBySymbol = new Map([
          ['ETH', {
            long: createMockPosition('ETH', ExchangeType.ASTER, OrderSide.LONG),
            short: createMockPosition('ETH', ExchangeType.LIGHTER, OrderSide.SHORT),
            currentValue: 6000,
            currentCollateral: 3000,
          }],
        ]);

        const result = await strategy.filterPositionsToCloseWithStickiness(
          positionsToClose,
          existingPositionsBySymbol,
          null, // No better opportunity
        );

        expect(result.toKeep.length).toBe(2); // Both legs kept
        expect(result.toClose.length).toBe(0);
      });

      it('should close positions with negative spread', async () => {
        // Mock negative spread
        mockAggregator.getFundingRates = jest.fn().mockResolvedValue([
          { exchange: ExchangeType.LIGHTER, currentRate: -0.0003 },
          { exchange: ExchangeType.ASTER, currentRate: 0.0001 },
        ]);

        const positionsToClose = [
          createMockPosition('ETH', ExchangeType.ASTER, OrderSide.LONG),
          createMockPosition('ETH', ExchangeType.LIGHTER, OrderSide.SHORT),
        ];

        const existingPositionsBySymbol = new Map([
          ['ETH', {
            long: createMockPosition('ETH', ExchangeType.ASTER, OrderSide.LONG),
            short: createMockPosition('ETH', ExchangeType.LIGHTER, OrderSide.SHORT),
            currentValue: 6000,
            currentCollateral: 3000,
          }],
        ]);

        const result = await strategy.filterPositionsToCloseWithStickiness(
          positionsToClose,
          existingPositionsBySymbol,
          null,
        );

        // Spread = -0.0003 - 0.0001 = -0.0004 (severely negative)
        expect(result.toClose.length).toBe(2); // Both legs closed
        expect(result.toKeep.length).toBe(0);
      });

      it('should handle single-leg positions (pass through)', async () => {
        const positionsToClose = [
          createMockPosition('ETH', ExchangeType.ASTER, OrderSide.LONG),
          // Missing SHORT leg
        ];

        const existingPositionsBySymbol = new Map([
          ['ETH', {
            long: createMockPosition('ETH', ExchangeType.ASTER, OrderSide.LONG),
            // short is undefined
            currentValue: 3000,
            currentCollateral: 1500,
          }],
        ]);

        const result = await strategy.filterPositionsToCloseWithStickiness(
          positionsToClose,
          existingPositionsBySymbol,
          null,
        );

        // Single-leg positions should pass through to close (handled separately)
        expect(result.toClose.length).toBe(1);
        expect(result.reasons.get('ETH')).toContain('Single-leg');
      });

      it('should process multiple symbols independently', async () => {
        // ETH has positive spread, BTC has negative spread
        mockAggregator.getFundingRates = jest.fn().mockImplementation((symbol) => {
          if (symbol === 'ETH') {
            return Promise.resolve([
              { exchange: ExchangeType.LIGHTER, currentRate: 0.0003 },
              { exchange: ExchangeType.ASTER, currentRate: 0.0001 },
            ]);
          } else {
            return Promise.resolve([
              { exchange: ExchangeType.LIGHTER, currentRate: -0.0003 },
              { exchange: ExchangeType.ASTER, currentRate: 0.0001 },
            ]);
          }
        });

        const positionsToClose = [
          createMockPosition('ETH', ExchangeType.ASTER, OrderSide.LONG),
          createMockPosition('ETH', ExchangeType.LIGHTER, OrderSide.SHORT),
          createMockPosition('BTC', ExchangeType.ASTER, OrderSide.LONG),
          createMockPosition('BTC', ExchangeType.LIGHTER, OrderSide.SHORT),
        ];

        const existingPositionsBySymbol = new Map([
          ['ETH', {
            long: createMockPosition('ETH', ExchangeType.ASTER, OrderSide.LONG),
            short: createMockPosition('ETH', ExchangeType.LIGHTER, OrderSide.SHORT),
            currentValue: 6000,
            currentCollateral: 3000,
          }],
          ['BTC', {
            long: createMockPosition('BTC', ExchangeType.ASTER, OrderSide.LONG),
            short: createMockPosition('BTC', ExchangeType.LIGHTER, OrderSide.SHORT),
            currentValue: 60000,
            currentCollateral: 30000,
          }],
        ]);

        const result = await strategy.filterPositionsToCloseWithStickiness(
          positionsToClose,
          existingPositionsBySymbol,
          null,
        );

        // ETH should be kept (positive spread), BTC should be closed (negative spread)
        expect(result.toKeep.length).toBe(2); // Both ETH legs
        expect(result.toClose.length).toBe(2); // Both BTC legs
      });
    });
  });
});
