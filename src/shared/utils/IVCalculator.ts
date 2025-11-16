/**
 * Utility to calculate Implied Volatility (IV) from historical price data
 * Uses Historical Volatility as a proxy for IV
 */

export interface PricePoint {
  timestamp: Date;
  close: number;
}

export interface IVPoint {
  timestamp: Date;
  iv: number; // Percentage (e.g., 50 for 50%)
}

/**
 * Calculate historical volatility from price series
 * @param prices Array of closing prices
 * @param annualizationFactor Factor to annualize (365 for daily, 252 for trading days)
 * @returns Annualized volatility as percentage
 */
export function calculateHistoricalVolatility(
  prices: number[],
  annualizationFactor: number = 365
): number {
  if (prices.length < 2) return 0;

  // Calculate log returns
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }

  if (returns.length === 0) return 0;

  // Calculate mean return
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;

  // Calculate variance
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

  // Standard deviation
  const stdDev = Math.sqrt(variance);

  // Annualize
  const annualizedVol = stdDev * Math.sqrt(annualizationFactor);

  // Convert to percentage
  return annualizedVol * 100;
}

/**
 * Calculate rolling IV using a sliding window
 * @param pricePoints Array of price points with timestamps
 * @param windowDays Number of days for rolling window (default: 30)
 * @param annualizationFactor Factor to annualize (365 for daily)
 * @returns Array of IV points
 */
export function calculateRollingIV(
  pricePoints: PricePoint[],
  windowDays: number = 30,
  annualizationFactor: number = 365
): IVPoint[] {
  const ivs: IVPoint[] = [];

  if (pricePoints.length < windowDays + 1) {
    // Not enough data, return single IV for all
    const prices = pricePoints.map((p) => p.close);
    const iv = calculateHistoricalVolatility(prices, annualizationFactor);
    return pricePoints.map((p) => ({ timestamp: p.timestamp, iv }));
  }

  for (let i = windowDays; i < pricePoints.length; i++) {
    const windowPrices = pricePoints
      .slice(i - windowDays, i)
      .map((p) => p.close);
    const iv = calculateHistoricalVolatility(windowPrices, annualizationFactor);
    ivs.push({ timestamp: pricePoints[i].timestamp, iv });
  }

  // Fill initial window with first calculated IV
  const firstIV = ivs.length > 0 ? ivs[0].iv : 0;
  for (let i = 0; i < windowDays; i++) {
    ivs.unshift({ timestamp: pricePoints[i].timestamp, iv: firstIV });
  }

  return ivs;
}

/**
 * Calculate IV using exponential weighted moving average (EWMA)
 * This gives more weight to recent volatility
 */
export function calculateEWMAIV(
  pricePoints: PricePoint[],
  lambda: number = 0.94, // Decay factor (0.94 is common)
  annualizationFactor: number = 365
): IVPoint[] {
  if (pricePoints.length < 2) {
    return pricePoints.map((p) => ({ timestamp: p.timestamp, iv: 0 }));
  }

  const ivs: IVPoint[] = [];
  let variance = 0;

  // Initialize with first return
  for (let i = 1; i < pricePoints.length; i++) {
    const prevPrice = pricePoints[i - 1].close;
    const currPrice = pricePoints[i].close;

    if (prevPrice > 0) {
      const return_ = Math.log(currPrice / prevPrice);
      variance = lambda * variance + (1 - lambda) * return_ * return_;
      const iv = Math.sqrt(variance * annualizationFactor) * 100;
      ivs.push({ timestamp: pricePoints[i].timestamp, iv });
    }
  }

  // Add first point with initial IV
  if (ivs.length > 0) {
    ivs.unshift({ timestamp: pricePoints[0].timestamp, iv: ivs[0].iv });
  }

  return ivs;
}

/**
 * Calculate IV using Parkinson estimator (uses high-low range)
 * More efficient than close-to-close
 */
export function calculateParkinsonIV(
  pricePoints: Array<{ timestamp: Date; high: number; low: number }>,
  annualizationFactor: number = 365
): IVPoint[] {
  const ivs: IVPoint[] = [];

  for (let i = 0; i < pricePoints.length; i++) {
    const { high, low } = pricePoints[i];
    if (low > 0) {
      const range = Math.log(high / low);
      const variance = (range * range) / (4 * Math.log(2));
      const iv = Math.sqrt(variance * annualizationFactor) * 100;
      ivs.push({ timestamp: pricePoints[i].timestamp, iv });
    }
  }

  return ivs;
}

/**
 * Calculate IV using Garman-Klass estimator (uses OHLC)
 * Most efficient estimator using all price information
 */
export function calculateGarmanKlassIV(
  pricePoints: Array<{
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
  }>,
  annualizationFactor: number = 365
): IVPoint[] {
  const ivs: IVPoint[] = [];

  for (let i = 0; i < pricePoints.length; i++) {
    const { open, high, low, close } = pricePoints[i];
    if (low > 0 && open > 0) {
      const hl = Math.log(high / low);
      const co = Math.log(close / open);
      const variance =
        0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
      const iv = Math.sqrt(Math.max(0, variance) * annualizationFactor) * 100;
      ivs.push({ timestamp: pricePoints[i].timestamp, iv });
    }
  }

  return ivs;
}


