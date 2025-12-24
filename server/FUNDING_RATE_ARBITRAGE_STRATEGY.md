# Strategy Documentation: Perp-Perp Funding Rate Arbitrage

## 1. Executive Summary

This document outlines the technical specifications and economic model for a **delta-neutral arbitrage strategy** designed to extract yield from funding rate dispersion across perpetual futures exchanges.

The strategy operates by identifying funding rate differentials between venues (e.g., Hyperliquid vs. Lighter) and capturing the spread by holding offsetting long/short positions. Unlike single-venue strategies, this system exploits **cross-exchange inefficiencies** while maintaining strict Delta Neutrality (Δ ≈ 1) at all times.

**Key Performance Targets:**
- **Net APY Target:** 15–40% (regime-dependent)
- **Mechanism:** Perp-Perp arbitrage with dynamic leverage based on volatility
- **Break-Even Threshold:** Maximum 7 days to recover entry/exit costs
- **Advantage:** No spot inventory required; pure funding capture with minimal directional exposure

**Currently Active Exchanges:**
- **Hyperliquid** — Primary venue, hourly funding
- **Lighter** — Secondary venue, hourly funding
- **Aster** — Present in codebase but currently disabled

---

## 2. Core Strategy Mechanics

### 2.1 The Underlying Primitive

Perpetual futures contracts utilize a **Funding Rate (F)** mechanism to enforce price convergence with the spot asset.

- If **Perp > Spot** (F > 0): Longs pay Shorts
- If **Perp < Spot** (F < 0): Shorts pay Longs

This strategy captures the **spread** between two exchanges by taking opposite positions:

```
Spread = F_short_exchange − F_long_exchange
```

For a profitable perp-perp arbitrage:
- **SHORT** on the exchange with the higher/more positive funding rate (receive more)
- **LONG** on the exchange with the lower/more negative funding rate (pay less, or receive if negative)

### 2.2 Why Funding Rates Diverge

Funding rates differ across venues due to:
- Different user positioning and liquidation cascades
- Microstructure and liquidity depth differences
- Mark/index methodology variations
- Venue-specific leverage constraints and incentive programs
- Order flow composition (retail vs. institutional)

The strategy monetizes this dispersion while maintaining net delta ≈ 0.

### 2.3 Operational Mode

Unlike traditional cash-and-carry (which requires spot holdings), the Perp-Perp strategy:

1. **Identifies** cross-venue spreads exceeding minimum threshold
2. **Opens** equal-notional positions: SHORT on high-funding venue, LONG on low-funding venue
3. **Collects** net funding payments each period (typically hourly)
4. **Rebalances** when a better opportunity emerges or funding regimes flip

---

## 3. Mathematical Framework

### 3.1 Economic Model

Let:
- `L` = Leverage factor (dynamically calculated, typically 1–5×)
- `F_high` = Annualized funding rate on the short-leg exchange
- `F_low` = Annualized funding rate on the long-leg exchange
- `fee_entry` = Total entry fees (both legs)
- `fee_exit` = Total exit fees (both legs)
- `slippage` = Expected slippage cost

**Gross Spread:**
```
Spread = F_high − F_low
```

**Annualized Gross Yield:**
```
Yield_gross = Spread × L
```

**Net Yield (accounting for costs):**
```
Yield_net = (Spread × L) − (fee_entry + fee_exit + slippage) × (365 / holding_days)
```

### 3.2 Break-Even Analysis

The system computes break-even time before entering any position:

```
Total_Costs = fee_entry + fee_exit + slippage
Hourly_Funding_Return = (Spread × Position_Size) / 8760

Break_Even_Hours = Total_Costs / Hourly_Funding_Return
```

**Rejection Criteria:**
- If `Break_Even_Hours > 168` (7 days) AND `Net_Return ≤ 0`, the opportunity is rejected
- This prevents entering positions that require unrealistically long holding periods

### 3.3 Dynamic Leverage (Sigma-Distance Model)

Leverage is computed dynamically based on asset volatility:

```
L = min(L_max, 1 / (K × σ_daily))
```

Where:
- `σ_daily` = Rolling daily volatility (annualized from 15-minute returns)
- `K` = Safety factor (default 4.0–6.0, adjusted by regime)
- `L_max` = Maximum allowed leverage (default 10×)

**K-Factor Adjustments:**
| Condition | K Adjustment |
|-----------|--------------|
| High volatility (σ > 1.5× baseline) | K += 1.0 |
| Expected long regime duration | K scaled by √(duration_hours / 24) |
| High execution friction (slippage > 0.5%) | K += 0.5 |
| Low historical win rate (< 50%) | K += 1.0 |

### 3.4 Position Sizing

Position size is determined by the minimum of several constraints:

```python
size_by_capital = min(balance_short, balance_long) × balance_usage_pct × leverage
size_by_config = max_position_size_usd  # Default $10,000
size_by_liquidity = min(OI_short, OI_long) × 0.05  # 5% of minimum OI
size_by_twap = twap_optimizer.optimal_size()  # If available

final_size = min(size_by_capital, size_by_config, size_by_liquidity, size_by_twap)
```

---

## 4. Opportunity Discovery & Ranking

### 4.1 Discovery Pipeline

The system generates opportunities across all exchange pairs supporting the same normalized symbol:

```python
FOR each symbol in common_assets:
    FOR each exchange_pair in [(HL, Lighter), (HL, Aster), ...]:
        spread = rate[exchange_high] - rate[exchange_low]
        IF spread > MIN_SPREAD:  # Default 0.01% (0.0001)
            opportunities.append(Opportunity(symbol, spread, ...))
```

**Symbol Normalization:**
- Strips suffixes: `USDT`, `USDC`, `PERP`, `-PERP`
- Maps venue-specific naming to canonical symbols
- Enables cross-venue matching (e.g., `ETHUSDT` ↔ `ETH-PERP`)

### 4.2 Pre-Planning Filters

Before building execution plans, opportunities are filtered:

| Filter | Condition | Rationale |
|--------|-----------|-----------|
| Symbol Blacklist | `symbol ∈ BLACKLISTED_SYMBOLS` | Known problematic assets (default: `NVDA`) |
| Recent Failure Cooldown | `symbol ∈ filtered_opportunities` | 30-minute cooldown after 5 failed retries |
| Market Quality | `quality_score < threshold` | Auto-blacklisted after repeated execution failures |
| Minimum Spread | `spread < MIN_SPREAD` | Below profitability threshold |

### 4.3 Opportunity Scoring

Opportunities are ranked by a composite score:

```
Score = (Consistency × 0.3) + (Historical_Rate × 0.3) + (Liquidity × 0.2) + (1 / Break_Even × 0.2)
```

Where:
- **Consistency** = Percentage of historical periods with positive spread
- **Historical_Rate** = Average funding rate over lookback window
- **Liquidity** = log(min(OI_short, OI_long))
- **Break_Even** = Estimated hours to recover costs

---

## 5. Execution Planning

### 5.1 Cost Model

**Fee Structure:**
```
fee_entry = (size × maker_fee_short) + (size × maker_fee_long)
fee_exit = (size × taker_fee_short) + (size × taker_fee_long)
```

Default fee rates:
| Exchange | Maker Fee | Taker Fee |
|----------|-----------|-----------|
| Hyperliquid | 0.02% | 0.05% |
| Lighter | 0.02% | 0.05% |

**Slippage Model (Square-Root Impact):**
```
slippage_pct = base_impact × √(size / liquidity_proxy)
```

Where `liquidity_proxy` = Open Interest or order book depth.

### 5.2 Basis Risk Assessment

Even with delta neutrality, mark price divergence between venues creates basis risk.

**Statistical Z-Score Check:**
```python
IF historical_basis_data_available:
    z_score = (current_basis - mean_basis) / std_basis
    IF z_score < -2.0:  # Basis is 2σ against our position
        REJECT opportunity
```

**Time-to-Recover Check:**
```python
basis_cost = abs(current_basis) × position_size
payback_hours = basis_cost / hourly_funding_return
IF payback_hours > 48 AND basis_is_against_us:
    REJECT opportunity
```

**Fallback Heuristic:**
```python
IF abs(basis_bps) > MAX_BASIS_RISK_BPS:  # Default 150 bps
    REJECT opportunity
```

### 5.3 Execution Plan Output

A valid execution plan contains:

```typescript
interface ExecutionPlan {
  symbol: string;
  shortExchange: Exchange;
  longExchange: Exchange;
  positionSize: number;
  leverage: number;
  
  // Cost breakdown
  entryFees: number;
  exitFees: number;
  estimatedSlippage: number;
  totalCosts: number;
  
  // Projections
  expectedHourlyReturn: number;
  breakEvenHours: number;
  estimatedAPY: number;
  
  // Risk metrics
  basisRiskBps: number;
  liquidationDistance: number;
}
```

---

## 6. Operational Architecture

### 6.1 System Components

The Perp Keeper is an off-chain service responsible for monitoring funding rates, calculating optimal positions, and executing trades. It consists of:

**1. Funding Rate Aggregator**
- Fetches real-time funding rates from all configured exchanges
- Normalizes symbols across venues
- Generates pairwise arbitrage opportunities

**2. Execution Plan Builder**
- Computes position sizing based on capital and risk constraints
- Models costs (fees, slippage, basis risk)
- Validates break-even requirements

**3. Single-Leg Handler**
- Detects unmatched positions (one leg filled, other not)
- Retries opening missing leg (up to 5 attempts)
- Closes exposed leg if retries exhausted

**4. Optimal Leverage Service**
- Fetches historical price data (15-minute candles)
- Computes rolling volatility
- Applies sigma-distance model with dynamic K-factor

**5. Performance Logger**
- Tracks estimated vs. realized APY
- Monitors funding payments received
- Calculates break-even progress

### 6.2 Main Loop Logic

```python
EVERY check_interval (default: 5 minutes):
    
    # 1. Detect and handle single-leg positions
    single_legs = detectSingleLegPositions()
    FOR each single_leg in single_legs:
        IF retries[single_leg] < 5:
            tryOpenMissingSide(single_leg)
            retries[single_leg] += 1
        ELSE:
            closeExposedLeg(single_leg)
            cooldown(single_leg.symbol, 30_minutes)
    
    # 2. Check liquidation risk
    IF any_position_health_factor < 1.5:
        triggerEmergencyRebalance()
    
    # 3. Discover opportunities
    opportunities = fundingRateAggregator.findArbitrageOpportunities()
    
    # 4. Filter and rank
    filtered = applyFilters(opportunities)
    ranked = rankByScore(filtered)
    
    # 5. Build execution plans
    FOR each opportunity in ranked:
        plan = executionPlanBuilder.createPlan(opportunity)
        IF plan.isValid AND shouldEnterOrSwitch(plan):
            execute(plan)
            BREAK  # One trade per cycle
```

### 6.3 Order Execution

Orders are placed as **LIMIT orders at mark price** (maker-style):

```python
def placeOrder(exchange, symbol, side, size):
    mark_price = exchange.getMarkPrice(symbol)
    
    # Attempt to get best bid/ask for better pricing
    IF orderbook_available:
        price = best_bid IF side == SELL ELSE best_ask
    ELSE:
        price = mark_price
    
    return exchange.placeLimitOrder(
        symbol=symbol,
        side=side,
        size=size,
        price=price,
        reduceOnly=False
    )
```

---

## 7. Risk Management

### 7.1 Core Risk Table

| Risk Vector | Description | Mitigation Strategy |
|-------------|-------------|---------------------|
| **Single-Leg Exposure** | One position fills while the other fails, creating directional risk | Automatic retry logic (5 attempts); emergency close of exposed leg; 30-minute cooldown |
| **Liquidation Risk** | Adverse price movement causes margin call on one or both legs | Real-time health factor monitoring; dynamic leverage based on volatility; target HF > 2.0 |
| **Funding Regime Flip** | Spread inverts rapidly, turning profitable position into loss | Break-even aware switching; hysteresis logic to prevent oscillation |
| **Basis Risk** | Mark price divergence between venues creates hidden P&L | Z-score rejection; payback period check; max basis threshold (150 bps) |
| **Execution Quality** | Repeated failures on specific markets | MarketQualityFilter auto-blacklists problematic symbols |
| **Smart Contract Risk** | Vulnerabilities in exchange contracts | Use canonical exchange interfaces; no custom on-chain logic |

### 7.2 Liquidation Monitoring

The system continuously monitors position health:

```python
FOR each position in active_positions:
    health_factor = calculateHealthFactor(position)
    
    IF health_factor < EMERGENCY_THRESHOLD:  # Default 1.2
        emergencyClose(position)
    ELIF health_factor < WARNING_THRESHOLD:  # Default 1.5
        reducePositionSize(position, 50%)
```

### 7.3 Churn Prevention

To avoid excessive rebalancing costs, the system implements break-even aware switching:

```python
def shouldSwitch(current_position, new_opportunity):
    remaining_break_even = current_position.break_even_hours - hours_held
    
    # Cost to switch = close current + open new
    switch_cost = current_position.exit_fees + new_opportunity.entry_fees
    new_break_even = new_opportunity.break_even_hours + (switch_cost / new_hourly_return)
    
    # Only switch if meaningfully better
    IF remaining_break_even <= 0:  # Current already profitable
        return new_break_even < remaining_break_even × 0.5
    ELSE:
        return new_break_even < remaining_break_even × 0.8
```

---

## 8. Backtests & Validation

The system includes three distinct validation methodologies:

### 8.1 Leverage Safety Backtest

**Goal:** Validate that volatility-targeted leverage does not imply unrealistic liquidation risk.

**Script:** `server/src/scripts/backtest-leverage.ts`

**Methodology:**
1. Fetch 30 days of 15-minute candles from Hyperliquid
2. Compute rolling 7-day volatility: `σ_daily = σ_15m × √96`
3. Calculate leverage per step: `L = min(10, 1 / (K × σ_daily))`
4. Simulate capital path with constant funding accrual
5. Flag liquidation if worst intra-bar move exceeds threshold

**K-Factor Sweep Results (Example: MOODENG):**

| K-Factor | Avg Leverage | Max Drawdown | Liquidated | Final Capital |
|----------|--------------|--------------|------------|---------------|
| 3.0 | 4.2× | -18.3% | Yes | $0 |
| 4.0 | 3.1× | -12.1% | No | $1,847 |
| 5.0 | 2.5× | -9.7% | No | $1,623 |
| 6.0 | 2.1× | -8.1% | No | $1,445 |

**Design Implication:** K ≥ 4.0 required for volatile assets to survive historical drawdowns.

### 8.2 Prediction Model Backtest

**Goal:** Quantify whether funding rate predictions add signal versus naïve baselines.

**Module:** `server/src/domain/services/prediction/PredictionBacktester.ts`

**Methodology:**
- Walk-forward validation with rolling training window (168 hours)
- Step size: 1 hour
- Compare predicted vs. actual next funding rate

**Metrics Computed:**
| Metric | Description |
|--------|-------------|
| MAE | Mean Absolute Error |
| RMSE | Root Mean Square Error |
| Directional Accuracy | % of correct direction predictions |
| Confidence Calibration | Predicted confidence vs. actual accuracy |

**API Endpoints:**
```
GET /funding-rates/backtest/:exchange/:symbol?window=168
GET /funding-rates/backtest/:exchange?window=168
```

### 8.3 Realized Funding Payments Analysis

**Goal:** Measure actual production performance, not theoretical rates.

**Service:** `server/src/infrastructure/services/RealFundingPaymentsService.ts`

**Methodology:**
1. Fetch user funding payment history from exchanges
2. Compute win rate, profit factor, expectancy
3. Calculate realized APY vs. deployed capital
4. Track trading costs for true break-even analysis

**Metrics:**
```typescript
interface FundingPaymentMetrics {
  totalPayments: number;
  winRate: number;           // % of positive payment periods
  profitFactor: number;      // gross_profit / gross_loss
  avgWin: number;
  avgLoss: number;
  expectancy: number;        // avgWin × winRate - avgLoss × (1 - winRate)
  realizedAPY: number;       // Actual annualized return
}
```

---

## 9. Production Metrics

The system tracks both forward-looking and realized performance:

| Metric | Source | Update Frequency |
|--------|--------|------------------|
| **Estimated APY** | Current funding rates × leverage | Every check interval |
| **Realized APY** | Actual funding payments received | Hourly |
| **Break-Even Progress** | Trading costs vs. cumulative funding | Real-time |
| **Position Health** | Margin ratio per exchange | Every check interval |
| **Execution Quality** | Fill rate, slippage vs. estimate | Per trade |

**Performance Logger Output:**
```
========== PERP KEEPER PERFORMANCE ==========
Estimated APY: 28.4%
Realized APY (7d): 24.1%
Break-Even Progress: 142% (profitable)
Active Positions: 3
Total Margin Deployed: $28,450
Health Factor (min): 2.34
Win Rate (funding): 73.2%
=============================================
```

---

## 10. Configuration Reference

### 10.1 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KEEPER_MIN_SPREAD` | 0.0001 | Minimum spread to consider (0.01%) |
| `KEEPER_MAX_POSITION_SIZE_USD` | 10000 | Hard cap per position |
| `KEEPER_LEVERAGE` | 2.0 | Static leverage (if dynamic disabled) |
| `KEEPER_USE_DYNAMIC_LEVERAGE` | true | Enable volatility-based leverage |
| `KEEPER_BLACKLISTED_SYMBOLS` | NVDA | Comma-separated blacklist |
| `KEEPER_MAX_BREAK_EVEN_DAYS` | 7 | Maximum break-even period |
| `KEEPER_MAX_BASIS_RISK_BPS` | 150 | Maximum basis divergence |

### 10.2 Strategy Config Defaults

```typescript
const defaultConfig = {
  minPositionSizeUsd: 5,
  balanceUsagePercent: 0.9,      // 90% of available
  maxWorstCaseBreakEvenDays: 7,
  maxBasisRiskBps: 150,
  
  // Dynamic leverage
  useDynamicLeverage: true,
  minLeverage: 1.0,
  maxLeverage: 10.0,
  volatilityLookbackHours: 168,  // 7 days
  
  // Liquidity filters
  min24hVolumeUsd: 100000,
  maxPositionToVolumePercent: 5,
};
```

---

## 11. Known Limitations

| Limitation | Impact | Planned Mitigation |
|------------|--------|-------------------|
| **Aster Disabled** | Reduces venue diversification | Re-enable after API stabilization |
| **Funding Cadence Assumption** | Assumes hourly funding across venues | Add venue-specific period normalization |
| **Backtest Simplification** | Leverage backtest ignores real slippage | Integrate execution simulator |
| **Basis Risk Proxy** | Uses mark prices, not fill prices | Add fill price tracking |

---

## 12. Conclusion

The Perp-Perp Funding Rate Arbitrage Strategy is a **delta-neutral yield engine** that captures funding rate dispersion across perpetual futures exchanges.

**Key Design Principles:**
1. **Conservative Sizing** — Break-even analysis ensures positions can recover costs within acceptable timeframes
2. **Dynamic Risk Management** — Volatility-targeted leverage prevents liquidations during market stress
3. **Operational Robustness** — Single-leg protection and market quality filters prevent cascading failures
4. **Measurable Performance** — Realized funding tracking validates theoretical projections

**Expected Performance:**
- **Bull Market (positive funding dominant):** 20–40% APY, spread capture from long-biased markets
- **Bear Market (negative funding dominant):** 15–30% APY, spread capture from short-biased markets
- **Choppy/Neutral:** 10–20% APY, reduced but consistent spread opportunities

The strategy is specifically engineered to perform in all market regimes by exploiting **structural inefficiencies** rather than directional bets. Combined with the robust operational architecture and comprehensive risk controls, it provides a reliable yield source for the overall portfolio.

---

*Document Version: 3.0*  
*Last Updated: December 2025*
