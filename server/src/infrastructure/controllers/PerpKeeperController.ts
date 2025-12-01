import { Controller, Get, Post, Body } from '@nestjs/common';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { FundingArbitrageStrategy } from '../../domain/services/FundingArbitrageStrategy';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpKeeperService } from '../../application/services/PerpKeeperService';
import { PerpKeeperPerformanceLogger } from '../logging/PerpKeeperPerformanceLogger';

@Controller('keeper')
export class PerpKeeperController {
  constructor(
    private readonly orchestrator: PerpKeeperOrchestrator,
    private readonly arbitrageStrategy: FundingArbitrageStrategy,
    private readonly keeperService: PerpKeeperService,
    private readonly performanceLogger: PerpKeeperPerformanceLogger,
  ) {}

  /**
   * Get keeper status and health
   * GET /keeper/status
   */
  @Get('status')
  async getStatus() {
    const healthCheck = await this.orchestrator.healthCheck();
    const areReady = await this.keeperService.areExchangesReady();

    return {
      healthy: healthCheck.healthy && areReady,
      exchanges: Object.fromEntries(
        Array.from(healthCheck.exchanges.entries()).map(([type, status]) => [
          type,
          status,
        ]),
      ),
      timestamp: new Date(),
    };
  }

  /**
   * Get all positions across exchanges
   * GET /keeper/positions
   */
  @Get('positions')
  async getPositions() {
    const metrics = await this.orchestrator.getAllPositionsWithMetrics();

    return {
      positions: metrics.positions.map((p) => ({
        exchange: p.exchangeType,
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedPnl,
        leverage: p.leverage,
        liquidationPrice: p.liquidationPrice,
        marginUsed: p.marginUsed,
        timestamp: p.timestamp,
      })),
      totalUnrealizedPnl: metrics.totalUnrealizedPnl,
      totalPositionValue: metrics.totalPositionValue,
      positionsByExchange: Object.fromEntries(
        Array.from(metrics.positionsByExchange.entries()).map(([type, positions]) => [
          type,
          positions.length,
        ]),
      ),
      timestamp: new Date(),
    };
  }

  /**
   * Manually trigger execution
   * POST /keeper/execute
   * Body: { symbols?: string[], minSpread?: number, maxPositionSizeUsd?: number }
   */
  @Post('execute')
  async execute(@Body() body: { symbols?: string[]; minSpread?: number; maxPositionSizeUsd?: number }) {
    const symbols = body.symbols || ['ETH', 'BTC'];
    const adapters = this.keeperService.getExchangeAdapters();

    const result = await this.arbitrageStrategy.executeStrategy(
      symbols,
      adapters,
      body.minSpread,
      body.maxPositionSizeUsd,
    );

    return {
      success: result.success,
      opportunitiesEvaluated: result.opportunitiesEvaluated,
      opportunitiesExecuted: result.opportunitiesExecuted,
      totalExpectedReturn: result.totalExpectedReturn,
      ordersPlaced: result.ordersPlaced,
      errors: result.errors,
      timestamp: result.timestamp,
    };
  }

  /**
   * Get execution history (placeholder - would need persistence)
   * GET /keeper/history
   */
  @Get('history')
  async getHistory() {
    // TODO: Implement history tracking with persistence
    return {
      message: 'History tracking not yet implemented',
      executions: [],
    };
  }

  /**
   * Get performance metrics
   * GET /keeper/performance
   */
  @Get('performance')
  async getPerformance() {
    // Calculate total capital deployed
    let totalCapital = 0;
    try {
      for (const exchangeType of [ExchangeType.ASTER, ExchangeType.LIGHTER, ExchangeType.HYPERLIQUID]) {
        try {
          const balance = await this.keeperService.getBalance(exchangeType);
          totalCapital += balance;
        } catch (error) {
          // Skip if we can't get balance
        }
      }
    } catch (error) {
      // Use position value as fallback
    }

    const metrics = this.performanceLogger.getPerformanceMetrics(totalCapital);

    return {
      ...metrics,
      exchangeMetrics: Object.fromEntries(
        Array.from(metrics.exchangeMetrics.entries()).map(([type, exchangeMetrics]) => [
          type,
          exchangeMetrics,
        ]),
      ),
    };
  }
}

