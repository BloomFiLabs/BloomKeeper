import { ArbitrageOpportunity } from '../FundingRateAggregator';

export interface PortfolioAllocation {
  allocations: Map<string, number>; // symbol -> allocation amount
  totalPortfolio: number;
  aggregateAPY: number;
  opportunityCount: number;
  dataQualityWarnings: string[];
}

export interface PortfolioOptimizationInput {
  opportunity: ArbitrageOpportunity;
  maxPortfolioFor35APY: number | null;
  optimalLeverage?: number; // Optimal leverage for this position (from OptimalLeverageService)
  longBidAsk: { bestBid: number; bestAsk: number };
  shortBidAsk: { bestBid: number; bestAsk: number };
}

export interface MaxPortfolioWithLeverage {
  maxPortfolio: number;
  optimalLeverage: number;
  requiredCollateral: number;
  estimatedAPY: number;
}

export interface IPortfolioOptimizer {
  calculateMaxPortfolioForTargetAPY(
    opportunity: ArbitrageOpportunity,
    longBidAsk: { bestBid: number; bestAsk: number },
    shortBidAsk: { bestBid: number; bestAsk: number },
    targetNetAPY?: number,
  ): Promise<number | null>;

  /**
   * Calculate max portfolio with optimal leverage
   * Returns both the max position size AND the optimal leverage to use
   */
  calculateMaxPortfolioWithLeverage(
    opportunity: ArbitrageOpportunity,
    longBidAsk: { bestBid: number; bestAsk: number },
    shortBidAsk: { bestBid: number; bestAsk: number },
    targetNetAPY?: number,
  ): Promise<MaxPortfolioWithLeverage | null>;

  calculateOptimalAllocation(
    opportunities: PortfolioOptimizationInput[],
    totalCapital: number | null,
    targetAggregateAPY?: number,
  ): Promise<PortfolioAllocation>;

  calculateDataQualityRiskFactor(
    opportunity: ArbitrageOpportunity,
  ): number;

  validateHistoricalDataQuality(
    opportunity: ArbitrageOpportunity,
    historicalSpread: number,
  ): { isValid: boolean; reason?: string };
}

