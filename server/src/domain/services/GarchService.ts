import { Injectable } from '@nestjs/common';
import { Volatility } from '../value-objects/Volatility';

@Injectable()
export class GarchService {
  /**
   * Fits a GARCH(1,1) model to the returns and returns the estimated next period volatility.
   * Model: sigma_t^2 = omega + alpha * epsilon_{t-1}^2 + beta * sigma_{t-1}^2
   *
   * @param returns Log returns of the asset prices
   * @returns Annualized volatility estimate
   */
  calculateVolatility(returns: number[]): Volatility {
    if (returns.length < 30) {
      throw new Error('Insufficient data for GARCH analysis');
    }

    // 1. Initial Parameters (Guess)
    // Long-run variance = variance of the whole series
    const variance = this.calculateVariance(returns);
    const initialParams = {
      omega: variance * 0.05, // Small weight to long-run
      alpha: 0.1, // Reaction to recent shocks
      beta: 0.85, // Persistence
    };

    // 2. Optimization (Simplified Grid Search / Iterative refinement)
    // For a production system, a proper numerical optimizer (e.g., BFGS) is needed.
    // Here we perform a simple localized grid search around the initial guess or just use robust defaults if optimization is too heavy for this context.
    // Given the constraints, we will use a robust estimation or a simple optimization.

    // Let's implement a very simple optimization: iterate to improve Likelihood
    const params = this.optimizeParams(returns, initialParams);

    // 3. Forecast next variance
    const lastReturn = returns[returns.length - 1];
    const lastVariance = this.calculateConditionalVariance(returns, params)[
      returns.length - 1
    ];

    const nextVariance =
      params.omega +
      params.alpha * Math.pow(lastReturn, 2) +
      params.beta * lastVariance;

    // Annualize (assuming hourly data -> 365 * 24)
    const annualizationFactor = 365 * 24;
    const annualizedVol = Math.sqrt(nextVariance * annualizationFactor);

    return new Volatility(annualizedVol);
  }

  private calculateVariance(data: number[]): number {
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    return data.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / data.length;
  }

  private calculateConditionalVariance(
    returns: number[],
    params: { omega: number; alpha: number; beta: number },
  ): number[] {
    const variances: number[] = [];
    const longRunVariance = this.calculateVariance(returns);

    // Initialize first variance with sample variance
    variances.push(longRunVariance);

    for (let i = 1; i < returns.length; i++) {
      const prevVar = variances[i - 1];
      const prevReturnSq = Math.pow(returns[i - 1], 2);
      const nextVar =
        params.omega + params.alpha * prevReturnSq + params.beta * prevVar;
      variances.push(nextVar);
    }
    return variances;
  }

  private logLikelihood(
    returns: number[],
    params: { omega: number; alpha: number; beta: number },
  ): number {
    // Constraint check
    if (
      params.alpha + params.beta >= 1 ||
      params.omega <= 0 ||
      params.alpha < 0 ||
      params.beta < 0
    ) {
      return -Infinity;
    }

    const variances = this.calculateConditionalVariance(returns, params);
    let logL = 0;

    for (let i = 0; i < returns.length; i++) {
      // Gaussian Likelihood: -0.5 * (log(2*pi) + log(sigma^2) + r^2/sigma^2)
      // We maximize this, so we return the sum.
      // Dropping constant term -0.5 * log(2*pi) as it doesn't affect optimization
      logL +=
        -0.5 *
        (Math.log(variances[i]) + Math.pow(returns[i], 2) / variances[i]);
    }

    return logL;
  }

  private optimizeParams(
    returns: number[],
    initial: { omega: number; alpha: number; beta: number },
  ) {
    let bestParams = { ...initial };
    let bestLikelihood = this.logLikelihood(returns, bestParams);

    // Simple grid search refinement
    // In a real app, use a gradient-based optimizer or a dedicated library
    const alphas = [0.05, 0.1, 0.15, 0.2];
    const betas = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

    // Heuristic: omega = variance * (1 - alpha - beta) to target long-run variance
    const longRunVar = this.calculateVariance(returns);

    for (const alpha of alphas) {
      for (const beta of betas) {
        if (alpha + beta >= 1) continue;

        const omega = longRunVar * (1 - alpha - beta);
        const currentParams = { omega, alpha, beta };
        const likelihood = this.logLikelihood(returns, currentParams);

        if (likelihood > bestLikelihood) {
          bestLikelihood = likelihood;
          bestParams = currentParams;
        }
      }
    }

    return bestParams;
  }
}
