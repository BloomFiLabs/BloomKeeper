import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { PerpOrderRequest, OrderSide, OrderType } from '../value-objects/PerpOrder';
import { PerpPosition } from '../entities/PerpPosition';
import { FundingRateAggregator, ArbitrageOpportunity, ExchangeSymbolMapping } from './FundingRateAggregator';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';

/**
 * Execution plan for an arbitrage opportunity
 */
export interface ArbitrageExecutionPlan {
  opportunity: ArbitrageOpportunity;
  longOrder: PerpOrderRequest;
  shortOrder: PerpOrderRequest;
  positionSize: number; // Position size in base asset
  estimatedCosts: {
    fees: number;
    slippage: number;
    total: number;
  };
  expectedNetReturn: number; // After costs
  timestamp: Date;
}

/**
 * Strategy execution result
 */
export interface ArbitrageExecutionResult {
  success: boolean;
  opportunitiesEvaluated: number;
  opportunitiesExecuted: number;
  totalExpectedReturn: number;
  ordersPlaced: number;
  errors: string[];
  timestamp: Date;
}

/**
 * FundingArbitrageStrategy - Implements arbitrage-focused decision logic
 */
@Injectable()
export class FundingArbitrageStrategy {
  private readonly logger = new Logger(FundingArbitrageStrategy.name);

  // Default configuration
  private readonly DEFAULT_MIN_SPREAD = 0.0001; // 0.01% minimum spread
  private readonly MIN_POSITION_SIZE_USD = 10; // Minimum $10 to cover fees (very small for testing)
  private readonly BALANCE_USAGE_PERCENT = 0.9; // Use 90% of available balance (leave 10% buffer)
  private readonly leverage: number; // Leverage multiplier (configurable via KEEPER_LEVERAGE env var)

  // Exchange-specific fee rates (taker fees for market orders)
  // Hyperliquid: Tier 0 (≤ $5M 14D volume) - Perps Taker: 0.0450%
  // Aster: Taker 0.0400%, Maker 0.0050% (using taker for market orders)
  // Lighter: 0% maker/taker fees (no trading fees)
  private readonly EXCHANGE_FEE_RATES: Map<ExchangeType, number> = new Map([
    [ExchangeType.HYPERLIQUID, 0.00045], // 0.0450% taker fee (tier 0)
    [ExchangeType.ASTER, 0.0004],        // 0.0400% taker fee
    [ExchangeType.LIGHTER, 0],            // 0% fees (no trading fees)
  ]);

  constructor(
    private readonly aggregator: FundingRateAggregator,
    private readonly configService: ConfigService,
  ) {
    // Get leverage from config, default to 2.0x
    // Leverage improves net returns: 2x leverage = 2x funding returns, but fees stay same %
    // Example: $100 capital, 2x leverage = $200 notional, 10% APY = $20/year vs $10/year (2x improvement)
    this.leverage = parseFloat(
      this.configService.get<string>('KEEPER_LEVERAGE') || '2.0'
    );
    this.logger.log(`Funding arbitrage strategy initialized with ${this.leverage}x leverage`);
  }

  /**
   * Create execution plan for an arbitrage opportunity (with pre-fetched balances)
   * @param opportunity The arbitrage opportunity
   * @param adapters Map of exchange adapters
   * @param maxPositionSizeUsd Optional maximum position size
   * @param longMarkPrice Optional mark price for long exchange (from funding rate data)
   * @param shortMarkPrice Optional mark price for short exchange (from funding rate data)
   * @param longBalance Pre-fetched balance for long exchange (to reduce API calls)
   * @param shortBalance Pre-fetched balance for short exchange (to reduce API calls)
   */
  private async createExecutionPlanWithBalances(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    maxPositionSizeUsd: number | undefined,
    longMarkPrice: number | undefined,
    shortMarkPrice: number | undefined,
    longBalance: number,
    shortBalance: number,
  ): Promise<ArbitrageExecutionPlan | null> {
    try {
      const longAdapter = adapters.get(opportunity.longExchange);
      const shortAdapter = adapters.get(opportunity.shortExchange);

      if (!longAdapter || !shortAdapter) {
        this.logger.warn(`Missing adapters for opportunity: ${opportunity.symbol}`);
        return null;
      }

      // Use pre-fetched balances (no API calls here!)

      // Use provided mark prices if available, otherwise fetch (but prefer cached)
      let finalLongMarkPrice = longMarkPrice;
      let finalShortMarkPrice = shortMarkPrice;

      if (!finalLongMarkPrice || finalLongMarkPrice === 0) {
        try {
          finalLongMarkPrice = await longAdapter.getMarkPrice(opportunity.symbol);
        } catch (error: any) {
          this.logger.debug(`Failed to get mark price for ${opportunity.symbol} on ${opportunity.longExchange}: ${error.message}`);
          return null; // Can't proceed without mark price
        }
      }

      if (!finalShortMarkPrice || finalShortMarkPrice === 0) {
        try {
          finalShortMarkPrice = await shortAdapter.getMarkPrice(opportunity.symbol);
        } catch (error: any) {
          this.logger.debug(`Failed to get mark price for ${opportunity.symbol} on ${opportunity.shortExchange}: ${error.message}`);
          return null; // Can't proceed without mark price
        }
      }

      // Determine position size based on actual available capital
      // Use the minimum balance between the two exchanges (can't trade more than the smaller balance)
      const minBalance = Math.min(longBalance, shortBalance);
      const availableCapital = minBalance * this.BALANCE_USAGE_PERCENT; // Use 90% of minimum balance
      
      // Apply leverage to increase position size (and returns)
      // Leverage multiplies both returns and position size, but fees stay the same percentage
      // So net returns improve with leverage (e.g., 2x leverage = 2x returns, same fee %)
      // Example: $100 capital, 2x leverage = $200 notional, 10% APY = $20/year vs $10/year (2x improvement)
      const leveragedCapital = availableCapital * this.leverage;
      
      // Apply max position size limit if specified (this is the leveraged size)
      const maxSize = maxPositionSizeUsd || Infinity; // No default max, use whatever balance is available
      
      // Calculate position size - must be at least MIN_POSITION_SIZE_USD to cover fees
      // Note: positionSizeUsd is the NOTIONAL size (with leverage), not the collateral
      let positionSizeUsd = Math.min(leveragedCapital, maxSize);
      
      // Log leverage usage for transparency
      if (this.leverage > 1) {
        this.logger.debug(
          `Using ${this.leverage}x leverage for ${opportunity.symbol}: ` +
          `Capital: $${availableCapital.toFixed(2)} → Notional: $${positionSizeUsd.toFixed(2)}`
        );
      }
      
      // Check if we have enough to cover minimum
      if (positionSizeUsd < this.MIN_POSITION_SIZE_USD) {
        this.logger.debug(
          `Insufficient balance for ${opportunity.symbol}: ` +
          `Need $${this.MIN_POSITION_SIZE_USD}, have $${positionSizeUsd.toFixed(2)} ` +
          `(Long: $${longBalance.toFixed(2)}, Short: $${shortBalance.toFixed(2)})`
        );
        return null; // Skip this opportunity
      }

      // Convert to base asset size
      const avgMarkPrice = (finalLongMarkPrice + finalShortMarkPrice) / 2;
      const positionSize = positionSizeUsd / avgMarkPrice;

      // Estimate costs using exchange-specific fee rates
      // Get fee rates for both exchanges (taker fees for market orders)
      const longFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.longExchange) || 0.0005; // Default 0.05% if unknown
      const shortFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.shortExchange) || 0.0005; // Default 0.05% if unknown
      
      // Calculate fees: entry fees on both exchanges (exit fees apply when closing, not included here)
      // We only account for entry fees since we're opening positions
      const longEntryFee = positionSizeUsd * longFeeRate;
      const shortEntryFee = positionSizeUsd * shortFeeRate;
      const totalEntryFees = longEntryFee + shortEntryFee;
      
      // For exit fees, we'll estimate them the same way (when closing positions)
      const totalExitFees = totalEntryFees; // Same calculation for exit
      
      // Total costs = entry + exit fees
      const totalCosts = totalEntryFees + totalExitFees;

      // Calculate expected return (annualized, then convert to per-period)
      // Funding rates are typically hourly (e.g., 0.0013% per hour ≈ 10% annualized)
      // With leverage, returns scale with leverage (2x leverage = 2x returns)
      const periodsPerDay = 24; // Hourly funding periods
      const periodsPerYear = periodsPerDay * 365;
      // Returns scale with leverage: if we use 2x leverage, we get 2x the funding rate returns
      // But fees are a percentage of notional, so they scale too, but net return still improves
      const expectedReturnPerPeriod = (opportunity.expectedReturn / periodsPerYear) * positionSizeUsd;
      const expectedNetReturn = expectedReturnPerPeriod - totalCosts;

      // Only proceed if net return is positive
      if (expectedNetReturn <= 0) {
        this.logger.debug(
          `Opportunity ${opportunity.symbol} rejected: ` +
          `Expected return per period: $${expectedReturnPerPeriod.toFixed(4)}, ` +
          `Total costs: $${totalCosts.toFixed(4)}, ` +
          `Net return: $${expectedNetReturn.toFixed(4)}`
        );
        return null;
      }

      this.logger.log(
        `✅ Execution plan created for ${opportunity.symbol}: ` +
        `Position size: $${positionSizeUsd.toFixed(2)}, ` +
        `Expected net return per period: $${expectedNetReturn.toFixed(4)}, ` +
        `Spread: ${(opportunity.spread * 100).toFixed(4)}%`
      );

      // Get exchange-specific symbol formats for order placement
      // Aster: needs "ETHUSDT" format
      // Lighter: needs normalized symbol, adapter will look up marketIndex
      // Hyperliquid: needs "ETH" format
      const longExchangeSymbol = this.aggregator.getExchangeSymbol(opportunity.symbol, opportunity.longExchange);
      const shortExchangeSymbol = this.aggregator.getExchangeSymbol(opportunity.symbol, opportunity.shortExchange);
      
      // For Lighter (marketIndex is number), we still pass normalized symbol and adapter handles lookup
      // For Aster/Hyperliquid (string symbols), we use the exchange-specific format
      const longSymbol = typeof longExchangeSymbol === 'string' 
        ? longExchangeSymbol 
        : opportunity.symbol; // For Lighter, use normalized symbol
      const shortSymbol = typeof shortExchangeSymbol === 'string' 
        ? shortExchangeSymbol 
        : opportunity.symbol; // For Lighter, use normalized symbol

      // Create order requests with exchange-specific symbol formats
      const longOrder = new PerpOrderRequest(
        longSymbol,
        OrderSide.LONG,
        OrderType.MARKET,
        positionSize,
      );

      const shortOrder = new PerpOrderRequest(
        shortSymbol,
        OrderSide.SHORT,
        OrderType.MARKET,
        positionSize,
      );

      return {
        opportunity,
        longOrder,
        shortOrder,
        positionSize,
        estimatedCosts: {
          fees: totalCosts,
          slippage: 0, // No slippage for now
          total: totalCosts,
        },
        expectedNetReturn,
        timestamp: new Date(),
      };
    } catch (error: any) {
      this.logger.error(`Failed to create execution plan: ${error.message}`);
      return null;
    }
  }

  /**
   * Create execution plan for an arbitrage opportunity (public method, fetches balances)
   * @param opportunity The arbitrage opportunity
   * @param adapters Map of exchange adapters
   * @param maxPositionSizeUsd Optional maximum position size
   * @param longMarkPrice Optional mark price for long exchange (from funding rate data)
   * @param shortMarkPrice Optional mark price for short exchange (from funding rate data)
   */
  async createExecutionPlan(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    maxPositionSizeUsd?: number,
    longMarkPrice?: number,
    shortMarkPrice?: number,
  ): Promise<ArbitrageExecutionPlan | null> {
    const longAdapter = adapters.get(opportunity.longExchange);
    const shortAdapter = adapters.get(opportunity.shortExchange);

    if (!longAdapter || !shortAdapter) {
      this.logger.warn(`Missing adapters for opportunity: ${opportunity.symbol}`);
      return null;
    }

    // Get available balances (with small delay to avoid rate limits)
    const [longBalance, shortBalance] = await Promise.all([
      longAdapter.getBalance(),
      shortAdapter.getBalance(),
    ]);

    return this.createExecutionPlanWithBalances(
      opportunity,
      adapters,
      maxPositionSizeUsd,
      longMarkPrice,
      shortMarkPrice,
      longBalance,
      shortBalance,
    );
  }

  /**
   * Execute arbitrage strategy
   */
  async executeStrategy(
    symbols: string[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    minSpread?: number,
    maxPositionSizeUsd?: number,
  ): Promise<ArbitrageExecutionResult> {
    const result: ArbitrageExecutionResult = {
      success: true,
      opportunitiesEvaluated: 0,
      opportunitiesExecuted: 0,
      totalExpectedReturn: 0,
      ordersPlaced: 0,
      errors: [],
      timestamp: new Date(),
    };

    try {
      // Find arbitrage opportunities
      const opportunities = await this.aggregator.findArbitrageOpportunities(
        symbols,
        minSpread || this.DEFAULT_MIN_SPREAD,
      );

      result.opportunitiesEvaluated = opportunities.length;

      this.logger.log(`Found ${opportunities.length} arbitrage opportunities`);

      if (opportunities.length === 0) {
        return result;
      }

      // Pre-fetch balances for all unique exchanges to reduce API calls
      // This batches balance calls instead of calling for each opportunity
      const uniqueExchanges = new Set<ExchangeType>();
      opportunities.forEach(opp => {
        uniqueExchanges.add(opp.longExchange);
        uniqueExchanges.add(opp.shortExchange);
      });

      const exchangeBalances = new Map<ExchangeType, number>();
      for (const exchange of uniqueExchanges) {
        const adapter = adapters.get(exchange);
        if (adapter) {
          try {
            const balance = await adapter.getBalance();
            exchangeBalances.set(exchange, balance);
            // Small delay between balance calls to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 50));
          } catch (error: any) {
            this.logger.warn(`Failed to get balance for ${exchange}: ${error.message}`);
            // Set to 0 so opportunities using this exchange will be skipped
            exchangeBalances.set(exchange, 0);
          }
        }
      }

      // Evaluate all opportunities and create execution plans
      // Process sequentially with delays to avoid rate limits
      // Mark prices are already included in the opportunity object from funding rate data
      // Then select the MOST PROFITABLE one (highest expected return)
      const executionPlans: Array<{ plan: ArbitrageExecutionPlan; opportunity: ArbitrageOpportunity }> = [];

      for (let i = 0; i < opportunities.length; i++) {
        const opportunity = opportunities[i];

        try {
          // Use pre-fetched balances instead of calling getBalance() in createExecutionPlan
          const plan = await this.createExecutionPlanWithBalances(
            opportunity,
            adapters,
            maxPositionSizeUsd,
            opportunity.longMarkPrice,
            opportunity.shortMarkPrice,
            exchangeBalances.get(opportunity.longExchange) ?? 0,
            exchangeBalances.get(opportunity.shortExchange) ?? 0,
          );

          if (plan) {
            executionPlans.push({ plan, opportunity });
          }
        } catch (error: any) {
          result.errors.push(`Error evaluating ${opportunity.symbol}: ${error.message}`);
          this.logger.debug(`Failed to evaluate opportunity ${opportunity.symbol}: ${error.message}`);
        }

        // Add delay between opportunity evaluations to avoid rate limits (except for last one)
        if (i < opportunities.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50)); // Reduced delay since balances are cached
        }
      }

      if (executionPlans.length === 0) {
        this.logger.warn('No valid execution plans created from opportunities');
        return result;
      }

      // Sort by expected net return (highest first) and select the BEST one
      executionPlans.sort((a, b) => b.plan.expectedNetReturn - a.plan.expectedNetReturn);
      const bestOpportunity = executionPlans[0];

      this.logger.log(
        `🎯 Selected BEST opportunity: ${bestOpportunity.opportunity.symbol} ` +
        `(Expected net return: $${bestOpportunity.plan.expectedNetReturn.toFixed(4)} per period, ` +
        `APY: ${(bestOpportunity.opportunity.expectedReturn * 100).toFixed(2)}%, ` +
        `Spread: ${(bestOpportunity.opportunity.spread * 100).toFixed(4)}%)`
      );

      // STEP 1: Close any existing positions before opening new ones
      // This ensures we don't have multiple positions open and properly close old positions
      // if the best opportunity is different from the currently deployed one
      this.logger.log('🔍 Checking for existing positions to close...');
      const allPositions = await this.getAllPositions(adapters);
      
      if (allPositions.length > 0) {
        this.logger.log(`Found ${allPositions.length} existing position(s) - closing before opening new opportunity...`);
        
        for (const position of allPositions) {
          try {
            const adapter = adapters.get(position.exchangeType);
            if (!adapter) {
              this.logger.warn(`No adapter found for ${position.exchangeType}, cannot close position`);
              continue;
            }

            // Close position by placing opposite order
            const closeOrder = new PerpOrderRequest(
              position.symbol,
              position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
              OrderType.MARKET,
              position.size,
            );

            this.logger.log(
              `📤 Closing position: ${position.symbol} ${position.side} ${position.size.toFixed(4)} on ${position.exchangeType}`
            );

            const closeResponse = await adapter.placeOrder(closeOrder);
            
            if (closeResponse.isSuccess()) {
              this.logger.log(`✅ Successfully closed position: ${position.symbol} on ${position.exchangeType}`);
            } else {
              this.logger.warn(
                `⚠️ Failed to close position ${position.symbol} on ${position.exchangeType}: ${closeResponse.error || 'unknown error'}`
              );
              result.errors.push(`Failed to close position ${position.symbol} on ${position.exchangeType}`);
            }

            // Small delay between closes to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (error: any) {
            this.logger.error(`Error closing position ${position.symbol} on ${position.exchangeType}: ${error.message}`);
            result.errors.push(`Error closing position ${position.symbol}: ${error.message}`);
          }
        }

        // Wait a bit after closing positions before opening new ones
        this.logger.log('⏳ Waiting 1 second after closing positions before opening new opportunity...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        this.logger.log('✅ No existing positions to close');
      }

      // Execute only the most profitable opportunity
      try {
        const { plan, opportunity } = bestOpportunity;
        
        // Get adapters
        const [longAdapter, shortAdapter] = [
          adapters.get(opportunity.longExchange),
          adapters.get(opportunity.shortExchange),
        ];

        if (!longAdapter || !shortAdapter) {
          result.errors.push(`Missing adapters for ${opportunity.symbol}`);
          this.logger.error(
            `Missing adapters: Long=${opportunity.longExchange} (${longAdapter ? 'OK' : 'MISSING'}), ` +
            `Short=${opportunity.shortExchange} (${shortAdapter ? 'OK' : 'MISSING'})`
          );
          return result;
        }

        // Place orders (in parallel for speed)
        this.logger.log(
          `📤 Executing orders for ${opportunity.symbol}: ` +
          `LONG ${plan.positionSize.toFixed(4)} on ${opportunity.longExchange}, ` +
          `SHORT ${plan.positionSize.toFixed(4)} on ${opportunity.shortExchange}`
        );

        const [longResponse, shortResponse] = await Promise.all([
          longAdapter.placeOrder(plan.longOrder),
          shortAdapter.placeOrder(plan.shortOrder),
        ]);

        if (longResponse.isSuccess() && shortResponse.isSuccess()) {
          result.opportunitiesExecuted = 1; // Only executed the best one
          result.ordersPlaced = 2;
          result.totalExpectedReturn = plan.expectedNetReturn;

          this.logger.log(
            `✅ Successfully executed arbitrage for ${opportunity.symbol}: ` +
            `LONG on ${opportunity.longExchange}, SHORT on ${opportunity.shortExchange} ` +
            `Expected return: $${plan.expectedNetReturn.toFixed(4)} per period ` +
            `(APY: ${(opportunity.expectedReturn * 100).toFixed(2)}%)`
          );
        } else {
          result.errors.push(
            `Order execution failed for ${opportunity.symbol}: ` +
            `Long: ${longResponse.error || 'unknown'}, Short: ${shortResponse.error || 'unknown'}`
          );
          this.logger.error(
            `❌ Order execution failed for ${opportunity.symbol}: ` +
            `Long success: ${longResponse.isSuccess()}, Short success: ${shortResponse.isSuccess()}`
          );
        }
      } catch (error: any) {
        result.errors.push(`Error executing best opportunity: ${error.message}`);
        this.logger.error(`Failed to execute best opportunity: ${error.message}`);
      }

      // Strategy is successful if it completes execution, even with some errors
      // Only mark as failed if there's a fatal error in the outer catch block
      result.success = true;
    } catch (error: any) {
      result.success = false;
      result.errors.push(`Strategy execution failed: ${error.message}`);
      this.logger.error(`Strategy execution error: ${error.message}`);
    }

    return result;
  }

  /**
   * Get all positions across all exchanges
   */
  private async getAllPositions(adapters: Map<ExchangeType, IPerpExchangeAdapter>): Promise<PerpPosition[]> {
    const allPositions: PerpPosition[] = [];

    for (const [exchangeType, adapter] of adapters) {
      try {
        const positions = await adapter.getPositions();
        allPositions.push(...positions);
      } catch (error: any) {
        this.logger.warn(`Failed to get positions from ${exchangeType}: ${error.message}`);
      }
    }

    return allPositions;
  }

  /**
   * Calculate next funding rate payment time
   * Most perpetual exchanges pay funding every hour at :00 minutes (e.g., 1:00, 2:00, 3:00)
   * Some pay every 8 hours at 00:00, 08:00, 16:00 UTC
   * This function returns the next payment time assuming hourly payments at :00
   */
  static getNextFundingPaymentTime(): Date {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0); // Next hour at :00:00
    return nextHour;
  }

  /**
   * Get milliseconds until next funding payment
   */
  static getMsUntilNextFundingPayment(): number {
    const nextPayment = this.getNextFundingPaymentTime();
    return nextPayment.getTime() - Date.now();
  }
}

