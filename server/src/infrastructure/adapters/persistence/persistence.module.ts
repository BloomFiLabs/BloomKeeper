import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { PrismaBotStateRepository } from './PrismaBotStateRepository';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    PrismaService,
    {
      provide: 'IBotStateRepository',
      useClass: PrismaBotStateRepository,
    },
  ],
  exports: ['IBotStateRepository', PrismaService],
})
export class PersistenceModule {}

