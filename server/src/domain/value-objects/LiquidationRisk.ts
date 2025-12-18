/**
 * LiquidationRisk Value Object
 *
 * Represents the liquidation risk metrics for a position.
 * Immutable, self-validating, and encapsulates all liquidation-related calculations.
 */
export class LiquidationRisk {
  private constructor(
    public readonly symbol: string,
    public readonly exchange: string,
    public readonly side: 'LONG' | 'SHORT',
    public readonly markPrice: number,
    public readonly liquidationPrice: number,
    public readonly entryPrice: number,
    public readonly positionSize: number,
    public readonly positionValueUsd: number,
    public readonly margin: number,
    public readonly leverage: number,
    public readonly timestamp: Date,
  ) {
    Object.freeze(this);
  }

  /**
   * Distance to liquidation as a percentage (0-1).
   * 0 = at liquidation price, 1 = infinitely far from liquidation.
   *
   * For LONG: (markPrice - liqPrice) / markPrice
   * For SHORT: (liqPrice - markPrice) / markPrice
   */
  get distanceToLiquidation(): number {
    if (this.markPrice <= 0 || this.liquidationPrice <= 0) {
      return 1; // No valid data, assume safe
    }

    if (this.side === 'LONG') {
      // Long liquidates when price falls below liqPrice
      // Distance = how far above liq price we are
      return Math.max(0, (this.markPrice - this.liquidationPrice) / this.markPrice);
    } else {
      // Short liquidates when price rises above liqPrice
      // Distance = how far below liq price we are
      return Math.max(0, (this.liquidationPrice - this.markPrice) / this.markPrice);
    }
  }

  /**
   * How close we are to liquidation (0-1).
   * 0 = safe (far from liquidation), 1 = at liquidation.
   * This is the inverse of distanceToLiquidation.
   */
  get proximityToLiquidation(): number {
    return 1 - this.distanceToLiquidation;
  }

  /**
   * Price change required to liquidate (absolute value).
   */
  get priceToLiquidation(): number {
    return Math.abs(this.markPrice - this.liquidationPrice);
  }

  /**
   * Percentage price move required to liquidate.
   */
  get percentToLiquidation(): number {
    if (this.markPrice <= 0) return 100;
    return (this.priceToLiquidation / this.markPrice) * 100;
  }

  /**
   * Risk level based on proximity to liquidation.
   */
  get riskLevel(): 'SAFE' | 'WARNING' | 'DANGER' | 'CRITICAL' {
    const proximity = this.proximityToLiquidation;

    if (proximity >= 0.7) return 'CRITICAL'; // 70%+ close to liquidation
    if (proximity >= 0.5) return 'DANGER'; // 50-70% close
    if (proximity >= 0.3) return 'WARNING'; // 30-50% close
    return 'SAFE';
  }

  /**
   * Whether this position should trigger emergency close.
   * @param threshold Proximity threshold (0-1). Default 0.7 (70% close to liquidation).
   */
  shouldEmergencyClose(threshold: number = 0.7): boolean {
    return this.proximityToLiquidation >= threshold;
  }

  /**
   * Create a LiquidationRisk from position data.
   */
  static create(params: {
    symbol: string;
    exchange: string;
    side: 'LONG' | 'SHORT';
    markPrice: number;
    liquidationPrice: number;
    entryPrice: number;
    positionSize: number;
    positionValueUsd: number;
    margin: number;
    leverage: number;
  }): LiquidationRisk {
    return new LiquidationRisk(
      params.symbol,
      params.exchange,
      params.side,
      params.markPrice,
      params.liquidationPrice,
      params.entryPrice,
      params.positionSize,
      params.positionValueUsd,
      params.margin,
      params.leverage,
      new Date(),
    );
  }

  /**
   * Create a "safe" placeholder when liquidation data is unavailable.
   */
  static safe(symbol: string, exchange: string, side: 'LONG' | 'SHORT'): LiquidationRisk {
    return new LiquidationRisk(
      symbol,
      exchange,
      side,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      new Date(),
    );
  }

  toString(): string {
    return (
      `LiquidationRisk(${this.symbol}@${this.exchange} ${this.side}): ` +
      `${this.percentToLiquidation.toFixed(1)}% to liq, ` +
      `proximity=${(this.proximityToLiquidation * 100).toFixed(1)}%, ` +
      `risk=${this.riskLevel}`
    );
  }

  toJSON(): object {
    return {
      symbol: this.symbol,
      exchange: this.exchange,
      side: this.side,
      markPrice: this.markPrice,
      liquidationPrice: this.liquidationPrice,
      entryPrice: this.entryPrice,
      positionSize: this.positionSize,
      positionValueUsd: this.positionValueUsd,
      margin: this.margin,
      leverage: this.leverage,
      distanceToLiquidation: this.distanceToLiquidation,
      proximityToLiquidation: this.proximityToLiquidation,
      percentToLiquidation: this.percentToLiquidation,
      riskLevel: this.riskLevel,
      timestamp: this.timestamp.toISOString(),
    };
  }
}

