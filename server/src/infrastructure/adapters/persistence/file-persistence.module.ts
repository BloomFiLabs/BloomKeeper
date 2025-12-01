import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FileBotStateRepository } from './FileBotStateRepository';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'IBotStateRepository',
      useClass: FileBotStateRepository,
    },
  ],
  exports: ['IBotStateRepository'],
})
export class FilePersistenceModule {}

