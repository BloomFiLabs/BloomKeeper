import { Amount, Price, APR, IV, FundingRate, PnL } from '../value-objects';
import { Position } from './Position';
import { Trade } from './Trade';

// Forward declaration to avoid circular dependency
export interface Portfolio {
  id: string;
  positions: Position[];
  cash: Amount;
  addPosition(position: Position, cost?: Amount): void;
  removePosition(positionId: string): void;
  getPosition(positionId: string): Position | undefined;
  updatePosition(position: Position): void;
  totalValue(): Amount;
  totalPnL(): PnL;
}

export interface StrategyConfig {
  [key: string]: unknown;
}

export interface MarketData {
  price: Price;
  timestamp: Date;
  iv?: IV;
  fundingRate?: FundingRate;
  volume?: Amount;
  [key: string]: unknown;
}

export interface StrategyResult {
  trades: Trade[];
  positions: Position[];
  shouldRebalance: boolean;
  rebalanceReason?: string;
}

export interface Strategy {
  id: string;
  name: string;
  execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult>;
  calculateExpectedYield(config: StrategyConfig, marketData: MarketData): APR;
  validateConfig(config: StrategyConfig): boolean;
}

// Base abstract class for strategies
export abstract class BaseStrategy implements Strategy {
  constructor(
    public readonly id: string,
    public readonly name: string
  ) {}

  abstract execute(
    portfolio: Portfolio,
    marketData: MarketData,
    config: StrategyConfig
  ): Promise<StrategyResult>;

  abstract calculateExpectedYield(config: StrategyConfig, marketData: MarketData): APR;

  abstract validateConfig(config: StrategyConfig): boolean;

  protected createTrade(
    strategyId: string,
    asset: string,
    side: 'buy' | 'sell',
    amount: Amount,
    price: Price,
    timestamp: Date,
    fees?: Amount,
    slippage?: Amount
  ): Trade {
    return Trade.create({
      id: `${strategyId}-${Date.now()}-${Math.random()}`,
      strategyId,
      asset,
      side,
      amount,
      price,
      timestamp,
      fees,
      slippage,
    });
  }
}

