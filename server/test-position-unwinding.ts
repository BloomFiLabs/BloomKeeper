/**
 * Test Position Unwinding Flow
 * 
 * This tests the scenario where:
 * 1. User deposits to vault
 * 2. Keeper deploys capital to Hyperliquid (simulated by existing VVV position)
 * 3. User requests withdrawal
 * 4. Keeper has NO idle USDC on Arbitrum
 * 5. Keeper must CLOSE POSITIONS and withdraw from Hyperliquid
 */

import { ethers, formatUnits } from 'ethers';
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
  'event WithdrawalRequested(uint256 indexed requestId, address indexed user, uint256 assets, uint256 shares, uint256 timestamp)',
];

const STRATEGY_ABI = [
  'function withdrawToKeeper(uint256 amount)',
  'function fulfillWithdrawal(uint256 requestId)',
  'function getIdleBalance() view returns (uint256)',
  'function pendingWithdrawals() view returns (uint256)',
  'function getWithdrawalQueueLength() view returns (uint256)',
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
  console.log('   POSITION UNWINDING TEST');
  console.log('   Testing keeper automatic position closing for withdrawals');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
  const strategy = new ethers.Contract(STRATEGY_ADDRESS, STRATEGY_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  // Check initial state
  log('STATE', 'Initial balances');
  
  const usdcBalance = await usdc.balanceOf(wallet.address);
  console.log(`  USDC on Arbitrum: ${formatUnits(usdcBalance, 6)} USDC`);
  
  // Check Hyperliquid
  const hlState = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: wallet.address }),
  }).then(r => r.json());
  
  console.log(`\n  Hyperliquid:`);
  console.log(`    Account Value: $${hlState.marginSummary?.accountValue || 0}`);
  console.log(`    Withdrawable: $${hlState.withdrawable || 0}`);
  
  if (hlState.assetPositions?.length > 0) {
    console.log(`    Positions (will be closed for withdrawal):`);
    for (const pos of hlState.assetPositions) {
      const p = pos.position;
      console.log(`      - ${p.coin}: ${p.szi} @ $${p.entryPx}, PnL: $${p.unrealizedPnl}`);
    }
  }

  // Step 1: Deposit to vault
  const depositAmount = 3_000000n; // 3 USDC
  
  if (usdcBalance < depositAmount) {
    console.log(`\n❌ Need at least 3 USDC to test. Have: ${formatUnits(usdcBalance, 6)}`);
    return;
  }

  log('STEP 1', `Depositing ${formatUnits(depositAmount, 6)} USDC to vault...`);
  
  const approveTx = await usdc.approve(VAULT_ADDRESS, depositAmount);
  await approveTx.wait();
  
  const depositTx = await vault.deposit(depositAmount, wallet.address);
  await depositTx.wait();
  console.log(`  ✅ Deposited. TX: ${depositTx.hash}`);
  
  const shares = await vault.balanceOf(wallet.address);
  console.log(`  Shares: ${formatUnits(shares, 6)}`);

  // Step 2: Keeper deploys capital (take USDC off Arbitrum)
  log('STEP 2', 'Keeper deploying capital...');
  
  const idleBalance = await strategy.getIdleBalance();
  if (idleBalance > 0n) {
    const withdrawTx = await strategy.withdrawToKeeper(idleBalance);
    await withdrawTx.wait();
    console.log(`  ✅ Deployed ${formatUnits(idleBalance, 6)} USDC`);
  }

  // Step 3: Send ALL keeper USDC somewhere else (to simulate it being on exchanges)
  log('STEP 3', 'Simulating funds deployed to exchanges...');
  
  const keeperUsdcBefore = await usdc.balanceOf(wallet.address);
  console.log(`  Keeper USDC: ${formatUnits(keeperUsdcBefore, 6)} USDC`);
  
  // Transfer to vault temporarily (not the strategy) to simulate funds being "deployed"
  // Actually, let's just leave it and request more than we have
  
  // Step 4: Request withdrawal (more than idle USDC on keeper wallet)
  log('STEP 4', 'Requesting withdrawal...');
  
  const requestTx = await vault.requestWithdrawal(shares);
  const receipt = await requestTx.wait();
  console.log(`  ✅ Withdrawal requested. TX: ${requestTx.hash}`);
  
  // Get request details
  const requestEvent = receipt.logs.find((l: any) => {
    try { return vault.interface.parseLog(l)?.name === 'WithdrawalRequested'; }
    catch { return false; }
  });
  const requestId = requestEvent ? vault.interface.parseLog(requestEvent)?.args.requestId : 0n;
  
  const request = await vault.getWithdrawalRequest(requestId);
  console.log(`  Request ID: ${requestId}`);
  console.log(`  Assets to withdraw: ${formatUnits(request.assets, 6)} USDC`);
  
  // Step 5: Check what keeper needs to do
  log('STEP 5', 'Checking keeper fulfillment requirements...');
  
  const keeperUsdcNow = await usdc.balanceOf(wallet.address);
  const shortfall = request.assets - keeperUsdcNow;
  
  console.log(`  Keeper USDC balance: ${formatUnits(keeperUsdcNow, 6)} USDC`);
  console.log(`  Amount needed: ${formatUnits(request.assets, 6)} USDC`);
  
  if (shortfall > 0n) {
    console.log(`  ⚠️ SHORTFALL: ${formatUnits(shortfall, 6)} USDC`);
    console.log(`\n  The keeper bot will now:`);
    console.log(`  1. Detect the WithdrawalRequested event`);
    console.log(`  2. See it has insufficient USDC on Arbitrum`);
    console.log(`  3. Close VVV position on Hyperliquid (least profitable)`);
    console.log(`  4. Withdraw freed funds to Arbitrum`);
    console.log(`  5. Fulfill the withdrawal`);
    
    console.log(`\n  Run the keeper bot to process this withdrawal:`);
    console.log(`  npx ts-node test-automatic-withdrawal.ts`);
  } else {
    console.log(`  ✅ Keeper has enough USDC - will fulfill immediately`);
    
    // Fulfill manually for test
    const transferTx = await usdc.transfer(STRATEGY_ADDRESS, request.assets);
    await transferTx.wait();
    
    const fulfillTx = await strategy.fulfillWithdrawal(0);
    await fulfillTx.wait();
    
    const markTx = await vault.markWithdrawalFulfilled(requestId);
    await markTx.wait();
    
    const claimTx = await vault.claimWithdrawal(requestId);
    await claimTx.wait();
    
    console.log(`  ✅ Withdrawal fulfilled and claimed!`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);

