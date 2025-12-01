import { Controller, Get, Param, Query } from '@nestjs/common';
import { FundingRateAggregator, FundingRateComparison, ArbitrageOpportunity } from '../../domain/services/FundingRateAggregator';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

@Controller('funding-rates')
export class FundingRateController {
  constructor(private readonly aggregator: FundingRateAggregator) {}

  /**
   * Get current funding rates from all exchanges for a symbol
   * GET /funding-rates/:symbol
   */
  @Get(':symbol')
  async getFundingRates(@Param('symbol') symbol: string) {
    const rates = await this.aggregator.getFundingRates(symbol);
    return {
      symbol,
      rates: rates.map((r) => ({
        exchange: r.exchange,
        currentRate: r.currentRate,
        predictedRate: r.predictedRate,
        markPrice: r.markPrice,
        openInterest: r.openInterest,
        timestamp: r.timestamp,
      })),
      timestamp: new Date(),
    };
  }

  /**
   * Compare funding rates across exchanges for a symbol
   * GET /funding-rates/comparison/:symbol
   */
  @Get('comparison/:symbol')
  async compareFundingRates(@Param('symbol') symbol: string): Promise<FundingRateComparison> {
    return await this.aggregator.compareFundingRates(symbol);
  }

  /**
   * Get current arbitrage opportunities
   * GET /funding-rates/opportunities?symbols=ETH,BTC&minSpread=0.0001
   */
  @Get('opportunities')
  async getOpportunities(
    @Query('symbols') symbols?: string,
    @Query('minSpread') minSpread?: string,
  ): Promise<{ opportunities: ArbitrageOpportunity[] }> {
    const symbolList = symbols ? symbols.split(',') : ['ETH', 'BTC']; // Default symbols
    const minSpreadValue = minSpread ? parseFloat(minSpread) : 0.0001;

    const opportunities = await this.aggregator.findArbitrageOpportunities(symbolList, minSpreadValue);

    return { opportunities };
  }

  /**
   * Get funding rate for a specific exchange and symbol
   * GET /funding-rates/:exchange/:symbol
   */
  @Get(':exchange/:symbol')
  async getExchangeFundingRate(
    @Param('exchange') exchange: string,
    @Param('symbol') symbol: string,
  ) {
    const rates = await this.aggregator.getFundingRates(symbol);
    const exchangeRate = rates.find((r) => r.exchange === exchange.toUpperCase() as ExchangeType);

    if (!exchangeRate) {
      return {
        error: `Funding rate not found for ${exchange} and ${symbol}`,
      };
    }

    return {
      exchange: exchangeRate.exchange,
      symbol: exchangeRate.symbol,
      currentRate: exchangeRate.currentRate,
      predictedRate: exchangeRate.predictedRate,
      markPrice: exchangeRate.markPrice,
      openInterest: exchangeRate.openInterest,
      timestamp: exchangeRate.timestamp,
    };
  }
}

