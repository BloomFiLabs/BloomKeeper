/**
 * Test Keeper Withdrawal Flow
 * 
 * This script tests the complete keeper-driven withdrawal flow:
 * 1. Deposit USDC to vault (simulated or real)
 * 2. Request withdrawal from vault
 * 3. Keeper sees WithdrawalRequested event
 * 4. Keeper closes positions (least profitable first)
 * 5. Keeper withdraws from Hyperliquid to Arbitrum
 * 6. Keeper sends USDC to strategy contract
 * 7. Keeper calls strategy.fulfillWithdrawal()
 * 8. Keeper calls vault.markWithdrawalFulfilled()
 * 9. User claims from vault
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const VAULT_ADDRESS = '0xb401ff818d0b1DACcFe94929c3A09Ab5a6ec7033';
const STRATEGY_ADDRESS = '0x3E67817526F65C8D21b3242B2C284b64CC555C58';
const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

const VAULT_ABI = [
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function requestWithdrawal(uint256 shares) returns (uint256 requestId)',
  'function claimWithdrawal(uint256 requestId)',
  'function markWithdrawalFulfilled(uint256 requestId)',
  'function getWithdrawalRequest(uint256 requestId) view returns (tuple(uint256 id, address user, uint256 assets, uint256 shares, uint256 requestedAt, bool fulfilled, bool claimed))',
  'function balanceOf(address account) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function nextWithdrawalId() view returns (uint256)',
  'event WithdrawalRequested(uint256 indexed requestId, address indexed user, uint256 assets, uint256 shares, uint256 timestamp)',
];

const STRATEGY_ABI = [
  'function withdrawToKeeper(uint256 amount)',
  'function fulfillWithdrawal(uint256 requestId)',
  'function getIdleBalance() view returns (uint256)',
  'function pendingWithdrawals() view returns (uint256)',
  'function getWithdrawalQueueLength() view returns (uint256)',
  'event WithdrawalRequested(uint256 indexed requestId, uint256 amount, uint256 deadline)',
];

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

function log(step: string, msg: string) {
  console.log(`\n[${step}] ${msg}`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       KEEPER WITHDRAWAL FLOW TEST');
  console.log('═══════════════════════════════════════════════════════════════');

  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
  const strategy = new ethers.Contract(STRATEGY_ADDRESS, STRATEGY_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  console.log(`\nWallet: ${wallet.address}`);
  console.log(`Vault: ${VAULT_ADDRESS}`);
  console.log(`Strategy: ${STRATEGY_ADDRESS}`);

  // Check initial state
  log('STATE', 'Checking initial balances...');
  
  const usdcBalance = await usdc.balanceOf(wallet.address);
  const vaultShares = await vault.balanceOf(wallet.address);
  const strategyIdle = await strategy.getIdleBalance();
  const strategyPending = await strategy.pendingWithdrawals();
  
  console.log(`  USDC on Arbitrum: ${Number(usdcBalance) / 1e6} USDC`);
  console.log(`  Vault shares: ${Number(vaultShares) / 1e6}`);
  console.log(`  Strategy idle: ${Number(strategyIdle) / 1e6} USDC`);
  console.log(`  Strategy pending: ${Number(strategyPending) / 1e6} USDC`);

  // Check Hyperliquid state
  log('HL', 'Checking Hyperliquid state...');
  
  const hlState = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: wallet.address }),
  }).then(r => r.json());
  
  console.log(`  Account Value: $${hlState.marginSummary?.accountValue || 0}`);
  console.log(`  Margin Used: $${hlState.marginSummary?.totalMarginUsed || 0}`);
  console.log(`  Withdrawable: $${hlState.withdrawable || 0}`);
  
  if (hlState.assetPositions?.length > 0) {
    console.log(`  Positions:`);
    for (const pos of hlState.assetPositions) {
      const p = pos.position;
      console.log(`    - ${p.coin}: ${p.szi} @ ${p.entryPx}, PnL: $${p.unrealizedPnl}`);
    }
  }

  // Check spot balance
  const spotState = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'spotClearinghouseState', user: wallet.address }),
  }).then(r => r.json());
  
  const spotUsdc = spotState.balances?.find((b: any) => b.coin === 'USDC');
  console.log(`  Spot USDC: $${spotUsdc?.total || 0}`);

  // Determine test approach based on available funds
  if (Number(usdcBalance) > 1_000000n) {
    log('TEST', 'Have USDC on Arbitrum - testing full flow');
    await testFullFlow(wallet, vault, strategy, usdc, usdcBalance);
  } else if (vaultShares > 0n) {
    log('TEST', 'Have vault shares - testing withdrawal flow');
    await testWithdrawalOnly(wallet, vault, strategy, usdc, vaultShares);
  } else {
    log('INFO', 'No funds available for live test');
    console.log('\nTo test the full flow:');
    console.log('1. Get some USDC on Arbitrum (swap ETH or bridge)');
    console.log('2. Or withdraw from Hyperliquid to Arbitrum');
    console.log('\nAlternatively, the keeper bot will handle this automatically when:');
    console.log('- User deposits to vault');
    console.log('- User requests withdrawal');
    console.log('- Keeper sees events and processes them');
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

async function testFullFlow(
  wallet: ethers.Wallet,
  vault: ethers.Contract,
  strategy: ethers.Contract,
  usdc: ethers.Contract,
  usdcBalance: bigint,
) {
  const testAmount = usdcBalance < 5_000000n ? usdcBalance : 5_000000n;
  
  // Step 1: Approve vault
  log('STEP 1', 'Approving vault...');
  const approveTx = await usdc.approve(VAULT_ADDRESS, ethers.MaxUint256);
  await approveTx.wait();
  console.log('  ✅ Approved');

  // Step 2: Deposit to vault
  log('STEP 2', `Depositing ${Number(testAmount) / 1e6} USDC to vault...`);
  const depositTx = await vault.deposit(testAmount, wallet.address);
  const depositReceipt = await depositTx.wait();
  console.log(`  ✅ Deposited - TX: ${depositReceipt.hash}`);
  
  const shares = await vault.balanceOf(wallet.address);
  console.log(`  Shares received: ${Number(shares) / 1e6}`);

  // Step 3: Keeper deploys capital
  log('STEP 3', 'Keeper deploying capital to exchanges...');
  const idleBalance = await strategy.getIdleBalance();
  if (idleBalance > 0n) {
    const deployTx = await strategy.withdrawToKeeper(idleBalance);
    await deployTx.wait();
    console.log(`  ✅ Withdrew ${Number(idleBalance) / 1e6} USDC to keeper`);
  }

  // Step 4: Request withdrawal
  log('STEP 4', 'Requesting withdrawal from vault...');
  const requestTx = await vault.requestWithdrawal(shares);
  const requestReceipt = await requestTx.wait();
  console.log(`  ✅ Withdrawal requested - TX: ${requestReceipt.hash}`);
  
  // Get request ID from event
  const requestEvent = requestReceipt.logs.find((l: any) => {
    try { return vault.interface.parseLog(l)?.name === 'WithdrawalRequested'; }
    catch { return false; }
  });
  const requestId = requestEvent ? vault.interface.parseLog(requestEvent)?.args.requestId : 0n;
  console.log(`  Request ID: ${requestId}`);

  // Step 5: Simulate keeper fulfillment
  log('STEP 5', 'Simulating keeper fulfillment...');
  console.log('  In production, the keeper bot would:');
  console.log('  1. See the WithdrawalRequested event');
  console.log('  2. Close positions on Hyperliquid (least profitable first)');
  console.log('  3. Withdraw from Hyperliquid to Arbitrum');
  console.log('  4. Transfer USDC to strategy contract');
  console.log('  5. Call strategy.fulfillWithdrawal()');
  console.log('  6. Call vault.markWithdrawalFulfilled()');
  
  // For this test, we'll manually fulfill since keeper may not have funds
  const keeperUsdcBalance = await usdc.balanceOf(wallet.address);
  const request = await vault.getWithdrawalRequest(requestId);
  
  if (keeperUsdcBalance >= request.assets) {
    console.log(`\n  Manually fulfilling with available USDC...`);
    
    // Transfer to strategy
    const transferTx = await usdc.transfer(STRATEGY_ADDRESS, request.assets);
    await transferTx.wait();
    console.log(`  ✅ Transferred ${Number(request.assets) / 1e6} USDC to strategy`);
    
    // Fulfill on strategy
    const fulfillTx = await strategy.fulfillWithdrawal(0);
    await fulfillTx.wait();
    console.log(`  ✅ Strategy withdrawal fulfilled`);
    
    // Mark vault as fulfilled
    const markTx = await vault.markWithdrawalFulfilled(requestId);
    await markTx.wait();
    console.log(`  ✅ Vault withdrawal marked fulfilled`);
    
    // Step 6: Claim withdrawal
    log('STEP 6', 'User claiming withdrawal...');
    const claimTx = await vault.claimWithdrawal(requestId);
    await claimTx.wait();
    console.log(`  ✅ Withdrawal claimed!`);
    
    const finalBalance = await usdc.balanceOf(wallet.address);
    console.log(`  Final USDC balance: ${Number(finalBalance) / 1e6} USDC`);
  } else {
    console.log(`\n  ⚠️ Keeper has insufficient USDC to fulfill manually`);
    console.log(`  Need: ${Number(request.assets) / 1e6} USDC`);
    console.log(`  Have: ${Number(keeperUsdcBalance) / 1e6} USDC`);
    console.log(`  Run the keeper bot to process this withdrawal automatically`);
  }
}

async function testWithdrawalOnly(
  wallet: ethers.Wallet,
  vault: ethers.Contract,
  strategy: ethers.Contract,
  usdc: ethers.Contract,
  shares: bigint,
) {
  log('STEP 1', 'Requesting withdrawal from vault...');
  const requestTx = await vault.requestWithdrawal(shares);
  const requestReceipt = await requestTx.wait();
  console.log(`  ✅ Withdrawal requested - TX: ${requestReceipt.hash}`);
  
  const requestEvent = requestReceipt.logs.find((l: any) => {
    try { return vault.interface.parseLog(l)?.name === 'WithdrawalRequested'; }
    catch { return false; }
  });
  const requestId = requestEvent ? vault.interface.parseLog(requestEvent)?.args.requestId : 0n;
  console.log(`  Request ID: ${requestId}`);
  
  const request = await vault.getWithdrawalRequest(requestId);
  console.log(`  Assets to receive: ${Number(request.assets) / 1e6} USDC`);
  console.log(`  Status: ${request.fulfilled ? 'Fulfilled' : 'Pending'}`);
  
  console.log('\n  The keeper bot will now:');
  console.log('  1. Detect the WithdrawalRequested event');
  console.log('  2. Close positions on exchanges (least profitable first)');
  console.log('  3. Withdraw USDC from Hyperliquid to Arbitrum');
  console.log('  4. Send USDC to strategy contract');
  console.log('  5. Call strategy.fulfillWithdrawal()');
  console.log('  6. Call vault.markWithdrawalFulfilled()');
  console.log('  7. Then you can call vault.claimWithdrawal()');
}

main().catch(console.error);

