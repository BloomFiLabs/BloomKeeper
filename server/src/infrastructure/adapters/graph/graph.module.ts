import { Module } from '@nestjs/common';
import { UniswapGraphAdapter } from './UniswapGraphAdapter';

@Module({
  providers: [
    {
      provide: 'IMarketDataProvider',
      useClass: UniswapGraphAdapter,
    },
  ],
  exports: ['IMarketDataProvider'],
})
export class GraphModule {}
