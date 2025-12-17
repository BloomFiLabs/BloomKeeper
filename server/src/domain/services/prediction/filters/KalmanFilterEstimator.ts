import { Injectable, Logger } from '@nestjs/common';
import {
  KalmanState,
  HistoricalRatePoint,
} from '../../../ports/IFundingRatePredictor';

/**
 * Kalman Filter configuration constants
 * Tuned for funding rate time series characteristics
 */
const KALMAN_CONFIG = {
  /** Process noise for rate state */
  PROCESS_NOISE_RATE: 1e-8,
  /** Process noise for velocity state */
  PROCESS_NOISE_VELOCITY: 1e-9,
  /** Process noise for volatility state */
  PROCESS_NOISE_VOLATILITY: 1e-10,
  /** Measurement noise (observation uncertainty) */
  MEASUREMENT_NOISE: 1e-7,
  /** Minimum variance to prevent numerical instability */
  MIN_VARIANCE: 1e-12,
  /** Initial state covariance diagonal */
  INITIAL_COVARIANCE: 1e-6,
} as const;

/**
 * KalmanFilterEstimator - State-space model for funding rate estimation
 *
 * Implements a 3-state Kalman filter:
 * - State 1: Funding rate level
 * - State 2: Rate of change (velocity)
 * - State 3: Local volatility estimate
 *
 * The filter provides smoothed estimates and one-step-ahead predictions
 * that are more robust than raw observations.
 *
 * @see https://en.wikipedia.org/wiki/Kalman_filter
 */
@Injectable()
export class KalmanFilterEstimator {
  private readonly logger = new Logger(KalmanFilterEstimator.name);

  /** Cache of filter states by symbol-exchange key */
  private readonly filterStates: Map<string, KalmanState> = new Map();

  /**
   * Initialize or reset filter state for a symbol-exchange pair
   */
  initializeState(
    symbol: string,
    exchange: string,
    initialRate: number,
  ): KalmanState {
    const key = this.getKey(symbol, exchange);

    const state: KalmanState = {
      rate: initialRate,
      rateVelocity: 0,
      volatility: Math.abs(initialRate) * 0.1 || 1e-5,
      covariance: this.initializeCovarianceMatrix(),
    };

    this.filterStates.set(key, state);
    return state;
  }

  /**
   * Get current filter state, initializing if needed
   */
  getState(symbol: string, exchange: string): KalmanState | null {
    return this.filterStates.get(this.getKey(symbol, exchange)) ?? null;
  }

  /**
   * Process a new observation and update the filter state
   *
   * @param symbol Normalized symbol
   * @param exchange Exchange type
   * @param observedRate Observed funding rate
   * @param deltaHours Time since last observation in hours
   * @returns Updated state after processing observation
   */
  update(
    symbol: string,
    exchange: string,
    observedRate: number,
    deltaHours: number = 1,
  ): KalmanState {
    const key = this.getKey(symbol, exchange);
    const state = this.filterStates.get(key);

    if (!state) {
      return this.initializeState(symbol, exchange, observedRate);
    }

    // Prediction step: propagate state forward
    const predictedState = this.predict(state, deltaHours);

    // Update step: incorporate observation
    const updatedState = this.correct(predictedState, observedRate);

    this.filterStates.set(key, updatedState);
    return updatedState;
  }

  /**
   * Process multiple historical observations to warm up the filter
   */
  warmUp(
    symbol: string,
    exchange: string,
    historicalRates: HistoricalRatePoint[],
  ): KalmanState {
    if (historicalRates.length === 0) {
      return this.initializeState(symbol, exchange, 0);
    }

    // Sort by timestamp (oldest first)
    const sorted = [...historicalRates].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    // Initialize with first observation
    let state = this.initializeState(symbol, exchange, sorted[0].rate);

    // Process remaining observations
    for (let i = 1; i < sorted.length; i++) {
      const deltaHours =
        (sorted[i].timestamp.getTime() - sorted[i - 1].timestamp.getTime()) /
        (1000 * 60 * 60);

      state = this.update(symbol, exchange, sorted[i].rate, deltaHours);
    }

    return state;
  }

  /**
   * Get one-step-ahead prediction without updating state
   */
  getPrediction(
    symbol: string,
    exchange: string,
    horizonHours: number = 1,
  ): { predictedRate: number; uncertainty: number } | null {
    const state = this.filterStates.get(this.getKey(symbol, exchange));

    if (!state) {
      return null;
    }

    const predicted = this.predict(state, horizonHours);

    return {
      predictedRate: predicted.rate,
      uncertainty: Math.sqrt(predicted.covariance[0]), // sqrt of rate variance
    };
  }

  /**
   * Prediction step: propagate state forward in time
   *
   * State transition model:
   * rate(t+1) = rate(t) + velocity(t) * dt
   * velocity(t+1) = velocity(t) * decay
   * volatility(t+1) = volatility(t)
   */
  private predict(state: KalmanState, deltaHours: number): KalmanState {
    const dt = deltaHours;
    const velocityDecay = Math.exp(-0.1 * dt); // Velocity decays over time

    // Predicted state
    const predictedRate = state.rate + state.rateVelocity * dt;
    const predictedVelocity = state.rateVelocity * velocityDecay;
    const predictedVolatility = state.volatility;

    // State transition matrix F (3x3)
    const F = [
      1,
      dt,
      0, // rate row
      0,
      velocityDecay,
      0, // velocity row
      0,
      0,
      1, // volatility row
    ];

    // Process noise covariance Q (3x3 diagonal)
    const Q = this.getProcessNoiseMatrix(dt);

    // Predicted covariance: P' = F * P * F' + Q
    const predictedCovariance = this.propagateCovariance(
      state.covariance,
      F,
      Q,
    );

    return {
      rate: predictedRate,
      rateVelocity: predictedVelocity,
      volatility: predictedVolatility,
      covariance: predictedCovariance,
    };
  }

  /**
   * Correction step: incorporate observation
   *
   * Observation model: z = H * x + v
   * where H = [1, 0, 0] (we only observe the rate)
   */
  private correct(
    predictedState: KalmanState,
    observedRate: number,
  ): KalmanState {
    const H = [1, 0, 0]; // Observation matrix
    const R = KALMAN_CONFIG.MEASUREMENT_NOISE; // Measurement noise

    // Innovation (measurement residual)
    const innovation = observedRate - predictedState.rate;

    // Innovation covariance: S = H * P * H' + R
    const S = this.computeInnovationCovariance(predictedState.covariance, H, R);

    // Kalman gain: K = P * H' / S
    const K = this.computeKalmanGain(predictedState.covariance, H, S);

    // Updated state: x = x' + K * innovation
    const updatedRate = predictedState.rate + K[0] * innovation;
    const updatedVelocity = predictedState.rateVelocity + K[1] * innovation;
    const updatedVolatility = this.updateVolatility(
      predictedState.volatility,
      innovation,
    );

    // Updated covariance: P = (I - K * H) * P'
    const updatedCovariance = this.updateCovariance(
      predictedState.covariance,
      K,
      H,
    );

    return {
      rate: updatedRate,
      rateVelocity: updatedVelocity,
      volatility: updatedVolatility,
      covariance: updatedCovariance,
    };
  }

  /**
   * Update volatility estimate using exponential moving average of squared innovations
   */
  private updateVolatility(
    currentVolatility: number,
    innovation: number,
  ): number {
    const alpha = 0.1; // Smoothing factor
    const newEstimate = Math.sqrt(
      (1 - alpha) * currentVolatility ** 2 + alpha * innovation ** 2,
    );
    return Math.max(newEstimate, KALMAN_CONFIG.MIN_VARIANCE);
  }

  /**
   * Initialize 3x3 covariance matrix (stored as flat array)
   */
  private initializeCovarianceMatrix(): number[] {
    const c = KALMAN_CONFIG.INITIAL_COVARIANCE;
    return [
      c,
      0,
      0, // row 0
      0,
      c,
      0, // row 1
      0,
      0,
      c, // row 2
    ];
  }

  /**
   * Get process noise matrix scaled by time step
   */
  private getProcessNoiseMatrix(dt: number): number[] {
    const qr = KALMAN_CONFIG.PROCESS_NOISE_RATE * dt;
    const qv = KALMAN_CONFIG.PROCESS_NOISE_VELOCITY * dt;
    const qs = KALMAN_CONFIG.PROCESS_NOISE_VOLATILITY * dt;
    return [qr, 0, 0, 0, qv, 0, 0, 0, qs];
  }

  /**
   * Propagate covariance: P' = F * P * F' + Q
   * Using simplified calculation for 3x3 matrices
   */
  private propagateCovariance(P: number[], F: number[], Q: number[]): number[] {
    // FP = F * P
    const FP = this.matMul3x3(F, P);
    // FPF' = FP * F'
    const Ft = this.transpose3x3(F);
    const FPFt = this.matMul3x3(FP, Ft);
    // Add process noise
    return FPFt.map((val, i) => val + Q[i]);
  }

  /**
   * Compute innovation covariance: S = H * P * H' + R
   */
  private computeInnovationCovariance(
    P: number[],
    H: number[],
    R: number,
  ): number {
    // For H = [1, 0, 0], S = P[0,0] + R
    return P[0] + R;
  }

  /**
   * Compute Kalman gain: K = P * H' / S
   */
  private computeKalmanGain(P: number[], H: number[], S: number): number[] {
    // For H = [1, 0, 0], K = [P[0,0], P[1,0], P[2,0]] / S
    const Sinv = 1 / Math.max(S, KALMAN_CONFIG.MIN_VARIANCE);
    return [P[0] * Sinv, P[3] * Sinv, P[6] * Sinv];
  }

  /**
   * Update covariance: P = (I - K * H) * P'
   */
  private updateCovariance(P: number[], K: number[], H: number[]): number[] {
    // (I - K * H) for H = [1, 0, 0]
    const IKH = [1 - K[0], 0, 0, -K[1], 1, 0, -K[2], 0, 1];
    return this.matMul3x3(IKH, P).map((v) =>
      Math.max(v, KALMAN_CONFIG.MIN_VARIANCE),
    );
  }

  /**
   * 3x3 matrix multiplication (row-major order)
   */
  private matMul3x3(A: number[], B: number[]): number[] {
    const result = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          result[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
        }
      }
    }
    return result;
  }

  /**
   * Transpose 3x3 matrix
   */
  private transpose3x3(M: number[]): number[] {
    return [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
  }

  /**
   * Get cache key for symbol-exchange pair
   */
  private getKey(symbol: string, exchange: string): string {
    return `${symbol}_${exchange}`;
  }

  /**
   * Clear all cached filter states
   */
  clearCache(): void {
    this.filterStates.clear();
  }

  /**
   * Remove specific filter state
   */
  clearState(symbol: string, exchange: string): void {
    this.filterStates.delete(this.getKey(symbol, exchange));
  }
}
