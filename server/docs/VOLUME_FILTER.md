# Dynamic Volume-Based Liquidity Filter

## Overview

This feature **automatically scales volume requirements** based on your position size to ensure quick order fills. No manual tuning needed - it grows with your portfolio!

## How It Works

### The Formula

```
required_volume = position_size × (100 / max_position_percent)
```

**Example with 5% max:**
| Position Size | Required Volume | Calculation |
|--------------|-----------------|-------------|
| $5,000 | $100,000 | $5k × 20 |
| $15,000 | $300,000 | $15k × 20 |
| $25,000 | $500,000 | $25k × 20 |
| $50,000 | $1,000,000 | $50k × 20 |

### What Happens

1. **Volume Sufficient** → Trade proceeds normally
2. **Volume Low** → Position is **automatically reduced** to fit the liquidity
3. **Volume Too Low** → Trade skipped (can't even meet minimum position)

## Configuration

```bash
# Maximum position size as % of 24h volume (default: 5%)
# Lower = more conservative, prioritizes faster fills
MAX_POSITION_TO_VOLUME_PERCENT=5

# Optional: Absolute floor (default: 0 = fully dynamic)
# Set this if you want a hard minimum regardless of position size
MIN_24H_VOLUME_USD=0
```

### Recommended Settings

| Priority | MAX_POSITION_TO_VOLUME_PERCENT | Fill Speed |
|----------|-------------------------------|------------|
| **Fastest fills** | 2% | Your order is tiny vs market |
| **Balanced** (default) | 5% | Quick fills, good capital efficiency |
| **Max capital usage** | 10% | Slower fills, may cause single-legs |

## Auto-Scaling Examples

### Small Portfolio ($50k)

```
Typical position: $5k
Required volume: $5k × 20 = $100k
→ Most pairs qualify, wide selection
```

### Medium Portfolio ($200k)

```
Typical position: $20k  
Required volume: $20k × 20 = $400k
→ Filters out lowest-volume pairs automatically
```

### Large Portfolio ($500k)

```
Typical position: $50k
Required volume: $50k × 20 = $1M
→ Only trades liquid majors (ETH, BTC, SOL, etc.)
```

## How Position Reduction Works

When volume is insufficient for your full position:

```
Portfolio: $200k
Target position: $30k
24h Volume: $400k
Max at 5%: $400k × 5% = $20k

Result: Position reduced from $30k → $20k
Log: "📊 Reducing position for ETH from $30,000 to $20,000 (5% of 24h volume $400,000) - prioritizing quick fills"
```

This ensures you **never** place an order too large for the market to fill quickly.

## Volume Data Sources

| Exchange | Volume Data | Status |
|----------|------------|--------|
| **Hyperliquid** | ✅ `dayNtlVlm` | Implemented |
| **Lighter** | ✅ `daily_quote_token_volume` | Implemented |
| **Aster** | ⚠️ Falls back to OI | No volume API |
| **Extended** | ⚠️ Falls back to OI | No volume API |

For exchanges without volume data:
- If `MIN_24H_VOLUME_USD=0` (default): Proceeds using OI filter only
- If `MIN_24H_VOLUME_USD>0`: Skips (requires volume data)

## Comparison: Static vs Dynamic

| Aspect | Static Threshold | Dynamic (New) |
|--------|-----------------|---------------|
| **$50k portfolio** | Same $500k min | $100k min (auto) |
| **$500k portfolio** | Same $500k min | $1M min (auto) |
| **Config changes** | Manual updates | None needed |
| **Scales with growth** | ❌ No | ✅ Yes |

## Example Logs

**Position reduced due to volume:**
```
[ExecutionPlanBuilder] 📊 Reducing position for YZY from $25,000 to $15,000 (5% of 24h volume $300,000) - prioritizing quick fills
```

**Skipped due to insufficient volume:**
```
[ExecutionPlanBuilder] Insufficient 24h volume for quick fills: $50,000 (need $400,000 for $20,000 position at 5% max)
```

**No volume data (proceeds if MIN_24H_VOLUME_USD=0):**
```
[ExecutionPlanBuilder] ⚠️ No volume data for XYZ - proceeding (no min volume configured)
```

## Why This Prevents Single-Leg Issues

Your YZY single-leg problem happened because:
1. Position was too large relative to volume
2. One side filled, the other sat in the order book
3. Market moved, creating exposure

With dynamic volume filter:
1. System calculates: "$15k YZY position needs $300k volume"
2. Sees actual volume is $100k
3. **Reduces position to $5k** (or skips if too small)
4. Both sides fill quickly → No single-leg! ✅

