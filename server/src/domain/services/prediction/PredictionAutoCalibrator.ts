import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { PredictionBacktester } from './PredictionBacktester';
import { EnsemblePredictor } from './EnsemblePredictor';
import { FundingRateAggregator } from '../FundingRateAggregator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { MarketRegime } from '../../ports/IFundingRatePredictor';

/**
 * Configuration for the auto-calibration service
 */
const CALIBRATION_CONFIG = {
  /** How often to run calibration (24 hours) */
  CALIBRATION_INTERVAL_MS: 24 * 60 * 60 * 1000,
  /** Test lookback windows (in hours) */
  LOOKBACK_WINDOWS: [48, 168, 336, 720], // 2d, 7d, 14d, 30d
  /** Minimum predictions required for valid calibration */
  MIN_PREDICTIONS: 50,
} as const;

/**
 * PredictionAutoCalibrator - Periodically re-runs backtests to optimize
 * predictor lookbacks and ensemble weights for every active asset.
 */
@Injectable()
export class PredictionAutoCalibrator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PredictionAutoCalibrator.name);
  private calibrationTimer: NodeJS.Timeout | null = null;
  private isCalibrating = false;

  constructor(
    private readonly backtester: PredictionBacktester,
    private readonly ensemblePredictor: EnsemblePredictor,
    private readonly aggregator: FundingRateAggregator,
  ) {}

  async onModuleInit() {
    // Run initial calibration after a short delay
    setTimeout(() => {
      this.runCalibrationCycle().catch(err => 
        this.logger.error(`Initial calibration failed: ${err.message}`)
      );
    }, 60000); // 1 minute delay

    // Schedule periodic calibration
    this.calibrationTimer = setInterval(() => {
      this.runCalibrationCycle().catch(err => 
        this.logger.error(`Periodic calibration failed: ${err.message}`)
      );
    }, CALIBRATION_CONFIG.CALIBRATION_INTERVAL_MS);

    this.logger.log('Prediction Auto-Calibrator initialized');
  }

  onModuleDestroy() {
    if (this.calibrationTimer) {
      clearInterval(this.calibrationTimer);
    }
  }

  /**
   * Run a full calibration cycle for all active assets
   */
  async runCalibrationCycle(): Promise<void> {
    if (this.isCalibrating) {
      this.logger.warn('Calibration cycle already in progress, skipping');
      return;
    }

    this.isCalibrating = true;
    this.logger.log('Starting daily prediction calibration cycle...');

    try {
      const symbols = await this.aggregator.discoverCommonAssets();
      const exchanges = Object.values(ExchangeType).filter(e => 
        e !== ExchangeType.MOCK && e !== ExchangeType.EXTENDED
      );

      for (const symbol of symbols) {
        for (const exchange of exchanges) {
          try {
            await this.calibrateAsset(symbol, exchange);
          } catch (err) {
            this.logger.debug(`Failed to calibrate ${symbol}/${exchange}: ${err.message}`);
          }
        }
      }

      this.logger.log('Prediction calibration cycle complete');
    } catch (error) {
      this.logger.error(`Calibration cycle failed: ${error.message}`);
    } finally {
      this.isCalibrating = false;
    }
  }

  /**
   * Calibrate parameters for a specific asset/exchange pair
   */
  private async calibrateAsset(symbol: string, exchange: ExchangeType): Promise<void> {
    this.logger.debug(`Calibrating ${symbol}/${exchange}...`);

    let bestMAE = Infinity;
    let bestWindow = 168; // Default
    let bestWeights: Record<string, number> = {};

    // 1. Find optimal lookback window
    for (const window of CALIBRATION_CONFIG.LOOKBACK_WINDOWS) {
      try {
        const results = await this.backtester.runBacktest(symbol, exchange, {
          trainingWindowHours: window,
          includeDetailedPredictions: false,
        });

        if (results.ensembleMetrics.totalPredictions < CALIBRATION_CONFIG.MIN_PREDICTIONS) {
          continue;
        }

        if (results.ensembleMetrics.meanAbsoluteError < bestMAE) {
          bestMAE = results.ensembleMetrics.meanAbsoluteError;
          bestWindow = window;
          
          // Calculate optimized weights from individual predictor performance
          // We use inverse variance or inverse MAE for weighting
          bestWeights = this.calculateOptimizedWeights(results.individualMetrics);
        }
      } catch (err) {
        // Most likely insufficient data for this specific window
        continue;
      }
    }

    // 2. Apply calibrated parameters
    if (bestMAE < Infinity) {
      this.ensemblePredictor.setLookbackOverride(symbol, String(exchange), bestWindow);
      this.ensemblePredictor.setWeightOverride(symbol, String(exchange), bestWeights);
      
      this.logger.log(
        `Calibrated ${symbol}/${exchange}: optimal_window=${bestWindow}h, ` +
        `best_mae=${(bestMAE * 100).toFixed(6)}%, weights=${JSON.stringify(bestWeights)}`
      );
    }
  }

  /**
   * Calculate optimized ensemble weights based on backtest performance
   * Uses inverse MAE weighting: weight_i = (1/MAE_i) / Σ(1/MAE_j)
   */
  private calculateOptimizedWeights(
    metrics: Array<{ predictorName: string; meanAbsoluteError: number }>
  ): Record<string, number> {
    const weights: Record<string, number> = {};
    let totalInverseMAE = 0;

    // Filter out predictors with zero or near-zero error to avoid div by zero
    const validMetrics = metrics.filter(m => m.meanAbsoluteError > 1e-10);

    if (validMetrics.length === 0) return {};

    for (const m of validMetrics) {
      const inverseMAE = 1 / m.meanAbsoluteError;
      totalInverseMAE += inverseMAE;
    }

    for (const m of validMetrics) {
      weights[m.predictorName] = (1 / m.meanAbsoluteError) / totalInverseMAE;
    }

    return weights;
  }
}


