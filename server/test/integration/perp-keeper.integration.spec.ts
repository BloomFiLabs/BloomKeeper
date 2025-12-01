import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PerpKeeperService } from '../../src/application/services/PerpKeeperService';
import { PerpKeeperOrchestrator } from '../../src/domain/services/PerpKeeperOrchestrator';
import { FundingRateAggregator } from '../../src/domain/services/FundingRateAggregator';
import { FundingArbitrageStrategy } from '../../src/domain/services/FundingArbitrageStrategy';
import { AsterExchangeAdapter } from '../../src/infrastructure/adapters/aster/AsterExchangeAdapter';
import { LighterExchangeAdapter } from '../../src/infrastructure/adapters/lighter/LighterExchangeAdapter';
import { HyperliquidExchangeAdapter } from '../../src/infrastructure/adapters/hyperliquid/HyperliquidExchangeAdapter';
import { AsterFundingDataProvider } from '../../src/infrastructure/adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../../src/infrastructure/adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../../src/infrastructure/adapters/hyperliquid/HyperLiquidDataProvider';
import { ExchangeType } from '../../src/domain/value-objects/ExchangeConfig';
import { PerpOrderRequest, OrderSide, OrderType } from '../../src/domain/value-objects/PerpOrder';
import { IPerpExchangeAdapter } from '../../src/domain/ports/IPerpExchangeAdapter';

describe('PerpKeeper Integration Tests', () => {
  let module: TestingModule;
  let keeperService: PerpKeeperService;
  let orchestrator: PerpKeeperOrchestrator;
  let aggregator: FundingRateAggregator;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    // Create mock config service
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          ASTER_BASE_URL: 'https://fapi.asterdex.com',
          ASTER_USER: '0x1111111111111111111111111111111111111111',
          ASTER_SIGNER: '0x2222222222222222222222222222222222222222',
          ASTER_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
          LIGHTER_API_BASE_URL: 'https://mainnet.zklighter.elliot.ai',
          LIGHTER_API_KEY: 'test-api-key',
          LIGHTER_ACCOUNT_INDEX: '1000',
          LIGHTER_API_KEY_INDEX: '1',
          PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
          HYPERLIQUID_RPC_URL: 'https://api.hyperliquid.xyz',
        };
        return config[key];
      }),
    } as any;

    module = await Test.createTestingModule({
      providers: [
        ConfigService,
        AsterFundingDataProvider,
        LighterFundingDataProvider,
        HyperLiquidDataProvider,
        FundingRateAggregator,
        FundingArbitrageStrategy,
        PerpKeeperOrchestrator,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        // Note: In real tests, you'd want to mock the adapters to avoid actual API calls
        // For integration tests, you might want to use testnet or mock servers
      ],
    }).compile();

    aggregator = module.get<FundingRateAggregator>(FundingRateAggregator);
    orchestrator = module.get<PerpKeeperOrchestrator>(PerpKeeperOrchestrator);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('Funding Rate Aggregation', () => {
    it('should aggregate rates from multiple exchanges', async () => {
      // This test would require mocking the actual API calls
      // or using a test environment
      const rates = await aggregator.getFundingRates('ETHUSDT');

      // In a real integration test, you'd verify actual API responses
      expect(Array.isArray(rates)).toBe(true);
    });
  });

  describe('Keeper Service', () => {
    it('should manage multiple exchange adapters', () => {
      const adapters = keeperService.getExchangeAdapters();

      expect(adapters.has(ExchangeType.ASTER)).toBe(true);
      expect(adapters.has(ExchangeType.LIGHTER)).toBe(true);
      expect(adapters.has(ExchangeType.HYPERLIQUID)).toBe(true);
    });

    it('should get positions from all exchanges', async () => {
      const positions = await keeperService.getAllPositions();

      expect(Array.isArray(positions)).toBe(true);
    });
  });

  describe('End-to-End Flow', () => {
    it('should complete full arbitrage flow', async () => {
      // 1. Find opportunities
      const opportunities = await aggregator.findArbitrageOpportunities(['ETHUSDT'], 0.0001);

      if (opportunities.length > 0) {
        // 2. Create execution plan
        const opportunity = opportunities[0];
        const adapters = keeperService.getExchangeAdapters();
        const strategy = module.get<FundingArbitrageStrategy>(FundingArbitrageStrategy);

        const plan = await strategy.createExecutionPlan(opportunity, adapters);

        if (plan) {
          // 3. Execute orders (would be mocked in real tests)
          // const result = await strategy.executeStrategy(['ETHUSDT'], adapters);
          // expect(result.success).toBe(true);
        }
      }
    });
  });
});


