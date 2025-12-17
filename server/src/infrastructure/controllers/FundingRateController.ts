import {
  Controller,
  Get,
  Param,
  Query,
  Optional,
  Inject,
} from '@nestjs/common';
import {
  FundingRateAggregator,
  FundingRateComparison,
  ArbitrageOpportunity,
} from '../../domain/services/FundingRateAggregator';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import {
  PredictionBacktester,
  BacktestResults,
} from '../../domain/services/prediction/PredictionBacktester';
import type {
  IFundingRatePredictionService,
  EnsemblePredictionResult,
} from '../../domain/ports/IFundingRatePredictor';

@Controller('funding-rates')
export class FundingRateController {
  constructor(
    private readonly aggregator: FundingRateAggregator,
    @Optional() private readonly backtester?: PredictionBacktester,
    @Optional()
    @Inject('IFundingRatePredictionService')
    private readonly predictionService?: IFundingRatePredictionService,
  ) {}

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
  async compareFundingRates(
    @Param('symbol') symbol: string,
  ): Promise<FundingRateComparison> {
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

    const opportunities = await this.aggregator.findArbitrageOpportunities(
      symbolList,
      minSpreadValue,
    );

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
    const exchangeRate = rates.find(
      (r) => r.exchange === (exchange.toUpperCase() as ExchangeType),
    );

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

  /**
   * Get ensemble prediction for a symbol/exchange
   * GET /funding-rates/prediction/:exchange/:symbol
   */
  @Get('prediction/:exchange/:symbol')
  async getPrediction(
    @Param('exchange') exchange: string,
    @Param('symbol') symbol: string,
  ): Promise<{ prediction: EnsemblePredictionResult } | { error: string }> {
    if (!this.predictionService) {
      return { error: 'Prediction service not available' };
    }

    try {
      const prediction = await this.predictionService.getPrediction(
        symbol.toUpperCase(),
        exchange.toUpperCase() as ExchangeType,
      );
      return { prediction };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to get prediction: ${message}` };
    }
  }

  /**
   * Get spread prediction for arbitrage pair
   * GET /funding-rates/prediction/spread/:symbol?long=HYPERLIQUID&short=ASTER
   */
  @Get('prediction/spread/:symbol')
  async getSpreadPrediction(
    @Param('symbol') symbol: string,
    @Query('long') longExchange: string,
    @Query('short') shortExchange: string,
  ): Promise<
    | {
        predictedSpread: number;
        confidence: number;
        longPrediction: EnsemblePredictionResult;
        shortPrediction: EnsemblePredictionResult;
      }
    | { error: string }
  > {
    if (!this.predictionService) {
      return { error: 'Prediction service not available' };
    }

    if (!longExchange || !shortExchange) {
      return { error: 'Both long and short exchange parameters are required' };
    }

    try {
      return await this.predictionService.getSpreadPrediction(
        symbol.toUpperCase(),
        longExchange.toUpperCase() as ExchangeType,
        shortExchange.toUpperCase() as ExchangeType,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to get spread prediction: ${message}` };
    }
  }

  /**
   * Run backtest for a symbol/exchange
   * GET /funding-rates/backtest/:exchange/:symbol?window=168
   */
  @Get('backtest/:exchange/:symbol')
  async runBacktest(
    @Param('exchange') exchange: string,
    @Param('symbol') symbol: string,
    @Query('window') trainingWindow?: string,
    @Query('details') includeDetails?: string,
  ): Promise<BacktestResults | { error: string }> {
    if (!this.backtester) {
      return { error: 'Backtester not available' };
    }

    try {
      const result = await this.backtester.runBacktest(
        symbol.toUpperCase(),
        exchange.toUpperCase() as ExchangeType,
        {
          trainingWindowHours: trainingWindow
            ? parseInt(trainingWindow, 10)
            : 168,
          includeDetailedPredictions: includeDetails === 'true',
        },
      );
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Backtest failed: ${message}` };
    }
  }

  /**
   * Run backtest for all common symbols on an exchange
   * GET /funding-rates/backtest/:exchange?window=168
   */
  @Get('backtest/:exchange')
  async runBatchBacktest(
    @Param('exchange') exchange: string,
    @Query('window') trainingWindow?: string,
  ): Promise<
    | {
        results: Array<{
          symbol: string;
          mae: number;
          directionalAccuracy: number;
          totalPredictions: number;
        }>;
        summary: {
          avgMae: number;
          avgDirectionalAccuracy: number;
          totalSymbols: number;
        };
      }
    | { error: string }
  > {
    if (!this.backtester) {
      return { error: 'Backtester not available' };
    }

    try {
      // Get common symbols from aggregator
      const symbols = await this.aggregator.discoverCommonAssets();

      const backtestResults = await this.backtester.runBatchBacktest(
        exchange.toUpperCase() as ExchangeType,
        symbols,
        {
          trainingWindowHours: trainingWindow
            ? parseInt(trainingWindow, 10)
            : 168,
        },
      );

      // Format results
      const results: Array<{
        symbol: string;
        mae: number;
        directionalAccuracy: number;
        totalPredictions: number;
      }> = [];

      let totalMae = 0;
      let totalDirAcc = 0;

      for (const [symbol, result] of backtestResults) {
        results.push({
          symbol,
          mae: result.ensembleMetrics.meanAbsoluteError,
          directionalAccuracy: result.ensembleMetrics.directionalAccuracy,
          totalPredictions: result.ensembleMetrics.totalPredictions,
        });
        totalMae += result.ensembleMetrics.meanAbsoluteError;
        totalDirAcc += result.ensembleMetrics.directionalAccuracy;
      }

      const count = results.length || 1;

      return {
        results,
        summary: {
          avgMae: totalMae / count,
          avgDirectionalAccuracy: totalDirAcc / count,
          totalSymbols: results.length,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Batch backtest failed: ${message}` };
    }
  }
}
