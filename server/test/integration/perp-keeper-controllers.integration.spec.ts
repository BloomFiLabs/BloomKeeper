import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { FundingRateController } from '../../src/infrastructure/controllers/FundingRateController';
import { PerpKeeperController } from '../../src/infrastructure/controllers/PerpKeeperController';
import { FundingRateAggregator } from '../../src/domain/services/FundingRateAggregator';
import { PerpKeeperOrchestrator } from '../../src/domain/services/PerpKeeperOrchestrator';
import { FundingArbitrageStrategy } from '../../src/domain/services/FundingArbitrageStrategy';
import { PerpKeeperService } from '../../src/application/services/PerpKeeperService';
import { ExchangeType } from '../../src/domain/value-objects/ExchangeConfig';

describe('PerpKeeper Controllers Integration', () => {
  let app: INestApplication;
  let module: TestingModule;
  let mockAggregator: jest.Mocked<FundingRateAggregator>;
  let mockOrchestrator: jest.Mocked<PerpKeeperOrchestrator>;
  let mockKeeperService: jest.Mocked<PerpKeeperService>;

  beforeEach(async () => {
    mockAggregator = {
      getFundingRates: jest.fn(),
      compareFundingRates: jest.fn(),
      findArbitrageOpportunities: jest.fn(),
    } as any;

    mockOrchestrator = {
      healthCheck: jest.fn(),
      getAllPositionsWithMetrics: jest.fn(),
    } as any;

    mockKeeperService = {
      areExchangesReady: jest.fn(),
      getExchangeAdapters: jest.fn(),
    } as any;

    module = await Test.createTestingModule({
      controllers: [FundingRateController, PerpKeeperController],
      providers: [
        { provide: FundingRateAggregator, useValue: mockAggregator },
        { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
        { provide: FundingArbitrageStrategy, useValue: {} },
        { provide: PerpKeeperService, useValue: mockKeeperService },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('FundingRateController', () => {
    it('GET /funding-rates/:symbol should return funding rates', async () => {
      mockAggregator.getFundingRates.mockResolvedValue([
        {
          exchange: ExchangeType.ASTER,
          symbol: 'ETHUSDT',
          currentRate: 0.0001,
          predictedRate: 0.0001,
          markPrice: 3000,
          openInterest: 1000000,
          timestamp: new Date(),
        },
      ]);

      const response = await request(app.getHttpServer())
        .get('/funding-rates/ETHUSDT')
        .expect(200);

      expect(response.body.symbol).toBe('ETHUSDT');
      expect(response.body.rates).toHaveLength(1);
    });

    it('GET /funding-rates/comparison/:symbol should return comparison', async () => {
      mockAggregator.compareFundingRates.mockResolvedValue({
        symbol: 'ETHUSDT',
        rates: [],
        highestRate: null,
        lowestRate: null,
        spread: 0,
        timestamp: new Date(),
      });

      await request(app.getHttpServer())
        .get('/funding-rates/comparison/ETHUSDT')
        .expect(200);
    });

    it('GET /funding-rates/opportunities should return opportunities', async () => {
      mockAggregator.findArbitrageOpportunities.mockResolvedValue([
        {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.LIGHTER,
          shortExchange: ExchangeType.ASTER,
          longRate: 0.0003,
          shortRate: 0.0001,
          spread: 0.0002,
          expectedReturn: 0.219,
          timestamp: new Date(),
        },
      ]);

      const response = await request(app.getHttpServer())
        .get('/funding-rates/opportunities?symbols=ETHUSDT&minSpread=0.0001')
        .expect(200);

      expect(response.body.opportunities).toHaveLength(1);
    });
  });

  describe('PerpKeeperController', () => {
    it('GET /keeper/status should return keeper status', async () => {
      mockOrchestrator.healthCheck.mockResolvedValue({
        healthy: true,
        exchanges: new Map([
          [ExchangeType.ASTER, { ready: true }],
          [ExchangeType.LIGHTER, { ready: true }],
          [ExchangeType.HYPERLIQUID, { ready: true }],
        ]),
      });

      mockKeeperService.areExchangesReady.mockResolvedValue(true);

      const response = await request(app.getHttpServer())
        .get('/keeper/status')
        .expect(200);

      expect(response.body.healthy).toBe(true);
    });

    it('GET /keeper/positions should return positions', async () => {
      mockOrchestrator.getAllPositionsWithMetrics.mockResolvedValue({
        positions: [],
        totalUnrealizedPnl: 0,
        totalPositionValue: 0,
        positionsByExchange: new Map(),
      });

      const response = await request(app.getHttpServer())
        .get('/keeper/positions')
        .expect(200);

      expect(response.body.positions).toBeDefined();
      expect(response.body.totalUnrealizedPnl).toBeDefined();
    });

    it('POST /keeper/execute should trigger execution', async () => {
      const mockStrategy = {
        executeStrategy: jest.fn().mockResolvedValue({
          success: true,
          opportunitiesEvaluated: 1,
          opportunitiesExecuted: 1,
          totalExpectedReturn: 100,
          ordersPlaced: 2,
          errors: [],
          timestamp: new Date(),
        }),
      };

      // Replace strategy in module
      module.get(FundingArbitrageStrategy).executeStrategy = mockStrategy.executeStrategy;

      const response = await request(app.getHttpServer())
        .post('/keeper/execute')
        .send({ symbols: ['ETHUSDT'], minSpread: 0.0001 })
        .expect(201);

      expect(response.body.success).toBe(true);
    });
  });
});


