import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DomainModule } from '../domain/domain.module';
import { GraphModule } from '../infrastructure/adapters/graph/graph.module';
import { BlockchainModule } from '../infrastructure/adapters/blockchain/blockchain.module';
// StrategyBotService disabled - using perp keeper only
// import { StrategyBotService } from './services/StrategyBotService';
import { DeribitAdapter } from '../infrastructure/adapters/external/DeribitAdapter';
import { PerformanceTracker } from './services/PerformanceTracker';
// HyperLiquidDataProvider and HyperLiquidExecutor moved to PerpKeeperModule
// (they require HyperLiquidWebSocketProvider which is only in PerpKeeperModule)

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DomainModule,
    GraphModule,
    BlockchainModule,
    // PersistenceModule is imported in app.module.ts conditionally
  ],
  providers: [
    // StrategyBotService disabled - using perp keeper only
    DeribitAdapter,
    PerformanceTracker,
    // HyperLiquidDataProvider and HyperLiquidExecutor removed - use PerpKeeperModule instead
  ],
  exports: [],
})
export class ApplicationModule {}
