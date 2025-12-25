import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { PerpPosition } from '../../entities/PerpPosition';
import { DiagnosticsService } from '../../../infrastructure/services/DiagnosticsService';
import { ExecutionLockService, ActiveOrder } from '../../../infrastructure/services/ExecutionLockService';

/**
 * PositionExpectation - What we expect a position to be
 */
export interface PositionExpectation {
  symbol: string;
  exchange: ExchangeType;
  side: 'LONG' | 'SHORT';
  expectedSize: number;
  orderId?: string;
  placedAt: Date;
  lastChecked?: Date;
  verified: boolean;
}

/**
 * ReconciliationResult - Result of a reconciliation check
 */
export interface ReconciliationResult {
  symbol: string;
  exchange: ExchangeType;
  status: 'MATCHED' | 'PARTIAL_FILL' | 'NO_FILL' | 'OVERFILL' | 'ORPHAN' | 'ERROR';
  expectedSize: number;
  actualSize: number;
  discrepancy: number;
  discrepancyPercent: number;
  action?: 'NONE' | 'CANCEL_ORDER' | 'CLOSE_POSITION' | 'ALERT';
  message?: string;
}

/**
 * HedgePairStatus - Status of a hedged position pair
 */
export interface HedgePairStatus {
  symbol: string;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  longSize: number;
  shortSize: number;
  imbalance: number;
  imbalancePercent: number;
  isBalanced: boolean;
  lastReconciled: Date;
}

/**
 * ReconciliationService - Continuously verifies positions match expectations
 * 
 * This service:
 * 1. Tracks expected positions from order placement
 * 2. Polls exchanges for actual positions
 * 3. Detects discrepancies (partial fills, no fills, orphans)
 * 4. Triggers corrective actions
 * 5. Maintains hedge pair balance tracking
 */
@Injectable()
export class ReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationService.name);

  // Expected positions from orders we've placed
  private readonly expectations: Map<string, PositionExpectation> = new Map();
  
  // Actual positions from exchanges (cache)
  private readonly actualPositions: Map<string, PerpPosition> = new Map();
  
  // Hedge pair tracking
  private readonly hedgePairs: Map<string, HedgePairStatus> = new Map();
  
  // Exchange adapters
  private adapters: Map<ExchangeType, IPerpExchangeAdapter> = new Map();
  
  // Recent reconciliation results for diagnostics
  private readonly recentResults: ReconciliationResult[] = [];
  private readonly MAX_RECENT_RESULTS = 50;

  // Configuration
  private readonly RECONCILIATION_INTERVAL_MS = 5000; // 5 seconds
  private readonly STALE_EXPECTATION_MS = 5 * 60 * 1000; // 5 minutes
  private readonly IMBALANCE_THRESHOLD_PERCENT = 5; // 5% imbalance triggers alert

  constructor(
    private readonly diagnosticsService?: DiagnosticsService,
    private readonly executionLockService?: ExecutionLockService,
  ) {}

  onModuleInit() {
    this.logger.log('ReconciliationService initialized');
  }

  /**
   * Register exchange adapters
   */
  setAdapters(adapters: Map<ExchangeType, IPerpExchangeAdapter>): void {
    this.adapters = adapters;
    this.logger.log(`Registered ${adapters.size} exchange adapters for reconciliation`);
  }

  /**
   * Register an expected position from an order placement
   */
  registerExpectation(
    symbol: string,
    exchange: ExchangeType,
    side: 'LONG' | 'SHORT',
    expectedSize: number,
    orderId?: string,
  ): void {
    const key = `${exchange}-${symbol}-${side}`;
    
    this.expectations.set(key, {
      symbol,
      exchange,
      side,
      expectedSize,
      orderId,
      placedAt: new Date(),
      verified: false,
    });

    this.logger.debug(
      `📋 Registered expectation: ${exchange} ${symbol} ${side} ${expectedSize.toFixed(4)}`
    );
  }

  /**
   * Clear an expectation (order cancelled or position closed)
   */
  clearExpectation(
    symbol: string,
    exchange: ExchangeType,
    side: 'LONG' | 'SHORT',
  ): void {
    const key = `${exchange}-${symbol}-${side}`;
    this.expectations.delete(key);
    this.logger.debug(`🗑️ Cleared expectation: ${exchange} ${symbol} ${side}`);
  }

  /**
   * Mark an expectation as verified (position confirmed)
   */
  markVerified(
    symbol: string,
    exchange: ExchangeType,
    side: 'LONG' | 'SHORT',
    actualSize: number,
  ): void {
    const key = `${exchange}-${symbol}-${side}`;
    const expectation = this.expectations.get(key);
    
    if (expectation) {
      expectation.verified = true;
      expectation.lastChecked = new Date();
      // Update expected size to actual (in case of partial fill)
      expectation.expectedSize = actualSize;
    }
  }

  /**
   * Register a hedge pair for tracking
   */
  registerHedgePair(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    expectedSize: number,
  ): void {
    this.hedgePairs.set(symbol, {
      symbol,
      longExchange,
      shortExchange,
      longSize: expectedSize,
      shortSize: expectedSize,
      imbalance: 0,
      imbalancePercent: 0,
      isBalanced: true,
      lastReconciled: new Date(),
    });

    this.logger.debug(
      `📊 Registered hedge pair: ${symbol} (LONG@${longExchange}, SHORT@${shortExchange})`
    );
  }

  /**
   * Main reconciliation loop - runs every 5 seconds
   */
  @Interval(5000)
  async reconcile(): Promise<void> {
    if (this.adapters.size === 0) {
      return; // No adapters registered yet
    }

    try {
      // 1. Fetch actual positions from all exchanges
      await this.fetchActualPositions();

      // 2. Check each expectation against actual
      await this.checkExpectations();

      // 3. Check hedge pair balances
      await this.checkHedgePairBalances();

      // 4. Clean up stale expectations
      this.cleanupStaleExpectations();

    } catch (error: any) {
      this.logger.error(`Reconciliation error: ${error.message}`);
    }
  }

  /**
   * Fetch actual positions from all exchanges
   */
  private async fetchActualPositions(): Promise<void> {
    const fetchPromises: Promise<void>[] = [];

    for (const [exchange, adapter] of this.adapters) {
      fetchPromises.push(
        adapter.getPositions()
          .then(positions => {
            for (const pos of positions) {
              if (Math.abs(pos.size) > 0.0001) {
                const key = `${exchange}-${pos.symbol}-${pos.side}`;
                this.actualPositions.set(key, pos);
              }
            }
          })
          .catch(error => {
            this.logger.warn(`Failed to fetch positions from ${exchange}: ${error.message}`);
          })
      );
    }

    await Promise.all(fetchPromises);
  }

  /**
   * Check expectations against actual positions
   */
  private async checkExpectations(): Promise<void> {
    for (const [key, expectation] of this.expectations) {
      const actual = this.actualPositions.get(key);
      const actualSize = actual ? Math.abs(actual.size) : 0;
      const discrepancy = actualSize - expectation.expectedSize;
      const discrepancyPercent = expectation.expectedSize > 0 
        ? (discrepancy / expectation.expectedSize) * 100 
        : (actualSize > 0 ? 100 : 0);

      let status: ReconciliationResult['status'];
      let action: ReconciliationResult['action'] = 'NONE';
      let message: string | undefined;

      if (Math.abs(discrepancyPercent) < 2) {
        status = 'MATCHED';
        expectation.verified = true;
      } else if (actualSize === 0) {
        status = 'NO_FILL';
        const age = Date.now() - expectation.placedAt.getTime();
        if (age > 60000) { // > 1 minute
          action = 'CANCEL_ORDER';
          message = `Order ${expectation.orderId} not filled after ${Math.round(age / 1000)}s`;
        }
      } else if (actualSize < expectation.expectedSize * 0.95) {
        status = 'PARTIAL_FILL';
        message = `Only ${((actualSize / expectation.expectedSize) * 100).toFixed(0)}% filled`;
      } else if (actualSize > expectation.expectedSize * 1.05) {
        status = 'OVERFILL';
        action = 'ALERT';
        message = `Position larger than expected by ${discrepancyPercent.toFixed(1)}%`;
      } else {
        status = 'MATCHED';
        expectation.verified = true;
      }

      const result: ReconciliationResult = {
        symbol: expectation.symbol,
        exchange: expectation.exchange,
        status,
        expectedSize: expectation.expectedSize,
        actualSize,
        discrepancy,
        discrepancyPercent,
        action,
        message,
      };

      this.recordResult(result);

      // Take action if needed
      if (action !== 'NONE') {
        await this.handleDiscrepancy(result, expectation);
      }

      expectation.lastChecked = new Date();
    }
  }

  /**
   * Check hedge pair balances
   */
  private async checkHedgePairBalances(): Promise<void> {
    for (const [symbol, pair] of this.hedgePairs) {
      const longKey = `${pair.longExchange}-${symbol}-LONG`;
      const shortKey = `${pair.shortExchange}-${symbol}-SHORT`;

      const longPos = this.actualPositions.get(longKey);
      const shortPos = this.actualPositions.get(shortKey);

      const longSize = longPos ? Math.abs(longPos.size) : 0;
      const shortSize = shortPos ? Math.abs(shortPos.size) : 0;

      const imbalance = Math.abs(longSize - shortSize);
      const avgSize = (longSize + shortSize) / 2;
      const imbalancePercent = avgSize > 0 ? (imbalance / avgSize) * 100 : 0;

      pair.longSize = longSize;
      pair.shortSize = shortSize;
      pair.imbalance = imbalance;
      pair.imbalancePercent = imbalancePercent;
      pair.isBalanced = imbalancePercent < this.IMBALANCE_THRESHOLD_PERCENT;
      pair.lastReconciled = new Date();

      if (!pair.isBalanced) {
        this.logger.warn(
          `⚠️ Hedge pair ${symbol} IMBALANCED: ` +
          `LONG=${longSize.toFixed(4)}@${pair.longExchange}, ` +
          `SHORT=${shortSize.toFixed(4)}@${pair.shortExchange} ` +
          `(${imbalancePercent.toFixed(1)}% imbalance)`
        );

        // Record to diagnostics
        if (this.diagnosticsService) {
          this.diagnosticsService.recordPositionDrift(
            symbol,
            pair.longExchange,
            pair.shortExchange,
            longSize,
            shortSize,
          );
        }
      }
    }
  }

  /**
   * Handle a discrepancy
   */
  private async handleDiscrepancy(
    result: ReconciliationResult,
    expectation: PositionExpectation,
  ): Promise<void> {
    const adapter = this.adapters.get(result.exchange);
    if (!adapter) return;

    switch (result.action) {
      case 'CANCEL_ORDER':
        if (expectation.orderId) {
          try {
            await adapter.cancelOrder(expectation.orderId, result.symbol);
            this.logger.log(`🗑️ Cancelled unfilled order ${expectation.orderId} for ${result.symbol}`);
            this.clearExpectation(result.symbol, result.exchange, expectation.side);
          } catch (error: any) {
            this.logger.warn(`Failed to cancel order: ${error.message}`);
          }
        }
        break;

      case 'CLOSE_POSITION':
        // This would be handled by PerpKeeperScheduler's nuclear option
        this.logger.warn(
          `🚨 Position ${result.symbol} on ${result.exchange} needs closing - ` +
          `delegating to PerpKeeperScheduler`
        );
        break;

      case 'ALERT':
        this.logger.warn(`🚨 ALERT: ${result.message}`);
        if (this.diagnosticsService) {
          this.diagnosticsService.recordError({
            type: 'RECONCILIATION_ALERT',
            message: result.message || 'Position discrepancy detected',
            exchange: result.exchange,
            symbol: result.symbol,
            timestamp: new Date(),
            context: { result },
          });
        }
        break;
    }
  }

  /**
   * Clean up stale expectations
   */
  private cleanupStaleExpectations(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, expectation] of this.expectations) {
      const age = now - expectation.placedAt.getTime();
      
      // Remove verified expectations after 1 minute
      if (expectation.verified && age > 60000) {
        keysToDelete.push(key);
        continue;
      }

      // Remove unverified expectations after STALE_EXPECTATION_MS
      if (!expectation.verified && age > this.STALE_EXPECTATION_MS) {
        this.logger.warn(
          `🗑️ Removing stale expectation: ${key} (age: ${Math.round(age / 1000)}s, never verified)`
        );
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.expectations.delete(key);
    }
  }

  /**
   * Record a reconciliation result
   */
  private recordResult(result: ReconciliationResult): void {
    this.recentResults.push(result);
    
    if (this.recentResults.length > this.MAX_RECENT_RESULTS) {
      this.recentResults.shift();
    }

    if (result.status !== 'MATCHED') {
      this.logger.debug(
        `📊 Reconciliation: ${result.exchange} ${result.symbol} - ${result.status} ` +
        `(expected: ${result.expectedSize.toFixed(4)}, actual: ${result.actualSize.toFixed(4)})`
      );
    }
  }

  /**
   * Get current hedge pair statuses
   */
  getHedgePairStatuses(): HedgePairStatus[] {
    return Array.from(this.hedgePairs.values());
  }

  /**
   * Get recent reconciliation results
   */
  getRecentResults(): ReconciliationResult[] {
    return [...this.recentResults];
  }

  /**
   * Get unverified expectations (potential issues)
   */
  getUnverifiedExpectations(): PositionExpectation[] {
    return Array.from(this.expectations.values()).filter(e => !e.verified);
  }

  /**
   * Get summary for diagnostics
   */
  getSummary(): {
    totalExpectations: number;
    verifiedExpectations: number;
    hedgePairs: number;
    imbalancedPairs: number;
    recentDiscrepancies: number;
  } {
    const verified = Array.from(this.expectations.values()).filter(e => e.verified).length;
    const imbalanced = Array.from(this.hedgePairs.values()).filter(p => !p.isBalanced).length;
    const discrepancies = this.recentResults.filter(
      r => r.status !== 'MATCHED' && Date.now() - 60000 < Date.now()
    ).length;

    return {
      totalExpectations: this.expectations.size,
      verifiedExpectations: verified,
      hedgePairs: this.hedgePairs.size,
      imbalancedPairs: imbalanced,
      recentDiscrepancies: discrepancies,
    };
  }
}

