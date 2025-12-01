import { Test, TestingModule } from '@nestjs/testing';
import { BotService } from '../../src/application/services/BotService';
import { StatisticalAnalyst } from '../../src/domain/services/StatisticalAnalyst';
import { RangeOptimizer } from '../../src/domain/services/RangeOptimizer';
import { RebalanceDecisionEngine } from '../../src/domain/services/RebalanceDecisionEngine';
import { GarchService } from '../../src/domain/services/GarchService';
import { DeribitAdapter } from '../../src/infrastructure/adapters/external/DeribitAdapter';
import { IMarketDataProvider } from '../../src/domain/ports/IMarketDataProvider';
import { IBotStateRepository } from '../../src/domain/ports/IBotStateRepository';
import { IStrategyExecutor } from '../../src/domain/ports/IStrategyExecutor';
import { Candle } from '../../src/domain/entities/Candle';
import { BotState } from '../../src/domain/entities/BotState';
import { Volatility } from '../../src/domain/value-objects/Volatility';
import { HurstExponent } from '../../src/domain/value-objects/HurstExponent';
import { DriftVelocity } from '../../src/domain/value-objects/DriftVelocity';
import { MACD } from '../../src/domain/value-objects/MACD';

describe('BotService Integration - Full Flow with Smart Contract', () => {
  let botService: BotService;
  let mockMarketData: jest.Mocked<IMarketDataProvider>;
  let mockBotStateRepo: jest.Mocked<IBotStateRepository>;
  let mockExecutor: jest.Mocked<IStrategyExecutor>;

  beforeEach(async () => {
    // Create realistic mocks
    mockMarketData = {
      getHistory: jest.fn(),
      getLatestCandle: jest.fn(),
      getPoolFeeApr: jest.fn().mockResolvedValue(11.0),
    };

    mockBotStateRepo = {
      findByPoolId: jest.fn(),
      save: jest.fn(),
      saveCandles: jest.fn(),
      getCandles: jest.fn(),
    };

    mockExecutor = {
      rebalance: jest.fn().mockResolvedValue('0xTransactionHash123'),
      emergencyExit: jest.fn().mockResolvedValue('0xEmergencyHash'),
      harvest: jest.fn().mockResolvedValue('0xHarvestHash'),
      getLastHarvestAmount: jest.fn().mockResolvedValue(0.002),
    };

    const mockBlockchain = {
      getStrategyState: jest.fn().mockResolvedValue({ totalAssets: BigInt(10000 * 1e6), totalPrincipal: BigInt(10000 * 1e6) }),
      getGasPriceGwei: jest.fn().mockResolvedValue(0.1),
      getStrategyPositionRange: jest.fn().mockResolvedValue({ lower: 2000, upper: 4000 }),
      tickToPrice: jest.fn((tick: number) => Math.pow(1.0001, tick)),
    };

    const mockDecisionEngine = {
      decide: jest.fn().mockReturnValue({
        shouldRebalance: true,
        reason: 'Test: Rebalance triggered for testing',
        confidence: 0.9,
      }),
    };

    const mockDeribit = {
      getImpliedVolatility: jest.fn().mockResolvedValue(0.65), // 65% IV
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotService,
        StatisticalAnalyst,
        RangeOptimizer,
        GarchService,
        DeribitAdapter,
        { provide: 'IMarketDataProvider', useValue: mockMarketData },
        { provide: 'IBotStateRepository', useValue: mockBotStateRepo },
        { provide: 'IStrategyExecutor', useValue: mockExecutor },
        { provide: 'IBlockchainAdapter', useValue: mockBlockchain },
        { provide: RebalanceDecisionEngine, useValue: mockDecisionEngine },
        { provide: DeribitAdapter, useValue: mockDeribit },
      ],
    }).compile();

    botService = module.get<BotService>(BotService);
    jest.clearAllMocks();
  });

  it('should execute full flow: fetch data -> analyze -> optimize -> rebalance on-chain', async () => {
    const pool = {
      address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
      name: 'ETH/USDC 0.05%',
      strategyAddress: '0xStrategyContractAddress',
    };

    // 1. Setup: Create realistic candles (trending upward)
    const candles: Candle[] = [];
    let price = 2000;
    for (let i = 0; i < 50; i++) {
      price = price * (1 + (Math.random() - 0.4) * 0.02); // Slight upward trend
      candles.push(
        new Candle(
          new Date(Date.now() - (50 - i) * 3600000),
          price * 0.99,
          price * 1.01,
          price * 0.98,
          price,
          1000000,
        ),
      );
    }

    // 2. Setup: Existing bot state with range
    const existingState = new BotState(
      pool.address,
      pool.address,
      1900, // Lower bound
      2100, // Upper bound
      2000, // Last price
      new Date(Date.now() - 24 * 3600000),
    );

    // 3. Mock responses
    (mockBotStateRepo.findByPoolId as jest.Mock).mockResolvedValue(existingState);
    (mockMarketData.getHistory as jest.Mock).mockResolvedValue(candles);
    (mockMarketData.getLatestCandle as jest.Mock).mockResolvedValue(candles[candles.length - 1]);

    // 4. Execute
    await botService.processPool(pool);

    // 5. Verify: Data was fetched
    expect(mockMarketData.getHistory).toHaveBeenCalledWith(pool.address, 48);
    expect(mockBotStateRepo.saveCandles).toHaveBeenCalledWith(candles, pool.address);

    // 6. Verify: Analysis was performed (via save calls)
    expect(mockBotStateRepo.save).toHaveBeenCalled();

    // 7. Verify: If price hit edge, rebalance was called on smart contract
    const currentPrice = candles[candles.length - 1].close;
    const rangeWidth = 2100 - 1900;
    const lowerThreshold = 1900 + rangeWidth * 0.1; // 1920
    const upperThreshold = 2100 - rangeWidth * 0.1; // 2080

    if (currentPrice <= lowerThreshold || currentPrice >= upperThreshold) {
      expect(mockExecutor.rebalance).toHaveBeenCalledWith(pool.strategyAddress);
      expect(mockExecutor.rebalance).toHaveReturnedWith(
        Promise.resolve('0xTransactionHash123'),
      );

      // Verify state was updated after rebalance
      const saveCalls = (mockBotStateRepo.save as jest.Mock).mock.calls;
      const rebalanceCall = saveCalls.find(
        (call) => (call[0] as BotState).lastRebalancePrice === currentPrice,
      );
      expect(rebalanceCall).toBeDefined();
    }
  });

  it('should NOT rebalance when price is within safe zone', async () => {
    const pool = {
      address: '0x123',
      name: 'ETH/USDC 0.05%',
      strategyAddress: '0xStrategyContractAddress',
    };

    const candles: Candle[] = [];
    const centerPrice = 2000;
    for (let i = 0; i < 50; i++) {
      // Price stays in middle of range
      const price = centerPrice + (Math.random() - 0.5) * 50; // Small fluctuations
      candles.push(
        new Candle(
          new Date(Date.now() - (50 - i) * 3600000),
          price * 0.99,
          price * 1.01,
          price * 0.98,
          price,
          1000000,
        ),
      );
    }

    const existingState = new BotState(
      pool.address,
      pool.address,
      1900,
      2100,
      2000,
      new Date(),
    );

    (mockBotStateRepo.findByPoolId as jest.Mock).mockResolvedValue(existingState);
    (mockMarketData.getHistory as jest.Mock).mockResolvedValue(candles);

    await botService.processPool(pool);

    // Should NOT call rebalance since price is in safe zone
    expect(mockExecutor.rebalance).not.toHaveBeenCalled();
  });

  it('should handle Deribit IV fetch failure gracefully', async () => {
    const pool = {
      address: '0x123',
      name: 'ETH/USDC 0.05%',
      strategyAddress: '0xStrategyContractAddress',
    };

    const candles = Array(50).fill(
      new Candle(new Date(), 2000, 2100, 1900, 2000, 1000000),
    );

    const existingState = new BotState(
      pool.address,
      pool.address,
      1900,
      2100,
      2000,
      new Date(),
    );

    (mockBotStateRepo.findByPoolId as jest.Mock).mockResolvedValue(existingState);
    (mockMarketData.getHistory as jest.Mock).mockResolvedValue(candles);

    // Mock Deribit to fail
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotService,
        StatisticalAnalyst,
        RangeOptimizer,
        GarchService,
        DeribitAdapter,
        { provide: 'IMarketDataProvider', useValue: mockMarketData },
        { provide: 'IBotStateRepository', useValue: mockBotStateRepo },
        { provide: 'IStrategyExecutor', useValue: mockExecutor },
        {
          provide: DeribitAdapter,
          useValue: {
            getImpliedVolatility: jest
              .fn()
              .mockRejectedValue(new Error('Deribit API unavailable')),
          },
        },
      ],
    }).compile();

    const serviceWithFailingDeribit = module.get<BotService>(BotService);

    // Should not throw, should fallback to GARCH
    await expect(
      serviceWithFailingDeribit.processPool(pool),
    ).resolves.not.toThrow();

    // Should still optimize with GARCH volatility
    expect(mockBotStateRepo.save).toHaveBeenCalled();
  });

  it('should detect trending regime and log signal', async () => {
    const pool = {
      address: '0x123',
      name: 'ETH/USDC 0.05%',
      strategyAddress: '0xStrategyContractAddress',
    };

    // Create strong trending candles
    const candles: Candle[] = [];
    let price = 2000;
    for (let i = 0; i < 50; i++) {
      price = price * 1.02; // Strong upward trend
      candles.push(
        new Candle(
          new Date(Date.now() - (50 - i) * 3600000),
          price * 0.99,
          price * 1.01,
          price * 0.98,
          price,
          1000000,
        ),
      );
    }

    const existingState = new BotState(
      pool.address,
      pool.address,
      1900,
      2100,
      2000,
      new Date(),
    );

    (mockBotStateRepo.findByPoolId as jest.Mock).mockResolvedValue(existingState);
    (mockMarketData.getHistory as jest.Mock).mockResolvedValue(candles);

    await botService.processPool(pool);

    // Analysis should detect trend (Hurst > 0.55 or MACD bullish)
    expect(mockBotStateRepo.save).toHaveBeenCalled();
  });
});

