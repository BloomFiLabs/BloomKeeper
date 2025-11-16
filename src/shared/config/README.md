# Strategy Configuration

This directory contains centralized configuration for all backtesting strategies.

## Overview

The `StrategyConfigs.ts` file provides:

1. **Default configurations** for each strategy type
2. **Type-safe configuration interfaces**
3. **Helper functions** to merge user configs with defaults
4. **Single source of truth** for all strategy parameters

## Usage

### Using Default Configurations

```typescript
import { getDefaultConfig } from '@shared/config/StrategyConfigs';

// Get default config for stable pair strategy
const config = getDefaultConfig('stable-pair');
```

### Merging with Defaults

```typescript
import { mergeWithDefaults } from '@shared/config/StrategyConfigs';

// Override only specific parameters
const customConfig = mergeWithDefaults('stable-pair', {
  pair: 'DAI-USDC',
  leverage: 2.5,
  allocation: 0.3,
});
```

### Normalizing Configuration

```typescript
import { normalizeConfig } from '@shared/config/StrategyConfigs';

// Ensures all required fields are present with defaults
const normalized = normalizeConfig('volatile-pair', {
  pair: 'BTC-USDC',
  // Other fields will use defaults
});
```

## Available Strategy Types

- `'stable-pair'` - StablePairConfig
- `'volatile-pair'` - VolatilePairConfig
- `'leveraged-lending'` - LeveragedLendingConfig
- `'funding-rate'` - FundingRateConfig
- `'options-overlay'` - OptionsOverlayConfig
- `'iv-regime'` - IVRegimeConfig
- `'rwa-carry'` - LeveragedRWAConfig

## Configuration Parameters

### Stable Pair Strategy
- `pair`: Trading pair (e.g., 'USDC-USDT')
- `rangeWidth`: Range width (e.g., 0.002 for ±0.2%)
- `leverage`: Leverage multiplier (default: 2.0)
- `collateralRatio`: Collateral ratio (default: 1.6)
- `allocation`: Portfolio allocation (0-1)
- `ammFeeAPR`: AMM fee APR percentage
- `incentiveAPR`: Incentive APR percentage
- `borrowAPR`: Borrow cost APR percentage

### Volatile Pair Strategy
- `pair`: Trading pair
- `rangeWidth`: Range width (e.g., 0.05 for ±5%)
- `hedgeRatio`: Hedge ratio for delta neutrality (default: 1.0)
- `allocation`: Portfolio allocation
- `ammFeeAPR`: AMM fee APR
- `incentiveAPR`: Incentive APR
- `fundingAPR`: Funding rate APR

### Leveraged Lending Strategy
- `asset`: Asset to lend (e.g., 'USDC')
- `loops`: Number of recursive loops (default: 3)
- `healthFactorThreshold`: Health factor threshold (default: 1.5)
- `borrowAPR`: Borrow APR
- `supplyAPR`: Supply APR
- `incentiveAPR`: Incentive APR
- `allocation`: Portfolio allocation

### Funding Rate Capture Strategy
- `asset`: Asset for funding rate capture
- `fundingThreshold`: Minimum funding rate threshold
- `leverage`: Leverage multiplier
- `healthFactorThreshold`: Health factor threshold
- `allocation`: Portfolio allocation

### Options Overlay Strategy
- `pair`: Trading pair
- `lpRangeWidth`: LP range width
- `optionStrikeDistance`: Distance of option strikes from LP band
- `optionTenor`: Option tenor in days (default: 7)
- `overlaySizing`: Fraction of LP notional for options
- `allocation`: Portfolio allocation

### IV Regime Switcher Strategy
- `lowIVThreshold`: Low IV threshold (default: 30)
- `highIVThreshold`: High IV threshold (default: 70)
- `hysteresis`: Hysteresis in IV points (default: 5)
- `minHoldPeriod`: Minimum hold period in days (default: 3)
- `allocation`: Portfolio allocation

### Leveraged RWA Carry Strategy
- `rwaVault`: RWA vault identifier
- `couponRate`: Coupon rate percentage
- `leverage`: Leverage multiplier
- `borrowAPR`: Borrow APR
- `healthFactorThreshold`: Health factor threshold
- `allocation`: Portfolio allocation
- `maturityDays`: Maturity in days

## Example: Creating a Backtest Configuration

```typescript
import { getDefaultConfig, mergeWithDefaults } from '@shared/config/StrategyConfigs';
import { StablePairStrategy } from '@infrastructure/adapters/strategies';

// Option 1: Use defaults
const defaultConfig = getDefaultConfig('stable-pair');
const strategy = new StablePairStrategy('stable-1', 'My Stable Pair');
await strategy.execute(portfolio, marketData, defaultConfig);

// Option 2: Customize specific parameters
const customConfig = mergeWithDefaults('stable-pair', {
  pair: 'DAI-USDC',
  leverage: 2.5,
});
await strategy.execute(portfolio, marketData, customConfig);
```

