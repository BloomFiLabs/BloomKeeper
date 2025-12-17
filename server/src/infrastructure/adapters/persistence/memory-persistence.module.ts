import { Module, Global } from '@nestjs/common';
import { InMemoryBotStateRepository } from './InMemoryBotStateRepository';

@Global()
@Module({
  providers: [
    {
      provide: 'IBotStateRepository',
      useClass: InMemoryBotStateRepository,
    },
  ],
  exports: ['IBotStateRepository'],
})
export class MemoryPersistenceModule {}
