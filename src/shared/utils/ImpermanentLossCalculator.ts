/**
 * Impermanent Loss Calculator
 * Calculates IL for liquidity provider positions
 * 
 * Formula: IL = 2 * sqrt(price_ratio) / (1 + price_ratio) - 1
 * Where price_ratio = current_price / entry_price
 */

import { Price } from '@domain/value-objects';

export class ImpermanentLossCalculator {
  /**
   * Calculate impermanent loss percentage
   * @param entryPrice Entry price of the LP position
   * @param currentPrice Current price
   * @returns IL as a percentage (negative = loss, positive = gain)
   */
  static calculateIL(entryPrice: Price, currentPrice: Price): number {
    const priceRatio = currentPrice.value / entryPrice.value;
    
    // IL formula: 2 * sqrt(r) / (1 + r) - 1
    // Where r = price_ratio
    const sqrtRatio = Math.sqrt(priceRatio);
    const il = (2 * sqrtRatio) / (1 + priceRatio) - 1;
    
    // Convert to percentage
    return il * 100;
  }

  /**
   * Calculate IL-adjusted value
   * @param originalValue Original position value
   * @param entryPrice Entry price
   * @param currentPrice Current price
   * @returns Value adjusted for IL
   */
  static applyIL(originalValue: number, entryPrice: Price, currentPrice: Price): number {
    const ilPercent = this.calculateIL(entryPrice, currentPrice);
    const ilMultiplier = 1 + (ilPercent / 100);
    return originalValue * ilMultiplier;
  }

  /**
   * Calculate IL for a price change
   * @param priceChangePercent Percentage change in price (e.g., 10 for 10% increase)
   * @returns IL percentage
   */
  static calculateILForPriceChange(priceChangePercent: number): number {
    const priceRatio = 1 + (priceChangePercent / 100);
    const sqrtRatio = Math.sqrt(priceRatio);
    const il = (2 * sqrtRatio) / (1 + priceRatio) - 1;
    return il * 100;
  }
}

