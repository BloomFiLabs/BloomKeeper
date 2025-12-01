import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PerpKeeperService } from '../../application/services/PerpKeeperService';
import { PerpKeeperScheduler } from '../../application/services/PerpKeeperScheduler';
import { PerpKeeperPerformanceLogger } from '../logging/PerpKeeperPerformanceLogger';
import { AsterExchangeAdapter } from '../adapters/aster/AsterExchangeAdapter';
import { LighterExchangeAdapter } from '../adapters/lighter/LighterExchangeAdapter';
import { HyperliquidExchangeAdapter } from '../adapters/hyperliquid/HyperliquidExchangeAdapter';
import { AsterFundingDataProvider } from '../adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../adapters/hyperliquid/HyperLiquidDataProvider';
import { HyperLiquidWebSocketProvider } from '../adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { FundingRateAggregator } from '../../domain/services/FundingRateAggregator';
import { FundingArbitrageStrategy } from '../../domain/services/FundingArbitrageStrategy';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { ExchangeBalanceRebalancer } from '../../domain/services/ExchangeBalanceRebalancer';
import { PerpKeeperController } from '../controllers/PerpKeeperController';
import { FundingRateController } from '../controllers/FundingRateController';

/**
 * PerpKeeperModule - Module for perpetual keeper functionality
 * 
 * Provides:
 * - Exchange adapters (Aster, Lighter, Hyperliquid)
 * - Funding data providers
 * - Performance logging
 * - Orchestration services
 * - REST API controllers
 */
@Module({
  imports: [ConfigModule],
  controllers: [PerpKeeperController, FundingRateController],
  providers: [
    // Exchange adapters
    AsterExchangeAdapter,
    LighterExchangeAdapter,
    HyperliquidExchangeAdapter,
    
    // Funding data providers
    AsterFundingDataProvider,
    LighterFundingDataProvider,
    HyperLiquidWebSocketProvider, // WebSocket provider for Hyperliquid (reduces rate limits)
    HyperLiquidDataProvider,
    
    // Domain services
    FundingRateAggregator,
    FundingArbitrageStrategy,
    PerpKeeperOrchestrator,
    ExchangeBalanceRebalancer,
    
    // Application services
    PerpKeeperService,
    PerpKeeperScheduler,
    
    // Performance logging
    PerpKeeperPerformanceLogger,
  ],
  exports: [
    PerpKeeperService,
    PerpKeeperScheduler,
    PerpKeeperPerformanceLogger,
    PerpKeeperOrchestrator,
  ],
})
export class PerpKeeperModule {}

