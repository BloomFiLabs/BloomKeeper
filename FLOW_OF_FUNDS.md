# Flow of Funds - Bloom Funding Arbitrage System

## Executive Summary

The Bloom Funding Arbitrage System is a sophisticated DeFi protocol that enables users to earn yield by capitalizing on funding rate differentials across multiple perpetual futures exchanges. This document provides a comprehensive overview of how funds flow through the entire system, from initial user deposits through profit generation and reward distribution.

The system operates on a **delta-neutral arbitrage strategy**, simultaneously taking long and short positions on the same asset across different exchanges to capture funding rate spreads while maintaining minimal directional exposure.

---

## Table of Contents

1. [System Architecture Overview](#system-architecture-overview)
2. [Deposit Flow](#deposit-flow)
3. [Capital Deployment](#capital-deployment)
4. [Position Management & Arbitrage Execution](#position-management--arbitrage-execution)
5. [Profit Accumulation](#profit-accumulation)
6. [Reward Harvesting](#reward-harvesting)
7. [Reward Distribution](#reward-distribution)
8. [Withdrawal Flow](#withdrawal-flow)
9. [Rebalancing Mechanisms](#rebalancing-mechanisms)
10. [Complete Flow Diagram](#complete-flow-diagram)
11. [Key Metrics & Accounting](#key-metrics--accounting)
12. [Security & Safety Features](#security--safety-features)

---

## System Architecture Overview

The Bloom system consists of three primary layers:

### 1. **Smart Contract Layer (On-Chain)**
- **BloomStrategyVault**: ERC4626 compliant vault that manages user deposits and share issuance
- **KeeperStrategyManager**: Bridge contract between vault and off-chain keeper bot
- **Exchange Adapters**: Smart contracts for on-chain exchanges (e.g., Lighter)

### 2. **Keeper Bot Layer (Off-Chain)**
- **PerpKeeperScheduler**: Orchestrates strategy execution, position management, and NAV reporting
- **FundingArbitrageStrategy**: Core strategy logic for opportunity identification and execution
- **Exchange Adapters**: API clients for off-chain exchanges (Hyperliquid, Aster, Extended)
- **RewardHarvester**: Automated profit collection and distribution

### 3. **Exchange Layer**
- **Hyperliquid**: Decentralized perpetual futures exchange
- **Lighter**: On-chain perpetual futures exchange
- **Aster**: Centralized perpetual futures exchange
- **Extended**: Additional exchange support

---

## Deposit Flow

### Overview

When a user deposits USDC into the Bloom vault, the funds flow through multiple layers before being deployed to exchanges for arbitrage opportunities.

### Detailed Process

#### Step 1: User Initiates Deposit

```
User Wallet (Arbitrum)
    │
    │ User calls: vault.deposit(amount, receiver)
    │
    │ - User approves USDC spending (if not already approved)
    │ - User transfers USDC to vault contract
    │
    ▼
```

**What Happens:**
- User must first approve the vault to spend their USDC (one-time operation)
- User calls the standard ERC4626 `deposit()` function
- USDC is transferred from user's wallet to the vault contract

#### Step 2: Vault Processes Deposit

```
BloomStrategyVault Contract
    │
    │ _deposit() internal function:
    │
    │ 1. Settle pending rewards for receiver
    │    - Calculates accrued rewards based on accRewardPerShare
    │    - Transfers any pending USDC rewards to user
    │    - Updates rewardDebt[receiver]
    │
    │ 2. Calculate shares to mint
    │    - shares = assets * totalSupply() / totalAssets()
    │    - Uses previewDeposit() for accurate calculation
    │
    │ 3. Mint vault shares (BSV tokens)
    │    - _mint(receiver, shares)
    │    - User now owns BSV tokens representing their stake
    │
    │ 4. Track user deposit
    │    - usersDeposits[receiver][USDC] += assets
    │
    │ 5. Allocate to strategies
    │    - If strategies registered:
    │      * amountPerStrategy = assets / strategies.length
    │      * For each strategy:
    │        - allocations[strategy][receiver] += amountPerStrategy
    │        - strategy.deposit(amountPerStrategy)
    │
    │ 6. Update reward debt
    │    - rewardDebt[receiver] = (shares * accRewardPerShare) / REWARD_PRECISION
    │
    ▼
```

**Key Features:**
- **Reward Settlement**: Any pending rewards are automatically claimed before deposit
- **Share Calculation**: Uses ERC4626 standard formula for fair share pricing
- **Multi-Strategy Support**: Funds can be allocated across multiple strategies
- **Reward Tracking**: Updates reward debt to prevent double-counting

#### Step 3: Strategy Receives Funds

```
KeeperStrategyManager Contract
    │
    │ deposit(amount) function called by vault:
    │
    │ 1. Access control check
    │    - Only vault can call (onlyVault modifier)
    │    - Emergency mode check (notEmergency modifier)
    │
    │ 2. Pull funds from vault
    │    - asset.safeTransferFrom(vault, address(this), amount)
    │    - USDC now held in strategy contract
    │
    │ 3. Update accounting
    │    - deployedCapital += amount
    │    - lastReportedNAV += amount
    │    - (NAV increases to reflect new capital)
    │
    │ 4. Emit event for keeper
    │    - CapitalDeployed(deploymentId, amount, timestamp)
    │    - Keeper bot listens for this event
    │
    ▼
```

**Accounting Details:**
- `deployedCapital`: Tracks principal amount (excludes profits)
- `lastReportedNAV`: Net Asset Value used for share pricing
- `CapitalDeployed` event: Signals keeper bot to deploy capital

#### Step 4: Keeper Bot Detects Deployment

```
Keeper Bot (Off-Chain Service)
    │
    │ Event Listener:
    │ - Monitors CapitalDeployed events
    │ - Extracts: deploymentId, amount, timestamp
    │
    │ Withdrawal Process:
    │ 1. Check available capital in contract
    │    - getIdleBalance() - pendingWithdrawals
    │
    │ 2. Withdraw to keeper wallet
    │    - contract.withdrawToKeeper(amount)
    │    - USDC transferred to keeper's Arbitrum wallet
    │
    │ 3. Prepare for exchange deployment
    │    - Funds now available for bridging/depositing
    │
    ▼
```

**Keeper Responsibilities:**
- Monitors blockchain events in real-time
- Manages capital deployment across exchanges
- Ensures sufficient liquidity for operations

---

## Capital Deployment

### Overview

Once the keeper bot receives USDC, it must deploy the capital across multiple exchanges to enable arbitrage opportunities. This process involves bridging funds to different networks and depositing to exchange accounts.

### Exchange-Specific Deployment

#### Hyperliquid Deployment

```
Keeper Wallet (Arbitrum)
    │
    │ 1. Bridge USDC to HyperCore
    │    - Hyperliquid operates on HyperCore (separate chain)
    │    - Bridge transaction required
    │    - Funds arrive on HyperCore as USDC
    │
    │ 2. Deposit to Hyperliquid
    │    - USDC available as collateral
    │    - Can open positions immediately
    │
    ▼
Hyperliquid Exchange
    │
    │ USDC Balance: +amount
    │ Available for: Position collateral
```

**Characteristics:**
- Requires cross-chain bridge
- Separate wallet on HyperCore
- Real-time position management

#### Lighter Deployment

```
Keeper Wallet (Arbitrum)
    │
    │ 1. Deposit via Smart Contract
    │    - Calls Lighter adapter contract
    │    - Deposits USDC directly to exchange
    │    - On-chain transaction
    │
    │ 2. Funds locked in exchange contract
    │    - Available as collateral
    │    - Can open positions
    │
    ▼
Lighter Exchange Contract
    │
    │ USDC Balance: +amount
    │ Available for: Position collateral
```

**Characteristics:**
- On-chain deposit (no bridge needed)
- Smart contract managed
- Gas costs for operations

#### Aster Deployment

```
Keeper Wallet (Arbitrum)
    │
    │ 1. Withdraw from Arbitrum
    │    - Bridge USDC to Base (if needed)
    │    - Or use existing Base wallet
    │
    │ 2. Deposit via API
    │    - Calls Aster exchange API
    │    - Deposits USDC to exchange account
    │    - Off-chain operation
    │
    ▼
Aster Exchange
    │
    │ USDC Balance: +amount
    │ Available for: Position collateral
```

**Characteristics:**
- API-based deposit
- Centralized exchange
- Faster execution

#### Extended Deployment

```
Keeper Wallet (Arbitrum)
    │
    │ 1. Bridge to required network
    │    - Exchange-specific chain
    │
    │ 2. Deposit via API/Contract
    │    - Exchange-specific method
    │
    ▼
Extended Exchange
    │
    │ USDC Balance: +amount
    │ Available for: Position collateral
```

### Capital Distribution Strategy

The keeper bot distributes capital across exchanges based on:

1. **Opportunity Availability**: More capital to exchanges with better opportunities
2. **Balance Requirements**: Ensure sufficient collateral for position sizes
3. **Risk Management**: Diversification across exchanges
4. **Rebalancing Needs**: Adjust based on current positions

**Default Behavior:**
- Equal distribution on initial deployment
- Dynamic rebalancing based on opportunities
- Minimum balance thresholds per exchange

---

## Position Management & Arbitrage Execution

### Opportunity Discovery

#### Step 1: Funding Rate Aggregation

```
FundingRateAggregator Service
    │
    │ For each symbol (ETH, BTC, etc.):
    │
    │ 1. Query all exchanges
    │    - Hyperliquid: getCurrentFundingRate(symbol)
    │    - Lighter: getCurrentFundingRate(marketIndex)
    │    - Aster: getCurrentFundingRate(symbol)
    │    - Extended: getCurrentFundingRate(symbol)
    │
    │ 2. Collect additional data
    │    - Mark prices
    │    - Open interest
    │    - 24h volume
    │    - Predicted funding rates
    │
    │ 3. Normalize and compare
    │    - Convert to common format
    │    - Calculate spreads
    │
    ▼
```

**Data Collected:**
- Current funding rate (hourly)
- Predicted funding rate (next period)
- Mark price (for position sizing)
- Open interest (liquidity check)
- 24h volume (market activity)

#### Step 2: Arbitrage Opportunity Identification

```
FundingRateAggregator.findArbitrageOpportunities()
    │
    │ For each symbol:
    │
    │ 1. Compare rates across exchanges
    │    - Sort by funding rate
    │    - Identify highest and lowest rates
    │
    │ 2. Generate exchange pairs
    │    - LONG on exchange with lower rate
    │    - SHORT on exchange with higher rate
    │    - Spread = shortRate - longRate
    │
    │ 3. Filter opportunities
    │    - Minimum spread threshold (default: 0.01%)
    │    - Sufficient liquidity (open interest check)
    │    - Valid mark prices
    │
    │ 4. Calculate expected returns
    │    - Annualized: spread * 24 * 365
    │    - Risk-adjusted returns
    │
    ▼
```

**Example Opportunity:**
```
Symbol: ETH
Hyperliquid: -0.01% (hourly) → LONG position
Lighter: +0.02% (hourly) → SHORT position
Spread: 0.03% per hour
Expected APY: 0.03% * 24 * 365 = 26.3%
```

### Position Execution

#### Step 1: Capital Rebalancing

```
BalanceManager.attemptRebalanceForOpportunity()
    │
    │ Check balance requirements:
    │ - Required collateral for LONG position
    │ - Required collateral for SHORT position
    │
    │ Current balances:
    │ - longExchange.balance
    │ - shortExchange.balance
    │
    │ Rebalancing strategies (in priority order):
    │
    │ 1. Use unused exchanges
    │    - Withdraw from exchanges not in opportunity
    │    - Transfer to needed exchanges
    │
    │ 2. Transfer between exchanges
    │    - If longExchange has excess
    │    - Transfer to shortExchange (or vice versa)
    │
    │ 3. Deposit from wallet
    │    - If keeper wallet has USDC
    │    - Deposit to needed exchange
    │
    ▼
```

**Rebalancing Methods:**
- **Exchange-to-Exchange Transfer**: Direct transfer when supported
- **Withdraw & Deposit**: Two-step process for unsupported transfers
- **Bridge Operations**: For cross-chain transfers (Hyperliquid)

#### Step 2: Position Opening

```
OrderExecutor Service
    │
    │ For each opportunity:
    │
    │ 1. Calculate position size
    │    - Based on available capital
    │    - Risk management limits
    │    - Maximum position size constraints
    │
    │ 2. Open LONG position
    │    - Exchange: longExchange
    │    - Symbol: opportunity.symbol
    │    - Side: LONG
    │    - Size: calculatedSize
    │    - Collateral: USDC
    │
    │ 3. Open SHORT position
    │    - Exchange: shortExchange
    │    - Symbol: opportunity.symbol
    │    - Side: SHORT
    │    - Size: calculatedSize (matched)
    │    - Collateral: USDC
    │
    │ 4. Track positions
    │    - Store position details
    │    - Monitor for fills
    │    - Handle partial fills
    │
    ▼
```

**Position Characteristics:**
- **Delta-Neutral**: Long and short positions are matched in size
- **Funding Rate Exposure**: Net positive funding received
- **Price Risk**: Minimal (positions offset each other)
- **Collateral**: USDC used for both positions

#### Step 3: Position Monitoring

```
PerpKeeperScheduler
    │
    │ Continuous monitoring:
    │
    │ 1. Check position status
    │    - Verify both positions are open
    │    - Check for fills/partial fills
    │    - Monitor position health
    │
    │ 2. Monitor funding rates
    │    - Track rate changes
    │    - Identify when to close
    │    - Calculate accrued profits
    │
    │ 3. Risk management
    │    - Check liquidation risk
    │    - Monitor margin requirements
    │    - Rebalance if needed
    │
    │ 4. Report NAV
    │    - Calculate total equity
    │    - Include unrealized PnL
    │    - Report to contract periodically
    │
    ▼
```

**Monitoring Frequency:**
- Position checks: Every execution cycle (configurable)
- NAV reporting: Periodically (ensures share pricing accuracy)
- Funding rate updates: Real-time via WebSocket where available

### Position Closing

```
FundingArbitrageStrategy
    │
    │ Close conditions:
    │
    │ 1. Opportunity expired
    │    - Spread no longer profitable
    │    - Funding rates converged
    │
    │ 2. Better opportunity available
    │    - Higher spread found
    │    - Portfolio rebalancing needed
    │
    │ 3. Risk management
    │    - Liquidation risk
    │    - Exchange issues
    │
    │ Closing process:
    │
    │ 1. Close LONG position
    │    - Exchange: longExchange
    │    - Reduce size to zero
    │    - Release collateral
    │
    │ 2. Close SHORT position
    │    - Exchange: shortExchange
    │    - Reduce size to zero
    │    - Release collateral
    │
    │ 3. Update tracking
    │    - Remove from active positions
    │    - Record realized PnL
    │
    ▼
```

**Closing Considerations:**
- **Symmetric Closing**: Both positions closed simultaneously
- **Partial Closes**: Handle asymmetric fills gracefully
- **Gas Optimization**: Batch operations when possible

---

## Profit Accumulation

### Funding Payments

#### How Funding Works

Perpetual futures exchanges charge or pay funding rates periodically (typically hourly). The funding rate represents the cost of holding a position:

- **Positive Funding Rate**: Longs pay shorts (bearish sentiment)
- **Negative Funding Rate**: Shorts pay longs (bullish sentiment)

**Our Strategy:**
- **LONG on exchange with lower (more negative) rate**: We receive funding
- **SHORT on exchange with higher (more positive) rate**: We receive funding
- **Net Result**: We receive funding from both sides when rates diverge

#### Funding Payment Calculation

```
For each position:

LONG Position:
  - If funding rate < 0: We RECEIVE funding
  - Amount = positionSize * |fundingRate| * markPrice
  - Paid in USDC (or exchange native token)

SHORT Position:
  - If funding rate > 0: We RECEIVE funding
  - Amount = positionSize * fundingRate * markPrice
  - Paid in USDC (or exchange native token)

Net Funding Received:
  - Total = LONG funding + SHORT funding
  - Accumulates in exchange balance
```

**Example:**
```
ETH Position: $10,000 notional
LONG on Hyperliquid: -0.01% hourly
SHORT on Lighter: +0.02% hourly

LONG funding: $10,000 * 0.01% = $1.00
SHORT funding: $10,000 * 0.02% = $2.00
Total per hour: $3.00
Daily: $3.00 * 24 = $72.00
APY: ($72 / $10,000) * 365 = 262.8%
```

### Profit Tracking

#### Real-Time Profit Calculation

```
ProfitTracker Service
    │
    │ For each exchange:
    │
    │ 1. Get current balance
    │    - Total USDC on exchange
    │    - Includes: initial deposit + accrued profits
    │
    │ 2. Calculate deployed capital
    │    - Tracked per exchange
    │    - Initial deposits only
    │
    │ 3. Calculate accrued profit
    │    - accruedProfit = currentBalance - deployedCapital
    │    - Tracks unrealized gains
    │
    │ 4. Track funding payments
    │    - Monitor funding rate payments
    │    - Calculate cumulative funding received
    │
    │ 5. Aggregate totals
    │    - Sum across all exchanges
    │    - Total balance
    │    - Total deployed capital
    │    - Total accrued profit
    │
    ▼
```

**Tracking Components:**
- **Balance**: Current USDC balance on exchange
- **Deployed Capital**: Original deposit amount
- **Accrued Profit**: Balance - Deployed Capital
- **Realized Profit**: Profits withdrawn and sent to contract

#### NAV Reporting

```
PerpKeeperScheduler
    │
    │ Periodic NAV calculation:
    │
    │ 1. Calculate total equity
    │    - Sum all exchange balances
    │    - Include unrealized PnL from positions
    │    - Include accrued funding payments
    │
    │ 2. Account for pending operations
    │    - Subtract pending withdrawals
    │    - Add pending deposits
    │
    │ 3. Report to contract
    │    - KeeperStrategyManager.reportNAV(nav)
    │    - Updates lastReportedNAV
    │    - Updates lastNAVTimestamp
    │
    │ 4. Calculate PnL
    │    - PnL = NAV - deployedCapital
    │    - Positive = profit
    │    - Negative = loss
    │
    ▼
```

**NAV Components:**
- **Exchange Balances**: USDC on each exchange
- **Unrealized PnL**: Mark-to-market position value
- **Accrued Funding**: Unrealized funding payments
- **Pending Operations**: Adjustments for in-flight transactions

**NAV Reporting Frequency:**
- Regular intervals (configurable, typically hourly)
- Before/after major operations
- On-demand via admin functions

---

## Reward Harvesting

### Overview

Reward harvesting is the process of collecting accumulated profits from exchanges and sending them to the strategy contract for distribution to vault users. This process runs automatically on a schedule and can also be triggered manually.

### Harvest Process

#### Step 1: Profit Calculation

```
RewardHarvester.executeHarvest()
    │
    │ 1. Get profit summary
    │    - profitTracker.getProfitSummary()
    │    - Returns: totalAccruedProfit, byExchange breakdown
    │
    │ 2. Check minimum threshold
    │    - Default: $10 USD
    │    - Skip if below threshold
    │    - Prevents gas costs from exceeding profits
    │
    │ 3. Validate exchange data
    │    - Ensure profit data is recent
    │    - Check for exchange connectivity
    │
    ▼
```

**Profit Summary Structure:**
```typescript
{
  totalBalance: number,           // Total USDC across all exchanges
  totalDeployedCapital: number,   // Total principal deployed
  totalAccruedProfit: number,     // Total profits (balance - capital)
  byExchange: Map<ExchangeType, {
    balance: number,
    deployedCapital: number,
    accruedProfit: number
  }>
}
```

#### Step 2: Withdraw from Exchanges

```
For each exchange with profit > $1:

RewardHarvester.withdrawFromExchange()
    │
    │ 1. Get exchange adapter
    │    - HyperliquidAdapter
    │    - LighterAdapter
    │    - AsterAdapter
    │    - ExtendedAdapter
    │
    │ 2. Call withdrawExternal()
    │    - Amount: accruedProfit (or available balance)
    │    - Asset: USDC
    │    - Recipient: Keeper's Arbitrum wallet
    │
    │ 3. Handle exchange-specific logic
    │    - Hyperliquid: Bridge from HyperCore to Arbitrum
    │    - Lighter: Withdraw via smart contract
    │    - Aster: Withdraw via API
    │    - Extended: Exchange-specific method
    │
    │ 4. Track withdrawal
    │    - Record transaction hash
    │    - Monitor for completion
    │
    ▼
```

**Withdrawal Methods:**
- **Hyperliquid**: Bridge operation (cross-chain)
- **Lighter**: Smart contract withdrawal (on-chain)
- **Aster**: API withdrawal (off-chain)
- **Extended**: Exchange-specific implementation

#### Step 3: Wait for Funds to Arrive

```
RewardHarvester.waitForFundsToArrive()
    │
    │ 1. Get initial balance
    │    - Check keeper wallet USDC balance
    │    - Record as baseline
    │
    │ 2. Poll for balance increase
    │    - Check every 15 seconds
    │    - Maximum wait: 10 minutes
    │    - Account for bridge delays
    │
    │ 3. Validate received amount
    │    - Accept if >= 80% of expected
    │    - Accounts for fees and slippage
    │
    │ 4. Timeout handling
    │    - Log warning if timeout
    │    - Continue with available funds
    │
    ▼
```

**Bridge Considerations:**
- **Hyperliquid**: Cross-chain bridge can take 5-10 minutes
- **Lighter**: On-chain, typically 1-2 minutes
- **Aster**: API-based, typically instant
- **Extended**: Varies by exchange

#### Step 4: Send to Strategy Contract

```
RewardHarvester.sendToStrategy()
    │
    │ 1. Check keeper balance
    │    - Get current USDC balance
    │    - Use minimum of: available or expected
    │
    │ 2. Transfer to contract
    │    - usdcContract.transfer(strategyAddress, amount)
    │    - On-chain transaction
    │    - Wait for confirmation
    │
    │ 3. Update tracking
    │    - Record harvest amount
    │    - Update ProfitTracker
    │    - Log harvest history
    │
    │ 4. Update diagnostics
    │    - Record harvest timestamp
    │    - Update last harvest amount
    │    - Calculate next harvest time
    │
    ▼
```

**Transfer Details:**
- **Gas Costs**: Paid by keeper wallet
- **Transaction Confirmation**: Waits for block inclusion
- **Error Handling**: Retries on failure, logs errors

### Harvest Schedule

#### Automatic Harvesting

```
Cron Schedule: '0 0 * * *' (Midnight UTC daily)
    │
    │ 1. Check if harvest needed
    │    - Calculate time since last harvest
    │    - Verify minimum interval (24 hours default)
    │
    │ 2. Execute harvest
    │    - Run full harvest process
    │    - Handle errors gracefully
    │
    │ 3. Record results
    │    - Success/failure status
    │    - Amount harvested
    │    - Timestamp
    │
    ▼
```

**Schedule Configuration:**
- **Default**: Daily at midnight UTC
- **Configurable**: Via `HARVEST_INTERVAL_HOURS` environment variable
- **Minimum Threshold**: `MIN_HARVEST_AMOUNT_USD` (default: $10)

#### Manual Harvesting

```
Admin Function: forceHarvest()
    │
    │ 1. Bypass schedule check
    │    - Execute immediately
    │    - Useful for testing or urgent needs
    │
    │ 2. Same process as automatic
    │    - All validation steps
    │    - Full error handling
    │
    │ 3. Return results
    │    - HarvestResult object
    │    - Success status
    │    - Amount harvested
    │
    ▼
```

**Use Cases:**
- Testing and debugging
- Urgent profit collection
- Before major system updates
- Manual intervention when needed

### Harvest History

```
RewardHarvester maintains:
    │
    │ 1. Last harvest result
    │    - Timestamp
    │    - Amount harvested
    │    - Success status
    │    - Per-exchange breakdown
    │
    │ 2. Harvest history (last 30)
    │    - Array of harvest results
    │    - Rotating buffer
    │    - Used for diagnostics
    │
    │ 3. Total harvested (all-time)
    │    - Cumulative total
    │    - Tracked in ProfitTracker
    │
    ▼
```

**History Tracking:**
- **Last Harvest**: Most recent result
- **History Array**: Last 30 harvests (configurable)
- **All-Time Total**: Cumulative profits harvested

---

## Reward Distribution

### Overview

Once profits are harvested and sent to the strategy contract, they need to be distributed to vault users. The system uses a **dividend-style reward distribution** mechanism where rewards accrue per share and are automatically settled on user actions.

### Reward Collection from Strategy

#### Step 1: Vault Harvests Rewards

```
BloomStrategyVault.harvest()
    │
    │ 1. Iterate through strategies
    │    - For each registered strategy
    │    - Call strategy.claimRewards(vault)
    │
    │ 2. Aggregate rewards
    │    - Sum all rewards collected
    │    - totalCollected += strategy.claimRewards()
    │
    │ 3. Update reward per share
    │    - If totalCollected > 0 and totalSupply() > 0:
    │      accRewardPerShare += (totalCollected * REWARD_PRECISION) / totalSupply()
    │
    │ 4. Rewards now available for distribution
    │
    ▼
```

**Reward Precision:**
- `REWARD_PRECISION = 1e12` (12 decimal places)
- Ensures accurate reward calculation for small amounts
- Prevents rounding errors

#### Step 2: Strategy Claims Rewards

```
KeeperStrategyManager.claimRewards(recipient)
    │
    │ 1. Calculate profit
    │    - profit = lastReportedNAV - deployedCapital
    │    - Only positive profits are claimable
    │
    │ 2. Check available balance
    │    - idleBalance = asset.balanceOf(address(this))
    │    - Can only claim what's actually available
    │
    │ 3. Determine claimable amount
    │    - rewardAmount = min(profit, idleBalance)
    │    - Ensures contract has sufficient funds
    │
    │ 4. Update accounting
    │    - lastReportedNAV -= rewardAmount
    │    - Reduces NAV by claimed amount
    │
    │ 5. Transfer to recipient
    │    - asset.safeTransfer(recipient, rewardAmount)
    │    - Recipient is the vault
    │
    │ 6. Emit event
    │    - RewardsClaimed(recipient, rewardAmount)
    │
    ▼
```

**Profit Calculation:**
- **Profit**: NAV - Deployed Capital
- **Available**: Minimum of profit and idle balance
- **Safety**: Cannot claim more than available

### Reward Distribution to Users

#### Automatic Settlement

Rewards are automatically settled when users interact with the vault:

```
BloomStrategyVault._settleRewards(user)
    │
    │ 1. Check user has shares
    │    - If balanceOf(user) == 0: return
    │
    │ 2. Calculate pending rewards
    │    - pending = (balanceOf(user) * accRewardPerShare) / REWARD_PRECISION
    │    - reward = pending - rewardDebt[user]
    │
    │ 3. Check available funds
    │    - vaultBalance = asset.balanceOf(address(this))
    │    - availableForRewards = vaultBalance - totalFulfilledUnclaimed
    │    - Don't use funds reserved for withdrawals
    │
    │ 4. Transfer if available
    │    - If reward > 0 and availableForRewards >= reward:
    │      asset.safeTransfer(user, reward)
    │
    ▼
```

**Settlement Triggers:**
- **Deposit**: Rewards settled before new shares minted
- **Withdrawal**: Rewards settled before shares burned
- **Transfer**: Rewards settled for both sender and receiver

#### Manual Claim

Users can also manually claim rewards:

```
BloomStrategyVault.claimAllRewards()
    │
    │ 1. Harvest from strategies
    │    - Calls harvest() internally
    │    - Collects latest rewards
    │
    │ 2. Settle user rewards
    │    - Calls _settleRewards(msg.sender)
    │    - Transfers USDC to user
    │
    │ 3. Update reward debt
    │    - rewardDebt[msg.sender] = (balance * accRewardPerShare) / REWARD_PRECISION
    │
    ▼
```

**Use Cases:**
- User wants immediate rewards
- Before transferring shares
- Periodic manual claims

### Reward Accounting

#### Reward Debt System

The system uses a "reward debt" mechanism to track what each user has already been credited:

```
Reward Debt Calculation:
    │
    │ When user deposits:
    │   rewardDebt[user] = (newShares * accRewardPerShare) / REWARD_PRECISION
    │
    │ When calculating rewards:
    │   pending = (userShares * accRewardPerShare) / REWARD_PRECISION
    │   reward = pending - rewardDebt[user]
    │
    │ After settlement:
    │   rewardDebt[user] = (userShares * accRewardPerShare) / REWARD_PRECISION
    │
    ▼
```

**Why Reward Debt?**
- Prevents double-counting of rewards
- Ensures fair distribution based on share ownership
- Accounts for share transfers correctly

#### Reward Per Share Calculation

```
accRewardPerShare Update:
    │
    │ When rewards are harvested:
    │   accRewardPerShare += (totalRewards * REWARD_PRECISION) / totalSupply()
    │
    │ This means:
    │   - More rewards → higher accRewardPerShare
    │   - More shares → smaller increment per share
    │   - Fair distribution proportional to ownership
    │
    ▼
```

**Example:**
```
Total Supply: 1,000,000 shares
Rewards Harvested: $1,000 USDC

accRewardPerShare increment = ($1,000 * 1e12) / 1,000,000
                          = 1,000,000,000,000 (1e12 units)

User with 100,000 shares:
  pending = (100,000 * accRewardPerShare) / 1e12
  reward = pending - rewardDebt[user]
  = $100 USDC (proportional to 10% ownership)
```

---

## Withdrawal Flow

### Overview

The withdrawal process uses a **two-step mechanism** to handle asynchronous position closing and fund recovery from exchanges. This ensures users can always request withdrawals, even when funds are deployed in active positions.

### Step 1: Request Withdrawal

#### User Initiates Request

```
User
    │
    │ Calls: vault.requestWithdrawal(shares)
    │
    │ - User specifies number of shares to redeem
    │ - Must have sufficient shares
    │
    ▼
```

#### Vault Processes Request

```
BloomStrategyVault.requestWithdrawal(shares)
    │
    │ 1. Validation
    │    - Check shares > 0
    │    - Check user has sufficient shares
    │
    │ 2. Settle rewards
    │    - _settleRewards(msg.sender)
    │    - User receives any pending rewards
    │
    │ 3. Calculate assets
    │    - assets = previewRedeem(shares)
    │    - Based on current share price
    │
    │ 4. Burn shares
    │    - _burn(msg.sender, shares)
    │    - Shares destroyed immediately
    │
    │ 5. Create withdrawal request
    │    - requestId = nextWithdrawalId++
    │    - withdrawalRequests[requestId] = {
    │        id: requestId,
    │        user: msg.sender,
    │        assets: assets,
    │        shares: shares,
    │        requestedAt: block.timestamp,
    │        fulfilled: false,
    │        claimed: false
    │      }
    │
    │ 6. Update tracking
    │    - totalPendingWithdrawals += assets
    │    - userPendingWithdrawals[msg.sender] += assets
    │    - usersDeposits[msg.sender] -= assets
    │
    │ 7. Request from strategies
    │    - _requestFromStrategies(assets)
    │    - Calls strategy.withdraw(amountPerStrategy)
    │
    │ 8. Update reward debt
    │    - rewardDebt[msg.sender] = (newBalance * accRewardPerShare) / REWARD_PRECISION
    │
    │ 9. Emit event
    │    - WithdrawalRequested(requestId, user, assets, shares, timestamp)
    │
    ▼
```

**Key Points:**
- **Shares Burned Immediately**: User's shares are destroyed right away
- **Assets Calculated**: Based on current share price (NAV / totalSupply)
- **Request Created**: Queued for keeper fulfillment
- **Strategy Notified**: Strategies receive withdrawal request

#### Strategy Handles Request

```
KeeperStrategyManager.withdraw(amount)
    │
    │ 1. Check idle balance
    │    - idleBalance = asset.balanceOf(address(this))
    │
    │ 2. Immediate withdrawal (if possible)
    │    - If idleBalance >= amount:
    │      * Transfer USDC to vault immediately
    │      * Update deployedCapital
    │      * Update NAV
    │      * Emit ImmediateWithdrawal event
    │      * Return (no queuing needed)
    │
    │ 3. Queue withdrawal request
    │    - If idleBalance < amount:
    │      * requestId = nextWithdrawalId++
    │      * deadline = block.timestamp + 1 hour
    │      * withdrawalQueue.push({
    │          id: requestId,
    │          amount: amount,
    │          requestedAt: block.timestamp,
    │          deadline: deadline,
    │          fulfilled: false,
    │          cancelled: false
    │        })
    │      * pendingWithdrawals += amount
    │      * Emit WithdrawalRequested event
    │
    ▼
```

**Two Paths:**
1. **Immediate**: If contract has idle funds, withdraw immediately
2. **Queued**: If funds are deployed, queue for keeper fulfillment

### Step 2: Keeper Fulfills Request

#### Keeper Detects Request

```
Keeper Bot (WithdrawalFulfiller)
    │
    │ 1. Monitor events
    │    - Listens for WithdrawalRequested events
    │    - Tracks pending requests
    │
    │ 2. Check request status
    │    - Get pending requests from contract
    │    - Check deadlines
    │    - Prioritize by deadline
    │
    │ 3. Calculate needed funds
    │    - Sum all pending requests
    │    - Check current contract balance
    │    - Calculate shortfall
    │
    │ 4. Close positions if needed
    │    - If shortfall > 0:
    │      * Identify positions to close
    │      * Close positions on exchanges
    │      * Withdraw funds from exchanges
    │
    │ 5. Bridge funds to Arbitrum
    │    - For cross-chain exchanges (Hyperliquid)
    │    - Wait for bridge completion
    │
    │ 6. Send funds to contract
    │    - Transfer USDC to KeeperStrategyManager
    │    - Ensure sufficient balance
    │
    ▼
```

**Fulfillment Process:**
- **Priority**: Fulfill by deadline (oldest first)
- **Position Closing**: May need to close positions to free capital
- **Bridge Operations**: Handle cross-chain transfers
- **Batch Processing**: Can fulfill multiple requests at once

#### Contract Fulfills Request

```
KeeperStrategyManager.fulfillWithdrawal(requestId)
    │
    │ 1. Validate request
    │    - Check requestId is valid
    │    - Check request not already fulfilled
    │    - Check request not cancelled
    │
    │ 2. Check balance
    │    - idleBalance = asset.balanceOf(address(this))
    │    - Require idleBalance >= request.amount
    │
    │ 3. Mark as fulfilled
    │    - request.fulfilled = true
    │    - pendingWithdrawals -= request.amount
    │
    │ 4. Update accounting
    │    - deployedCapital -= request.amount (if >= amount)
    │    - lastReportedNAV -= request.amount (if >= amount)
    │
    │ 5. Transfer to vault
    │    - asset.safeTransfer(vault, request.amount)
    │
    │ 6. Emit event
    │    - WithdrawalFulfilled(requestId, amount, timestamp)
    │
    ▼
```

**Batch Fulfillment:**
- `fulfillWithdrawalBatch()` can fulfill multiple requests in one transaction
- More gas efficient
- Atomic operation (all or nothing)

#### Vault Marks as Fulfilled

```
BloomStrategyVault.markWithdrawalFulfilled(requestId)
    │
    │ 1. Access control
    │    - Only owner or strategy can call
    │
    │ 2. Validate request
    │    - Check request exists
    │    - Check not already fulfilled
    │
    │ 3. Mark as fulfilled
    │    - request.fulfilled = true
    │    - totalPendingWithdrawals -= request.assets
    │    - totalFulfilledUnclaimed += request.assets
    │
    │ 4. Emit event
    │    - WithdrawalFulfilled(requestId, assets)
    │
    ▼
```

**Note:** This is typically called automatically when funds arrive, or can be called by the keeper after sending funds.

### Step 3: User Claims Withdrawal

#### User Claims Fulfilled Request

```
User
    │
    │ Calls: vault.claimWithdrawal(requestId)
    │
    │ - User specifies request ID
    │ - Must be the original requester
    │
    ▼
```

#### Vault Processes Claim

```
BloomStrategyVault.claimWithdrawal(requestId)
    │
    │ 1. Validation
    │    - Check request exists
    │    - Check user is the requester
    │    - Check request is fulfilled
    │    - Check request not already claimed
    │
    │ 2. Mark as claimed
    │    - request.claimed = true
    │    - totalFulfilledUnclaimed -= request.assets
    │    - userPendingWithdrawals[user] -= request.assets
    │
    │ 3. Transfer USDC
    │    - asset.safeTransfer(msg.sender, request.assets)
    │    - User receives USDC
    │
    │ 4. Emit event
    │    - WithdrawalClaimed(requestId, user, assets)
    │
    ▼
```

**Final Step:**
- User receives USDC in their wallet
- Withdrawal request is marked as complete
- Funds are removed from vault tracking

### Withdrawal Timeline

```
Time 0: User requests withdrawal
  ├─ Shares burned immediately
  ├─ Request created
  └─ Keeper notified

Time 0-60 minutes: Keeper fulfills
  ├─ Closes positions (if needed)
  ├─ Withdraws from exchanges
  ├─ Bridges funds (if needed)
  ├─ Sends to contract
  └─ Marks as fulfilled

Time 60 minutes: User claims
  ├─ User calls claimWithdrawal()
  └─ Receives USDC

Total Time: ~1 hour (worst case)
```

**Deadline:**
- **1 Hour**: Maximum time for keeper to fulfill
- **After Deadline**: Owner can cancel expired requests
- **User Control**: User can claim anytime after fulfillment

### Withdrawal Safety Features

#### Fund Reservation

```
Vault tracks:
    │
    │ 1. totalPendingWithdrawals
    │    - Sum of all unfulfilled requests
    │    - Funds needed but not yet available
    │
    │ 2. totalFulfilledUnclaimed
    │    - Sum of fulfilled but unclaimed requests
    │    - Funds available but user hasn't claimed
    │
    │ 3. Available for rewards
    │    - availableForRewards = vaultBalance - totalFulfilledUnclaimed
    │    - Ensures withdrawal funds aren't used for rewards
    │
    ▼
```

**Protection:**
- Withdrawal funds are reserved
- Cannot be used for reward distribution
- Ensures users can always claim fulfilled withdrawals

#### Emergency Recall

```
KeeperStrategyManager.emergencyRecall()
    │
    │ 1. Set emergency mode
    │    - emergencyMode = true
    │    - Blocks new deposits
    │
    │ 2. Request all funds
    │    - Creates withdrawal request for all deployed capital
    │    - Deadline: 1 hour
    │
    │ 3. Emit event
    │    - EmergencyRecall(deployedCapital, deadline, timestamp)
    │
    │ 4. Keeper must fulfill
    │    - Close all positions
    │    - Withdraw all funds
    │    - Return to contract
    │
    ▼
```

**Use Cases:**
- Security incident
- Exchange issues
- Strategy problems
- Admin intervention needed

---

## Rebalancing Mechanisms

### Overview

Rebalancing ensures that capital is optimally distributed across exchanges to maximize arbitrage opportunities. The system employs multiple rebalancing strategies with priority ordering.

### Exchange Balance Rebalancing

#### Detection

```
ExchangeBalanceRebalancer
    │
    │ 1. Check balances across exchanges
    │    - Get current USDC balance on each exchange
    │    - Compare to target allocation
    │
    │ 2. Calculate excess/deficit
    │    - excess = balance - targetBalance
    │    - deficit = targetBalance - balance
    │
    │ 3. Identify rebalancing needs
    │    - Exchanges with excess (> threshold)
    │    - Exchanges with deficit (> threshold)
    │
    │ 4. Create rebalance plan
    │    - Match excess to deficits
    │    - Calculate transfer amounts
    │    - Prioritize by urgency
    │
    ▼
```

**Thresholds:**
- **Minimum Transfer**: $10 (avoids dust transfers)
- **Target Allocation**: Based on opportunity distribution
- **Tolerance**: ±5% deviation acceptable

#### Execution

```
ExchangeBalanceRebalancer.executeRebalance()
    │
    │ 1. Sort exchanges
    │    - Excess queue: sorted by excess amount (descending)
    │    - Deficit queue: sorted by deficit amount (descending)
    │
    │ 2. Match transfers
    │    - For each excess exchange:
    │      * Find deficit exchange with matching need
    │      * Calculate transfer amount
    │      * Execute transfer
    │
    │ 3. Transfer methods
    │    - Direct transfer (if supported)
    │    - Withdraw + Deposit (two-step)
    │    - Bridge operations (cross-chain)
    │
    │ 4. Update tracking
    │    - Record successful transfers
    │    - Update balance tracking
    │    - Log rebalance results
    │
    ▼
```

**Transfer Methods:**
- **Hyperliquid**: Bridge from HyperCore to Arbitrum, then bridge to another exchange
- **Lighter**: Smart contract transfer (if supported)
- **Aster**: Withdraw from one, deposit to another
- **Extended**: Exchange-specific method

### Opportunity-Based Rebalancing

#### Trigger

```
When new opportunity identified:
    │
    │ 1. Check balance requirements
    │    - Required collateral for LONG position
    │    - Required collateral for SHORT position
    │
    │ 2. Check current balances
    │    - longExchange.balance
    │    - shortExchange.balance
    │
    │ 3. Calculate needs
    │    - longNeeded = max(0, requiredCollateral - longBalance)
    │    - shortNeeded = max(0, requiredCollateral - shortBalance)
    │
    ▼
```

#### Rebalancing Strategies (Priority Order)

**Strategy 1: Use Unused Exchanges**

```
BalanceManager.attemptRebalanceForOpportunity()
    │
    │ 1. Identify unused exchanges
    │    - Exchanges not in this opportunity
    │    - Have available balance
    │
    │ 2. Transfer to needed exchanges
    │    - From unused → longExchange (if longNeeded > 0)
    │    - From unused → shortExchange (if shortNeeded > 0)
    │
    │ 3. Update remaining needs
    │    - longNeeded -= transferred
    │    - shortNeeded -= transferred
    │
    ▼
```

**Strategy 2: Transfer Between Exchanges**

```
If longExchange has excess and shortExchange has deficit:
    │
    │ 1. Calculate transfer
    │    - longExcess = longBalance - requiredCollateral
    │    - shortDeficit = requiredCollateral - shortBalance
    │    - transferAmount = min(longExcess, shortDeficit)
    │
    │ 2. Execute transfer
    │    - From longExchange → shortExchange
    │    - Via exchange adapter transfer method
    │
    │ 3. Reverse if needed
    │    - If shortExchange has excess and longExchange has deficit
    │    - Transfer in opposite direction
    │
    ▼
```

**Strategy 3: Deposit from Wallet**

```
If keeper wallet has USDC:
    │
    │ 1. Check wallet balance
    │    - Get keeper's Arbitrum USDC balance
    │
    │ 2. Deposit to needed exchanges
    │    - Deposit to longExchange (if longNeeded > 0)
    │    - Deposit to shortExchange (if shortNeeded > 0)
    │
    │ 3. Update needs
    │    - longNeeded -= deposited
    │    - shortNeeded -= deposited
    │
    ▼
```

### Rebalancing Frequency

#### Automatic Rebalancing

```
PerpKeeperScheduler
    │
    │ 1. Periodic balance checks
    │    - Every execution cycle
    │    - Compare balances to targets
    │
    │ 2. Opportunity-based
    │    - Before opening new positions
    │    - Ensures sufficient collateral
    │
    │ 3. Post-execution
    │    - After closing positions
    │    - Redistribute freed capital
    │
    ▼
```

**Triggers:**
- Before position opening
- After position closing
- Periodic maintenance (configurable)
- On balance threshold breaches

#### Manual Rebalancing

```
Admin Functions:
    │
    │ 1. Force rebalance
    │    - Manual trigger
    │    - Useful for testing
    │
    │ 2. Set target allocations
    │    - Configure target per exchange
    │    - Adjust based on strategy
    │
    ▼
```

---

## Complete Flow Diagram

### End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER DEPOSIT                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 1. User deposits USDC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BloomStrategyVault                            │
│  • Mints BSV shares                                             │
│  • Settles pending rewards                                       │
│  • Allocates to strategies                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 2. Calls strategy.deposit()
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                KeeperStrategyManager                             │
│  • Receives USDC                                                │
│  • Updates deployedCapital                                      │
│  • Updates NAV                                                  │
│  • Emits CapitalDeployed event                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 3. Keeper detects event
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Keeper Bot                                  │
│  • Withdraws USDC to keeper wallet                              │
│  • Distributes across exchanges                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 4. Deposits to exchanges
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Exchange Wallets                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │Hyperliquid│  │ Lighter  │  │  Aster   │  │ Extended │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 5. Opens positions
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Active Positions                              │
│  • LONG on Exchange A (lower funding rate)                       │
│  • SHORT on Exchange B (higher funding rate)                    │
│  • Delta-neutral arbitrage                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 6. Funding payments (hourly)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Profit Accumulation                             │
│  • Funding payments accumulate                                   │
│  • Balance increases on exchanges                                │
│  • NAV increases                                                │
│  • Share price increases                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 7. Daily harvest (midnight UTC)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    RewardHarvester                               │
│  • Calculates harvestable profits                                │
│  • Withdraws from exchanges                                      │
│  • Bridges to Arbitrum                                           │
│  • Sends to strategy contract                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 8. Vault harvests rewards
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BloomStrategyVault                            │
│  • Calls strategy.claimRewards()                                 │
│  • Updates accRewardPerShare                                    │
│  • Rewards available for distribution                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ 9. Automatic settlement
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         USER                                     │
│  • Receives USDC rewards                                         │
│  • On deposit/withdrawal/transfer                                │
│  • Or manual claimAllRewards()                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Withdrawal Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER WITHDRAWAL                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Step 1: requestWithdrawal(shares)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BloomStrategyVault                            │
│  • Burns shares                                                 │
│  • Creates withdrawal request                                    │
│  • Calls strategy.withdraw()                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Strategy checks balance
                              ▼
                    ┌─────────┴─────────┐
                    │                   │
         ┌──────────▼──────────┐  ┌─────▼──────────────┐
         │  Immediate (idle)   │  │  Queued (deployed)  │
         │  • Transfer to vault│  │  • Create request   │
         │  • Mark fulfilled   │  │  • 1hr deadline     │
         └─────────────────────┘  └─────────────────────┘
                              │
                              │ Step 2: Keeper fulfills
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Keeper Bot                                  │
│  • Closes positions (if needed)                                  │
│  • Withdraws from exchanges                                      │
│  • Sends USDC to contract                                        │
│  • Calls fulfillWithdrawal()                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Contract marks fulfilled
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BloomStrategyVault                            │
│  • Receives USDC                                                │
│  • Marks request as fulfilled                                    │
│  • Funds available for claim                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Step 3: claimWithdrawal()
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         USER                                     │
│  • Receives USDC                                                │
│  • Withdrawal complete                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Metrics & Accounting

### On-Chain Metrics

#### Vault Metrics

```
BloomStrategyVault:
    │
    │ • totalSupply(): Total BSV shares outstanding
    │ • totalAssets(): Total USDC value (sum of strategy assets)
    │ • accRewardPerShare: Accumulated rewards per share
    │ • totalPendingWithdrawals: Unfulfilled withdrawal requests
    │ • totalFulfilledUnclaimed: Fulfilled but unclaimed
    │
    ▼
```

#### Strategy Metrics

```
KeeperStrategyManager:
    │
    │ • deployedCapital: Total principal deployed
    │ • lastReportedNAV: Current net asset value
    │ • lastNAVTimestamp: Last NAV update time
    │ • pendingWithdrawals: Queued withdrawal requests
    │ • idleBalance: USDC held in contract
    │
    ▼
```

**NAV Calculation:**
```
NAV = Sum of:
  - Exchange balances (USDC)
  - Unrealized PnL from positions
  - Accrued funding payments
  - Contract idle balance
  - Pending deposits
  - (-) Pending withdrawals
```

**Share Price:**
```
sharePrice = totalAssets() / totalSupply()

Where totalAssets() = sum of all strategy.totalAssets()
```

### Off-Chain Metrics

#### Profit Tracking

```
ProfitTracker:
    │
    │ • totalBalance: Total USDC across all exchanges
    │ • totalDeployedCapital: Total principal
    │ • totalAccruedProfit: Balance - Capital
    │ • byExchange: Per-exchange breakdown
    │ • lastHarvestTimestamp: Last harvest time
    │ • totalHarvestedAllTime: Cumulative harvested
    │
    ▼
```

#### Position Tracking

```
Position Manager:
    │
    │ • Active positions per exchange
    │ • Position size and notional value
    │ • Unrealized PnL
    │ • Funding rate exposure
    │ • Margin utilization
    │
    ▼
```

### Accounting Principles

#### Capital Tracking

```
Deployed Capital:
    │
    │ • Tracks principal only (excludes profits)
    │ • Increases on deposit
    │ • Decreases on withdrawal
    │ • Used for PnL calculation
    │
    ▼
```

#### NAV Reporting

```
NAV Updates:
    │
    │ • Reported periodically by keeper
    │ • Must be within 4 hours (staleness check)
    │ • Used for share pricing
    │ • Includes all assets and liabilities
    │
    ▼
```

#### Reward Distribution

```
Reward Accounting:
    │
    │ • Rewards accrue per share
    │ • Distributed proportionally
    │ • Settled automatically
    │ • Tracked via reward debt
    │
    ▼
```

---

## Security & Safety Features

### Withdrawal Safety

#### Two-Step Withdrawal

```
Benefits:
    │
    │ • Prevents instant exits (protects other users)
    │ • Allows async position closing
    │ • Ensures funds available before claim
    │ • Deadline enforcement (1 hour)
    │
    ▼
```

#### Fund Reservation

```
Protection:
    │
    │ • Withdrawal funds reserved
    │ • Cannot be used for rewards
    │ • Ensures claimability
    │ • Separate tracking
    │
    ▼
```

### NAV Staleness Protection

#### Staleness Check

```
KeeperStrategyManager.totalAssets():
    │
    │ • Checks lastNAVTimestamp
    │ • Reverts if > 4 hours old
    │ • Prevents stale pricing
    │ • Emergency mode fallback
    │
    ▼
```

**Purpose:**
- Prevents share pricing with outdated NAV
- Forces regular NAV updates
- Protects users from inaccurate pricing

### Emergency Controls

#### Emergency Recall

```
KeeperStrategyManager.emergencyRecall():
    │
    │ • Sets emergency mode
    │ • Blocks new deposits
    │ • Requests all funds back
    │ • 1 hour deadline
    │
    ▼
```

**Use Cases:**
- Security incidents
- Exchange issues
- Strategy problems
- Admin intervention

#### Emergency Mode

```
Effects:
    │
    │ • New deposits blocked
    │ • Withdrawals still allowed
    │ • NAV returns only idle balance
    │ • Can be exited by owner
    │
    ▼
```

### Access Control

#### Role-Based Permissions

```
Roles:
    │
    │ • Owner: Full control (vault owner)
    │ • Keeper: Operations (NAV reporting, fulfillment)
    │ • Strategy: Reward claiming
    │ • Users: Deposits, withdrawals, claims
    │
    ▼
```

**Modifiers:**
- `onlyOwner`: Vault owner only
- `onlyVault`: Strategy can only be called by vault
- `onlyKeeper`: Keeper operations only
- `notEmergency`: Blocks during emergency mode

### Reentrancy Protection

```
All state-changing functions:
    │
    │ • Use ReentrancyGuard
    │ • Prevents reentrancy attacks
    │ • Standard OpenZeppelin pattern
    │
    ▼
```

---

## Conclusion

The Bloom Funding Arbitrage System implements a sophisticated flow of funds that enables users to earn yield from funding rate arbitrage while maintaining security, transparency, and user control. The system's architecture ensures:

✅ **Efficient Capital Deployment**: Funds are automatically deployed across exchanges to maximize opportunities

✅ **Automatic Profit Collection**: Daily harvesting ensures profits are regularly collected and distributed

✅ **Fair Reward Distribution**: Dividend-style distribution ensures proportional rewards based on share ownership

✅ **Safe Withdrawals**: Two-step process protects users and allows async position management

✅ **Real-Time Tracking**: Comprehensive metrics and accounting provide transparency

✅ **Security First**: Multiple safety features protect user funds and system integrity

The system's design balances automation with user control, enabling passive yield generation while maintaining the flexibility for users to deposit and withdraw at any time.

---

## Appendix: Key Contract Addresses

*Note: Update with actual deployed addresses*

- **BloomStrategyVault**: `0x...`
- **KeeperStrategyManager**: `0x...`
- **USDC (Arbitrum)**: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`

---

## Appendix: Configuration Variables

### Environment Variables

- `KEEPER_STRATEGY_ADDRESS`: Strategy contract address
- `USDC_ADDRESS`: USDC token address
- `ARBITRUM_RPC_URL`: RPC endpoint for Arbitrum
- `KEEPER_PRIVATE_KEY`: Keeper wallet private key
- `MIN_HARVEST_AMOUNT_USD`: Minimum harvest threshold (default: 10)
- `HARVEST_INTERVAL_HOURS`: Harvest frequency (default: 24)

---

*Document Version: 1.0*  
*Last Updated: [Current Date]*



