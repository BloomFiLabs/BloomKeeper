# Bloom Strategy System

A modular, TDD-driven strategy execution framework for the Bloom bot.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     StrategyOrchestrator                        │
│  - Registers strategies                                          │
│  - Executes all strategies on interval                          │
│  - Aggregates metrics and results                               │
│  - Handles emergency exits                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ FundingRate     │  │ DeltaNeutral    │  │ Future          │
│ Strategy        │  │ Funding         │  │ Strategies...   │
│ (HyperEVM)      │  │ Strategy        │  │                 │
│                 │  │ (HyperEVM)      │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Strategy Interface

Every strategy implements `IExecutableStrategy`:

```typescript
interface IExecutableStrategy {
  readonly name: string;
  readonly chainId: number;
  readonly contractAddress: string;
  
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  
  execute(): Promise<StrategyExecutionResult>;
  getMetrics(): Promise<Record<string, number | string>>;
  emergencyExit(): Promise<string>;
}
```

## Implemented Strategies

### 1. FundingRateStrategy (HyperEVM - Chain 999)

Captures funding rate payments on Hyperliquid perpetual markets.

**Logic:**
- When funding rate is positive (longs pay shorts) → Go SHORT
- When funding rate is negative (shorts pay longs) → Go LONG
- Close/flip position when funding rate reverses

**Config:**
```typescript
{
  name: 'ETH Funding Rate',
  chainId: 999,
  contractAddress: '0x247062659f997BDb5975b984c2bE2aDF87661314',
  asset: 'ETH',
  minFundingRateThreshold: 0.0001, // 0.01% per 8h ≈ 10% APY
  maxPositionSize: 10000,
  targetLeverage: 1,
}
```

### 2. DeltaNeutralFundingStrategy (HyperEVM - Chain 999)

Delta-neutral funding rate capture with leveraged positions on HyperLend.

**Logic:**
1. Deposit collateral to HyperLend
2. Borrow to leverage position
3. Open opposite perpetual position on HyperLiquid to hedge
4. Capture funding rate payments while maintaining delta neutrality

**Config:**
```typescript
{
  name: 'Delta-Neutral ETH Funding',
  chainId: 999,
  contractAddress: '0xYourStrategyAddress',
  vaultAddress: '0x...',
  hyperLendPool: '0x...',
  asset: 'ETH',
  assetId: 4,
  riskParams: {
    minHealthFactor: 1.5,
    targetHealthFactor: 2.0,
    maxLeverage: 5,
  },
  fundingParams: {
    minFundingRateThreshold: 0.0001,
    fundingFlipThreshold: -0.00005,
    minAnnualizedAPY: 10,
  },
}
```

## Usage

```typescript
import { StrategyOrchestrator, FundingRateStrategy, DeltaNeutralFundingStrategy } from './strategies';

// Create orchestrator
const orchestrator = new StrategyOrchestrator();

// Register strategies
orchestrator.registerStrategy(new FundingRateStrategy(config, fundingProvider, executor));
orchestrator.registerStrategy(new DeltaNeutralFundingStrategy(config, provider, wallet));

// Execute all strategies (call on interval)
const results = await orchestrator.executeAll();

// Get metrics from all strategies
const metrics = await orchestrator.getAllMetrics();

// Emergency exit all
await orchestrator.emergencyExitAll();
```

## Testing

All strategies are developed using TDD with comprehensive test coverage:

```bash
npm test -- --testPathPatterns="strategies"
```

## Adding New Strategies

1. Create `NewStrategy.spec.ts` with tests first
2. Implement `NewStrategy.ts` implementing `IExecutableStrategy`
3. Register with orchestrator

```typescript
class NewStrategy implements IExecutableStrategy {
  readonly name = 'My New Strategy';
  readonly chainId = 8453;
  readonly contractAddress = '0x...';
  
  async execute(): Promise<StrategyExecutionResult> {
    // 1. Fetch market data
    // 2. Analyze conditions
    // 3. Decide action
    // 4. Execute if needed
    return { strategyName: this.name, executed: true, action: 'BUY', reason: '...' };
  }
  
  // ... implement other methods
}
```

## Deployed Contracts

### HyperEVM (Chain 999)
- **BloomStrategyVault**: `0x7Eedc4088b197B4EE05BBB00B8c957C411B533Df`
- **HyperEVMFundingStrategy**: `0x247062659f997BDb5975b984c2bE2aDF87661314`
- **USDC**: `0xb88339CB7199b77E23DB6E890353E22632Ba630f`

### HyperEVM (Chain 999)
- **DeltaNeutralFundingStrategy**: Configured via `strategies.json`







