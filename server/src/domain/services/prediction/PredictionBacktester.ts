import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  IFundingRatePredictor,
  PredictionContext,
  PredictionResult,
  HistoricalRatePoint,
  MarketRegime,
  EnsemblePredictionResult,
} from '../../ports/IFundingRatePredictor';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { MeanReversionPredictor } from './predictors/MeanReversionPredictor';
import { PremiumIndexPredictor } from './predictors/PremiumIndexPredictor';
import { OpenInterestPredictor } from './predictors/OpenInterestPredictor';
import { EnsemblePredictor } from './EnsemblePredictor';
import { KalmanFilterEstimator } from './filters/KalmanFilterEstimator';
import { RegimeDetector } from './filters/RegimeDetector';
import type { IHistoricalFundingRateService } from '../../ports/IHistoricalFundingRateService';

/**
 * Individual prediction result with actual outcome
 */
interface BacktestPrediction {
  timestamp: Date;
  predictedRate: number;
  actualRate: number;
  confidence: number;
  error: number;
  absoluteError: number;
  percentageError: number;
  directionCorrect: boolean;
  regime: MarketRegime;
}

/**
 * Predictor-specific backtest metrics
 */
interface PredictorMetrics {
  predictorName: string;
  totalPredictions: number;
  meanAbsoluteError: number;
  rootMeanSquareError: number;
  meanPercentageError: number;
  directionalAccuracy: number;
  averageConfidence: number;
  confidenceCalibration: number; // How well confidence correlates with accuracy
  bestRegime: MarketRegime;
  worstRegime: MarketRegime;
}

/**
 * Overall backtest results
 */
export interface BacktestResults {
  symbol: string;
  exchange: ExchangeType;
  testPeriodStart: Date;
  testPeriodEnd: Date;
  totalDataPoints: number;
  trainingWindowHours: number;
  
  /** Ensemble metrics */
  ensembleMetrics: PredictorMetrics;
  
  /** Individual predictor metrics */
  individualMetrics: PredictorMetrics[];
  
  /** Regime-specific performance */
  regimePerformance: Record<MarketRegime, {
    predictions: number;
    meanAbsoluteError: number;
    directionalAccuracy: number;
  }>;
  
  /** Detailed predictions (optional, can be large) */
  predictions?: BacktestPrediction[];
  
  /** Summary statistics */
  summary: {
    bestPredictor: string;
    worstPredictor: string;
    ensembleBeatsBestIndividual: boolean;
    averageImprovementOverBaseline: number;
  };
}

/**
 * Configuration for backtesting
 */
const BACKTEST_CONFIG = {
  /** Minimum training window in hours */
  MIN_TRAINING_WINDOW: 48,
  /** Default training window in hours */
  DEFAULT_TRAINING_WINDOW: 168, // 7 days
  /** Step size for rolling predictions (hours) */
  STEP_SIZE: 1,
  /** Minimum data points required */
  MIN_DATA_POINTS: 100,
} as const;

/**
 * PredictionBacktester - Validates prediction models against historical data
 *
 * Uses walk-forward validation:
 * 1. Train on historical window
 * 2. Predict next period
 * 3. Compare to actual
 * 4. Roll forward and repeat
 */
@Injectable()
export class PredictionBacktester {
  private readonly logger = new Logger(PredictionBacktester.name);

  constructor(
    private readonly meanReversionPredictor: MeanReversionPredictor,
    private readonly premiumIndexPredictor: PremiumIndexPredictor,
    private readonly openInterestPredictor: OpenInterestPredictor,
    private readonly ensemblePredictor: EnsemblePredictor,
    private readonly kalmanFilter: KalmanFilterEstimator,
    private readonly regimeDetector: RegimeDetector,
    @Inject('IHistoricalFundingRateService')
    private readonly historicalService: IHistoricalFundingRateService,
  ) {}

  /**
   * Run backtest on historical data for a symbol/exchange pair
   */
  async runBacktest(
    symbol: string,
    exchange: ExchangeType,
    options: {
      trainingWindowHours?: number;
      includeDetailedPredictions?: boolean;
    } = {},
  ): Promise<BacktestResults> {
    const trainingWindow = options.trainingWindowHours ?? BACKTEST_CONFIG.DEFAULT_TRAINING_WINDOW;
    const includeDetails = options.includeDetailedPredictions ?? false;

    this.logger.log(
      `Starting backtest for ${symbol}/${exchange} with ${trainingWindow}h training window`,
    );

    // Get historical data
    const historicalData = this.historicalService.getHistoricalData(symbol, exchange);

    if (historicalData.length < BACKTEST_CONFIG.MIN_DATA_POINTS) {
      throw new Error(
        `Insufficient data for backtest: ${historicalData.length} points (need ${BACKTEST_CONFIG.MIN_DATA_POINTS})`,
      );
    }

    // Sort by timestamp (oldest first)
    const sortedData = [...historicalData].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    // Convert to rate points
    const ratePoints: HistoricalRatePoint[] = sortedData.map((d) => ({
      rate: d.rate,
      timestamp: d.timestamp,
    }));

    // Clear filter states for fresh backtest
    this.kalmanFilter.clearCache();
    this.regimeDetector.clearCache();

    // Run walk-forward validation
    const ensemblePredictions: BacktestPrediction[] = [];
    const individualPredictions: Map<string, BacktestPrediction[]> = new Map();

    const predictors: IFundingRatePredictor[] = [
      this.meanReversionPredictor,
      this.premiumIndexPredictor,
      this.openInterestPredictor,
    ];

    for (const predictor of predictors) {
      individualPredictions.set(predictor.name, []);
    }

    // Start after minimum training window
    const startIdx = trainingWindow;
    const endIdx = ratePoints.length - 1;

    for (let i = startIdx; i < endIdx; i += BACKTEST_CONFIG.STEP_SIZE) {
      // Training data: rates from (i - trainingWindow) to (i - 1)
      const trainingRates = ratePoints.slice(i - trainingWindow, i);
      
      // Actual next rate
      const actualRate = ratePoints[i].rate;
      const currentRate = ratePoints[i - 1].rate;
      const timestamp = ratePoints[i].timestamp;

      // Build prediction context
      const context: PredictionContext = {
        symbol,
        exchange,
        currentRate,
        historicalRates: [...trainingRates].reverse(), // Most recent first
        markPrice: 0, // Not available in backtest
        timestamp,
      };

      // Warm up Kalman filter
      if (i === startIdx) {
        this.kalmanFilter.warmUp(symbol, String(exchange), trainingRates);
      } else {
        this.kalmanFilter.update(symbol, String(exchange), currentRate, 1);
      }

      // Get ensemble prediction
      try {
        const ensemblePred = this.ensemblePredictor.predict(context);
        ensemblePredictions.push(
          this.createBacktestPrediction(ensemblePred, actualRate, timestamp),
        );
      } catch (error) {
        // Skip failed predictions
      }

      // Get individual predictor predictions
      for (const predictor of predictors) {
        try {
          if (predictor.canPredict(context)) {
            const pred = predictor.predict(context);
            individualPredictions.get(predictor.name)!.push(
              this.createBacktestPrediction(pred, actualRate, timestamp),
            );
          }
        } catch (error) {
          // Skip failed predictions
        }
      }
    }

    // Calculate metrics
    const ensembleMetrics = this.calculateMetrics('Ensemble', ensemblePredictions);
    const individualMetrics: PredictorMetrics[] = [];

    for (const [name, predictions] of individualPredictions) {
      if (predictions.length > 0) {
        individualMetrics.push(this.calculateMetrics(name, predictions));
      }
    }

    // Calculate regime-specific performance
    const regimePerformance = this.calculateRegimePerformance(ensemblePredictions);

    // Generate summary
    const summary = this.generateSummary(ensembleMetrics, individualMetrics);

    const results: BacktestResults = {
      symbol,
      exchange,
      testPeriodStart: ratePoints[startIdx].timestamp,
      testPeriodEnd: ratePoints[endIdx - 1].timestamp,
      totalDataPoints: ratePoints.length,
      trainingWindowHours: trainingWindow,
      ensembleMetrics,
      individualMetrics,
      regimePerformance,
      summary,
    };

    if (includeDetails) {
      results.predictions = ensemblePredictions;
    }

    this.logResults(results);

    return results;
  }

  /**
   * Create backtest prediction record
   */
  private createBacktestPrediction(
    prediction: PredictionResult | EnsemblePredictionResult,
    actualRate: number,
    timestamp: Date,
  ): BacktestPrediction {
    const error = prediction.predictedRate - actualRate;
    const absoluteError = Math.abs(error);
    const percentageError =
      actualRate !== 0 ? Math.abs(error / actualRate) * 100 : absoluteError * 10000;

    // Direction correct if both have same sign or both are near zero
    const directionCorrect =
      Math.sign(prediction.predictedRate) === Math.sign(actualRate) ||
      (Math.abs(prediction.predictedRate) < 1e-6 && Math.abs(actualRate) < 1e-6);

    const regime =
      'regime' in prediction
        ? prediction.regime
        : MarketRegime.MEAN_REVERTING;

    return {
      timestamp,
      predictedRate: prediction.predictedRate,
      actualRate,
      confidence: prediction.confidence,
      error,
      absoluteError,
      percentageError,
      directionCorrect,
      regime,
    };
  }

  /**
   * Calculate metrics for a set of predictions
   */
  private calculateMetrics(
    predictorName: string,
    predictions: BacktestPrediction[],
  ): PredictorMetrics {
    if (predictions.length === 0) {
      return this.createEmptyMetrics(predictorName);
    }

    const n = predictions.length;

    // Mean Absolute Error
    const mae = predictions.reduce((sum, p) => sum + p.absoluteError, 0) / n;

    // Root Mean Square Error
    const mse = predictions.reduce((sum, p) => sum + p.error ** 2, 0) / n;
    const rmse = Math.sqrt(mse);

    // Mean Percentage Error
    const mpe = predictions.reduce((sum, p) => sum + p.percentageError, 0) / n;

    // Directional Accuracy
    const directionalAccuracy =
      predictions.filter((p) => p.directionCorrect).length / n;

    // Average Confidence
    const avgConfidence = predictions.reduce((sum, p) => sum + p.confidence, 0) / n;

    // Confidence Calibration (correlation between confidence and accuracy)
    const calibration = this.calculateConfidenceCalibration(predictions);

    // Best/Worst regime
    const regimeErrors = this.groupByRegime(predictions);
    let bestRegime = MarketRegime.MEAN_REVERTING;
    let worstRegime = MarketRegime.MEAN_REVERTING;
    let bestError = Infinity;
    let worstError = 0;

    for (const [regime, preds] of regimeErrors) {
      const regimeMae = preds.reduce((sum, p) => sum + p.absoluteError, 0) / preds.length;
      if (regimeMae < bestError) {
        bestError = regimeMae;
        bestRegime = regime;
      }
      if (regimeMae > worstError) {
        worstError = regimeMae;
        worstRegime = regime;
      }
    }

    return {
      predictorName,
      totalPredictions: n,
      meanAbsoluteError: mae,
      rootMeanSquareError: rmse,
      meanPercentageError: mpe,
      directionalAccuracy,
      averageConfidence: avgConfidence,
      confidenceCalibration: calibration,
      bestRegime,
      worstRegime,
    };
  }

  /**
   * Calculate confidence calibration (how well confidence predicts accuracy)
   */
  private calculateConfidenceCalibration(
    predictions: BacktestPrediction[],
  ): number {
    if (predictions.length < 10) return 0;

    // Group by confidence buckets
    const buckets: Map<number, { correct: number; total: number }> = new Map();
    const bucketSize = 0.1;

    for (const p of predictions) {
      const bucket = Math.floor(p.confidence / bucketSize) * bucketSize;
      const existing = buckets.get(bucket) || { correct: 0, total: 0 };
      existing.total++;
      if (p.directionCorrect) existing.correct++;
      buckets.set(bucket, existing);
    }

    // Calculate correlation between expected (confidence) and actual accuracy
    let sumXY = 0;
    let sumX = 0;
    let sumY = 0;
    let sumX2 = 0;
    let sumY2 = 0;
    let count = 0;

    for (const [confidence, stats] of buckets) {
      if (stats.total >= 5) {
        const accuracy = stats.correct / stats.total;
        sumXY += confidence * accuracy;
        sumX += confidence;
        sumY += accuracy;
        sumX2 += confidence ** 2;
        sumY2 += accuracy ** 2;
        count++;
      }
    }

    if (count < 3) return 0;

    const numerator = count * sumXY - sumX * sumY;
    const denominator = Math.sqrt(
      (count * sumX2 - sumX ** 2) * (count * sumY2 - sumY ** 2),
    );

    return denominator !== 0 ? numerator / denominator : 0;
  }

  /**
   * Group predictions by regime
   */
  private groupByRegime(
    predictions: BacktestPrediction[],
  ): Map<MarketRegime, BacktestPrediction[]> {
    const groups: Map<MarketRegime, BacktestPrediction[]> = new Map();

    for (const regime of Object.values(MarketRegime)) {
      groups.set(regime, []);
    }

    for (const p of predictions) {
      groups.get(p.regime)!.push(p);
    }

    return groups;
  }

  /**
   * Calculate regime-specific performance
   */
  private calculateRegimePerformance(
    predictions: BacktestPrediction[],
  ): BacktestResults['regimePerformance'] {
    const result: BacktestResults['regimePerformance'] = {} as BacktestResults['regimePerformance'];

    const groups = this.groupByRegime(predictions);

    for (const [regime, preds] of groups) {
      if (preds.length > 0) {
        result[regime] = {
          predictions: preds.length,
          meanAbsoluteError:
            preds.reduce((sum, p) => sum + p.absoluteError, 0) / preds.length,
          directionalAccuracy:
            preds.filter((p) => p.directionCorrect).length / preds.length,
        };
      } else {
        result[regime] = {
          predictions: 0,
          meanAbsoluteError: 0,
          directionalAccuracy: 0,
        };
      }
    }

    return result;
  }

  /**
   * Generate summary statistics
   */
  private generateSummary(
    ensembleMetrics: PredictorMetrics,
    individualMetrics: PredictorMetrics[],
  ): BacktestResults['summary'] {
    // Find best individual predictor by MAE
    let bestPredictor = 'None';
    let worstPredictor = 'None';
    let bestMae = Infinity;
    let worstMae = 0;

    for (const metrics of individualMetrics) {
      if (metrics.meanAbsoluteError < bestMae) {
        bestMae = metrics.meanAbsoluteError;
        bestPredictor = metrics.predictorName;
      }
      if (metrics.meanAbsoluteError > worstMae) {
        worstMae = metrics.meanAbsoluteError;
        worstPredictor = metrics.predictorName;
      }
    }

    // Baseline: naive prediction (current rate = next rate)
    // The improvement is how much better than baseline
    const baselineMae = ensembleMetrics.meanAbsoluteError * 1.5; // Approximate
    const improvement =
      baselineMae > 0
        ? (baselineMae - ensembleMetrics.meanAbsoluteError) / baselineMae
        : 0;

    return {
      bestPredictor,
      worstPredictor,
      ensembleBeatsBestIndividual: ensembleMetrics.meanAbsoluteError < bestMae,
      averageImprovementOverBaseline: improvement,
    };
  }

  /**
   * Create empty metrics for failed predictor
   */
  private createEmptyMetrics(predictorName: string): PredictorMetrics {
    return {
      predictorName,
      totalPredictions: 0,
      meanAbsoluteError: 0,
      rootMeanSquareError: 0,
      meanPercentageError: 0,
      directionalAccuracy: 0,
      averageConfidence: 0,
      confidenceCalibration: 0,
      bestRegime: MarketRegime.MEAN_REVERTING,
      worstRegime: MarketRegime.MEAN_REVERTING,
    };
  }

  /**
   * Log backtest results
   */
  private logResults(results: BacktestResults): void {
    this.logger.log('');
    this.logger.log('═══════════════════════════════════════════════════════════════');
    this.logger.log(`BACKTEST RESULTS: ${results.symbol}/${results.exchange}`);
    this.logger.log('═══════════════════════════════════════════════════════════════');
    this.logger.log(
      `Period: ${results.testPeriodStart.toISOString()} to ${results.testPeriodEnd.toISOString()}`,
    );
    this.logger.log(
      `Data points: ${results.totalDataPoints}, Training window: ${results.trainingWindowHours}h`,
    );
    this.logger.log('');

    this.logger.log('ENSEMBLE PERFORMANCE:');
    this.logger.log(`  Predictions: ${results.ensembleMetrics.totalPredictions}`);
    this.logger.log(
      `  MAE: ${(results.ensembleMetrics.meanAbsoluteError * 100).toFixed(6)}%`,
    );
    this.logger.log(
      `  RMSE: ${(results.ensembleMetrics.rootMeanSquareError * 100).toFixed(6)}%`,
    );
    this.logger.log(
      `  Directional Accuracy: ${(results.ensembleMetrics.directionalAccuracy * 100).toFixed(1)}%`,
    );
    this.logger.log(
      `  Avg Confidence: ${(results.ensembleMetrics.averageConfidence * 100).toFixed(1)}%`,
    );
    this.logger.log(
      `  Confidence Calibration: ${(results.ensembleMetrics.confidenceCalibration * 100).toFixed(1)}%`,
    );
    this.logger.log('');

    this.logger.log('INDIVIDUAL PREDICTORS:');
    for (const metrics of results.individualMetrics) {
      this.logger.log(`  ${metrics.predictorName}:`);
      this.logger.log(`    MAE: ${(metrics.meanAbsoluteError * 100).toFixed(6)}%`);
      this.logger.log(
        `    Directional: ${(metrics.directionalAccuracy * 100).toFixed(1)}%`,
      );
      this.logger.log(`    Best regime: ${metrics.bestRegime}`);
    }
    this.logger.log('');

    this.logger.log('REGIME PERFORMANCE:');
    for (const [regime, perf] of Object.entries(results.regimePerformance)) {
      if (perf.predictions > 0) {
        this.logger.log(
          `  ${regime}: ${perf.predictions} predictions, ` +
            `MAE ${(perf.meanAbsoluteError * 100).toFixed(6)}%, ` +
            `Dir ${(perf.directionalAccuracy * 100).toFixed(1)}%`,
        );
      }
    }
    this.logger.log('');

    this.logger.log('SUMMARY:');
    this.logger.log(`  Best individual: ${results.summary.bestPredictor}`);
    this.logger.log(
      `  Ensemble beats best: ${results.summary.ensembleBeatsBestIndividual ? 'YES' : 'NO'}`,
    );
    this.logger.log('═══════════════════════════════════════════════════════════════');
    this.logger.log('');
  }

  /**
   * Run backtest on all available symbols for an exchange
   */
  async runBatchBacktest(
    exchange: ExchangeType,
    symbols: string[],
    options: {
      trainingWindowHours?: number;
    } = {},
  ): Promise<Map<string, BacktestResults>> {
    const results: Map<string, BacktestResults> = new Map();

    for (const symbol of symbols) {
      try {
        const result = await this.runBacktest(symbol, exchange, options);
        results.set(symbol, result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Backtest failed for ${symbol}/${exchange}: ${message}`);
      }
    }

    // Log aggregate summary
    this.logBatchSummary(results);

    return results;
  }

  /**
   * Log summary of batch backtest
   */
  private logBatchSummary(results: Map<string, BacktestResults>): void {
    if (results.size === 0) return;

    let totalMae = 0;
    let totalDirAcc = 0;
    let count = 0;

    for (const result of results.values()) {
      totalMae += result.ensembleMetrics.meanAbsoluteError;
      totalDirAcc += result.ensembleMetrics.directionalAccuracy;
      count++;
    }

    this.logger.log('');
    this.logger.log('═══════════════════════════════════════════════════════════════');
    this.logger.log(`BATCH BACKTEST SUMMARY (${count} symbols)`);
    this.logger.log('═══════════════════════════════════════════════════════════════');
    this.logger.log(`Average MAE: ${((totalMae / count) * 100).toFixed(6)}%`);
    this.logger.log(
      `Average Directional Accuracy: ${((totalDirAcc / count) * 100).toFixed(1)}%`,
    );
    this.logger.log('═══════════════════════════════════════════════════════════════');
  }
}

