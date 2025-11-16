/**
 * Position Tracker
 * Tracks position lifecycle: entry, rebalances, IL, price deviations
 */

import { Price, Amount } from '@domain/value-objects';

export interface RebalanceEvent {
  date: Date;
  reason: string;
  priceBefore: Price;
  priceAfter: Price;
  priceChange: number; // Percentage
}

export interface PositionMetrics {
  entryDate: Date;
  entryPrice: Price;
  currentPrice: Price;
  totalPriceChange: number; // Percentage from entry
  rebalanceCount: number;
  rebalanceEvents: RebalanceEvent[];
  currentIL: number; // Current IL percentage from entry price
  maxIL: number; // Maximum IL experienced during the period
  hoursInRange: number;
  hoursOutOfRange: number;
  daysInRange: number; // Calculated from hours
  daysOutOfRange: number; // Calculated from hours
  maxPriceDeviation: number; // Maximum deviation from entry price
  minPriceDeviation: number; // Minimum deviation from entry price
  feeCaptureEfficiency: number; // Percentage of time position was earning fees
  totalFeesEarned: number; // Total fees earned in USD
  expectedFees: number; // Expected fees if always in range
  feeCaptureRate: number; // Actual fees / Expected fees
}

export class PositionTracker {
  private entryDate: Date | null = null;
  private entryPrice: Price | null = null; // Original entry price (never changes on rebalance)
  private rebalanceEvents: RebalanceEvent[] = [];
  private maxIL: number = 0; // Track maximum IL experienced
  private hoursInRange: number = 0;
  private hoursOutOfRange: number = 0;
  private maxDeviation: number = 0;
  private minDeviation: number = 0;
  private lastPrice: Price | null = null;
  private lastRecordTime: Date | null = null; // Track last record time to calculate actual hours
  private totalFeesEarned: number = 0;
  private expectedDailyFees: number = 0; // Expected daily fees when in range

  initialize(entryDate: Date, entryPrice: Price): void {
    this.entryDate = entryDate;
    this.entryPrice = entryPrice; // Original entry price - NEVER changes (represents on-chain LP position)
    this.lastPrice = entryPrice;
  }
  
  // Getter for original entry price (for fee capture calculation)
  getOriginalEntryPrice(): Price | null {
    return this.entryPrice;
  }

  recordHour(currentDate: Date, currentPrice: Price, inRange: boolean, rangeWidth: number, feesEarned?: number, expectedDailyFee?: number, hoursElapsed?: number): void {
    if (!this.entryPrice || !this.entryDate) return;
    
    // Validate price
    if (!currentPrice || isNaN(currentPrice.value) || currentPrice.value <= 0) {
      return; // Skip invalid prices
    }

    // Calculate actual hours elapsed since last record
    let actualHours = hoursElapsed || 1; // Default to 1 hour if not provided
    if (this.lastRecordTime) {
      const msElapsed = currentDate.getTime() - this.lastRecordTime.getTime();
      actualHours = Math.max(0.0001, msElapsed / (60 * 60 * 1000)); // Convert to hours, minimum 0.0001
    }
    this.lastRecordTime = currentDate;

    // percentageChange returns (other - this) / this * 100
    // So entryPrice.percentageChange(currentPrice) = (current - entry) / entry * 100
    const priceChange = this.entryPrice.percentageChange(currentPrice);
    const deviation = Math.abs(priceChange);

    // Track max/min deviations
    if (!isNaN(deviation) && deviation > this.maxDeviation) {
      this.maxDeviation = deviation;
    }
    if (!isNaN(deviation) && (deviation < this.minDeviation || this.minDeviation === 0)) {
      this.minDeviation = deviation;
    }

    // Track hours in/out of range based on actual time elapsed
    if (inRange) {
      this.hoursInRange += actualHours;
      // Only earn fees when in range
      if (feesEarned !== undefined && !isNaN(feesEarned)) {
        this.totalFeesEarned += feesEarned;
      }
    } else {
      this.hoursOutOfRange += actualHours;
    }

    // Track expected daily fee rate (store once)
    if (expectedDailyFee !== undefined && this.expectedDailyFees === 0 && !isNaN(expectedDailyFee)) {
      this.expectedDailyFees = expectedDailyFee;
    }

    this.lastPrice = currentPrice;
  }

  // Backward compatibility - converts hours to days
  recordDay(currentDate: Date, currentPrice: Price, inRange: boolean, rangeWidth: number, feesEarned?: number, expectedDailyFee?: number): void {
    // Convert daily fee to hourly for internal tracking
    const hourlyFee = feesEarned !== undefined ? feesEarned / 24 : undefined;
    const hourlyExpectedFee = expectedDailyFee !== undefined ? expectedDailyFee / 24 : undefined;
    this.recordHour(currentDate, currentPrice, inRange, rangeWidth, hourlyFee, hourlyExpectedFee);
  }

  recordRebalance(date: Date, reason: string, priceBefore: Price, priceAfter: Price): void {
    // percentageChange returns (other - this) / this * 100
    const priceChange = priceBefore.percentageChange(priceAfter);
    this.rebalanceEvents.push({
      date,
      reason,
      priceBefore,
      priceAfter,
      priceChange,
    });
  }

  recordIL(ilPercent: number): void {
    // Track maximum IL experienced (most negative = worst loss)
    // ilPercent is negative for losses, so we track the most negative value
    if (ilPercent < this.maxIL) {
      this.maxIL = ilPercent;
    }
  }

  getMetrics(calculateCurrentIL?: (entryPrice: Price, currentPrice: Price) => number): PositionMetrics | null {
    if (!this.entryDate || !this.entryPrice || !this.lastPrice) {
      return null;
    }

    const totalPriceChange = this.entryPrice.percentageChange(this.lastPrice);
    
    // Calculate current IL from entry price to current price
    // If calculator provided, use it; otherwise calculate directly
    let currentIL = 0;
    if (calculateCurrentIL) {
      currentIL = calculateCurrentIL(this.entryPrice, this.lastPrice);
    } else {
      // Simple IL calculation: 2 * sqrt(price_ratio) / (1 + price_ratio) - 1
      const priceRatio = this.lastPrice.value / this.entryPrice.value;
      const sqrtRatio = Math.sqrt(priceRatio);
      currentIL = ((2 * sqrtRatio) / (1 + priceRatio) - 1) * 100;
    }

    const totalHours = this.hoursInRange + this.hoursOutOfRange;
    const totalDays = totalHours / 24; // Convert hours to days for display
    const daysInRange = this.hoursInRange / 24;
    const daysOutOfRange = this.hoursOutOfRange / 24;
    const feeCaptureEfficiency = totalHours > 0 ? (this.hoursInRange / totalHours) * 100 : 0;
    
    // Calculate expected fees if always in range (expectedDailyFees is per day, so multiply by days)
    const expectedFees = this.expectedDailyFees * totalDays;
    const feeCaptureRate = expectedFees > 0 ? (this.totalFeesEarned / expectedFees) * 100 : 0;

    return {
      entryDate: this.entryDate,
      entryPrice: this.entryPrice,
      currentPrice: this.lastPrice,
      totalPriceChange,
      rebalanceCount: this.rebalanceEvents.length,
      rebalanceEvents: [...this.rebalanceEvents],
      currentIL, // Current IL from entry
      maxIL: this.maxIL, // Worst IL experienced
      hoursInRange: this.hoursInRange,
      hoursOutOfRange: this.hoursOutOfRange,
      daysInRange,
      daysOutOfRange,
      maxPriceDeviation: this.maxDeviation,
      minPriceDeviation: this.minDeviation,
      feeCaptureEfficiency,
      totalFeesEarned: this.totalFeesEarned,
      expectedFees,
      feeCaptureRate,
    };
  }
}

