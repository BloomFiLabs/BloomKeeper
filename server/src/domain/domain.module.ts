import { Module } from '@nestjs/common';
import { StatisticalAnalyst } from './services/StatisticalAnalyst';
import { GarchService } from './services/GarchService';

@Module({
  providers: [StatisticalAnalyst, GarchService],
  exports: [StatisticalAnalyst, GarchService],
})
export class DomainModule {}
