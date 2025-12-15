# Capital Scaling Plan: $500K Deployment

## Current State

| Metric | Current | After $500K |
|--------|---------|-------------|
| **Total Capital** | ~$285 | ~$500,285 |
| **Per Exchange** | ~$70-240 | ~$125,000 |
| **Max Position Size** | $10,000 | Needs increase |

## Key Configuration Changes

### 1. Position Size Limits

Update `.env`:

```bash
# Current: $10,000 - too small for $500k capital
KEEPER_MAX_POSITION_SIZE_USD=50000

# Alternative: Set per-exchange limits
HYPERLIQUID_MAX_POSITION_USD=100000
LIGHTER_MAX_POSITION_USD=75000
ASTER_MAX_POSITION_USD=75000
EXTENDED_MAX_POSITION_USD=50000
```

### 2. Capital Distribution

```bash
# Rebalancing thresholds
REBALANCE_MIN_BALANCE=1000       # Min $1k per exchange
REBALANCE_THRESHOLD_PERCENT=15   # Rebalance if >15% imbalanced
REBALANCE_MIN_TRANSFER=100       # Min $100 per transfer
```

### 3. Risk Management

```bash
# Conservative for initial deployment
KEEPER_MAX_LEVERAGE=3            # 3x max (not 5x)
KEEPER_MIN_SPREAD=0.0002         # 0.02% minimum spread
KEEPER_MAX_CONCURRENT_POSITIONS=10
```

## Liquidity Constraints by Exchange

| Exchange | Est. Max Position | OI Available | Notes |
|----------|------------------|--------------|-------|
| **Hyperliquid** | $100,000+ | High | Most liquid, supports large sizes |
| **Lighter** | $50,000-75,000 | Medium | Good liquidity on majors |
| **Aster** | $50,000-75,000 | Medium | Variable liquidity |
| **Extended** | $25,000-50,000 | Low-Medium | Newer, less depth |

## Deployment Strategy

### Phase 1: Days 1-3 (First $100k)

```bash
# Conservative settings for testing
KEEPER_MAX_POSITION_SIZE_USD=25000
KEEPER_MAX_LEVERAGE=2
```

1. Deposit $25k to each exchange
2. Monitor slippage on first trades
3. Verify order book depth is sufficient
4. Check funding rate accuracy at scale

### Phase 2: Days 4-5 (Scale to $300k)

```bash
KEEPER_MAX_POSITION_SIZE_USD=50000
KEEPER_MAX_LEVERAGE=3
```

1. Increase to $75k per exchange
2. Monitor execution quality
3. Verify no duplicate orders
4. Check rebalancing works at scale

### Phase 3: Days 6-8 (Full $500k)

```bash
KEEPER_MAX_POSITION_SIZE_USD=75000
KEEPER_MAX_LEVERAGE=3
```

1. Full deployment ~$125k per exchange
2. Enable all symbols
3. Full monitoring active

## Monitoring Checklist

### Daily Checks

- [ ] All positions are delta-neutral (LONG = SHORT)
- [ ] No single-leg positions lasting >10 minutes
- [ ] Slippage < 0.5% on trades
- [ ] No duplicate orders
- [ ] Funding payments received

### Position Health

```bash
# Run these checks daily
pnpm run test:integration

# Check for duplicates
npx ts-node test-lighter-open-orders3.ts
```

### Balance Distribution

Target distribution (after full deployment):

| Exchange | Target Balance | Range |
|----------|---------------|-------|
| Hyperliquid | $150,000 | $120k-180k |
| Lighter | $125,000 | $100k-150k |
| Aster | $125,000 | $100k-150k |
| Extended | $100,000 | $75k-125k |

## Risk Limits

### Maximum Exposure

```
Total Notional Exposure: $500k × 3x = $1.5M max
Per Position: $75k max
Per Symbol: $150k max (across all exchanges)
Per Exchange: $200k max exposure
```

### Drawdown Limits

```
Daily Drawdown Limit: $10,000 (2%)
Weekly Drawdown Limit: $25,000 (5%)
Total Drawdown Limit: $50,000 (10%)
```

## Emergency Procedures

### 1. Close All Positions

```bash
# Via API
curl -X POST http://localhost:3000/keeper/emergency-close

# Or manual cancellation
npx ts-node cancel-lighter-orders-individual.ts
```

### 2. Halt Trading

```bash
# Set in .env
KEEPER_ENABLED=false
```

### 3. Withdraw to Safety

```bash
# Lighter fast withdraw
npx ts-node lighter-fast-withdraw.ts

# Hyperliquid withdraw via SDK
```

## Configuration Summary

### Final .env for $500k

```bash
# === KEEPER CONFIGURATION ===
KEEPER_ENABLED=true
KEEPER_MIN_SPREAD=0.0002
KEEPER_MAX_POSITION_SIZE_USD=75000
KEEPER_MAX_LEVERAGE=3
KEEPER_MAX_CONCURRENT_POSITIONS=15

# === REBALANCING ===
REBALANCE_MIN_BALANCE=1000
REBALANCE_THRESHOLD_PERCENT=15
REBALANCE_MIN_TRANSFER=100

# === RISK MANAGEMENT ===
MAX_DAILY_LOSS_USD=10000
MAX_WEEKLY_LOSS_USD=25000
EMERGENCY_STOP_LOSS_PERCENT=10

# === ORDER DEDUPLICATION ===
PENDING_ORDER_GRACE_PERIOD_MS=300000  # 5 minutes
STALE_ORDER_THRESHOLD_MS=600000       # 10 minutes
```

## Questions to Answer Before Deployment

1. **Deposit method**: Direct to each exchange or via central wallet?
2. **Gradual vs immediate**: Deploy all at once or phase over days?
3. **Symbol selection**: All symbols or focus on top liquidity (ETH, BTC, SOL)?
4. **Monitoring setup**: Alerts for positions, PnL, errors?
5. **Emergency contacts**: Who to alert if issues arise?

