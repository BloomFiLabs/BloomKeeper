/**
 * Full Withdrawal Flow Test
 * 
 * Tests the complete two-step withdrawal flow:
 * 1. Withdraw USDC from Hyperliquid to Arbitrum
 * 2. Deposit USDC to BloomStrategyVault
 * 3. Request withdrawal from vault
 * 4. Fulfill withdrawal (keeper role)
 * 5. Claim withdrawal (user role)
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const VAULT_ADDRESS = '0xb401ff818d0b1DACcFe94929c3A09Ab5a6ec7033';
const STRATEGY_ADDRESS = '0x3E67817526F65C8D21b3242B2C284b64CC555C58';
const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const TEST_AMOUNT = 4_000000n; // 4 USDC (leaving some buffer)

const VAULT_ABI = [
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function requestWithdrawal(uint256 shares) returns (uint256 requestId)',
  'function claimWithdrawal(uint256 requestId)',
  'function markWithdrawalFulfilled(uint256 requestId)',
  'function getWithdrawalRequest(uint256 requestId) view returns (tuple(uint256 id, address user, uint256 assets, uint256 shares, uint256 requestedAt, bool fulfilled, bool claimed))',
  'function balanceOf(address account) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function nextWithdrawalId() view returns (uint256)',
  'function totalPendingWithdrawals() view returns (uint256)',
  'function totalFulfilledUnclaimed() view returns (uint256)',
  'event WithdrawalRequested(uint256 indexed requestId, address indexed user, uint256 assets, uint256 shares, uint256 timestamp)',
  'event WithdrawalFulfilled(uint256 indexed requestId, uint256 assets)',
  'event WithdrawalClaimed(uint256 indexed requestId, address indexed user, uint256 assets)',
];

const STRATEGY_ABI = [
  'function withdrawToKeeper(uint256 amount)',
  'function fulfillWithdrawal(uint256 requestId)',
  'function getIdleBalance() view returns (uint256)',
  'function pendingWithdrawals() view returns (uint256)',
  'function deployedCapital() view returns (uint256)',
  'function lastReportedNAV() view returns (uint256)',
  'function getWithdrawalQueueLength() view returns (uint256)',
  'event WithdrawalRequested(uint256 indexed requestId, uint256 amount, uint256 deadline)',
  'event WithdrawalFulfilled(uint256 indexed requestId, uint256 amount, uint256 timestamp)',
];

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withdrawFromHyperliquid(amount: string, walletAddress: string): Promise<boolean> {
  const { Hyperliquid } = await import('hyperliquid');
  
  const sdk = new Hyperliquid({
    privateKey: process.env.PRIVATE_KEY!,
    walletAddress: walletAddress,
    testnet: false,
    enableWs: false,
  });
  
  await sdk.connect();
  
  console.log(`\n📤 Withdrawing ${amount} USDC from Hyperliquid to ${walletAddress}...`);
  
  try {
    // initiateWithdrawal(destination, amount as number)
    const result = await sdk.exchange.initiateWithdrawal(walletAddress, parseFloat(amount));
    console.log('Withdrawal initiated:', result);
    return true;
  } catch (e: any) {
    console.error('Withdrawal error:', e.message);
    return false;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('           FULL WITHDRAWAL FLOW TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
  const strategy = new ethers.Contract(STRATEGY_ADDRESS, STRATEGY_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  
  console.log(`Wallet: ${wallet.address}`);
  console.log(`Vault: ${VAULT_ADDRESS}`);
  console.log(`Strategy: ${STRATEGY_ADDRESS}`);
  console.log(`Test Amount: ${Number(TEST_AMOUNT) / 1e6} USDC\n`);

  // Check initial USDC balance
  let usdcBalance = await usdc.balanceOf(wallet.address);
  console.log(`📊 Initial USDC Balance: ${Number(usdcBalance) / 1e6} USDC`);

  // Step 0: Withdraw from Hyperliquid if needed
  if (usdcBalance < TEST_AMOUNT) {
    console.log('\n⚠️  Insufficient USDC on Arbitrum. Withdrawing from Hyperliquid...');
    
    const withdrawAmount = '10'; // Withdraw 10 USDC
    const success = await withdrawFromHyperliquid(withdrawAmount, wallet.address);
    
    if (success) {
      console.log('⏳ Waiting for withdrawal to arrive (30-60 seconds)...');
      
      // Poll for balance change
      for (let i = 0; i < 12; i++) {
        await sleep(10000);
        usdcBalance = await usdc.balanceOf(wallet.address);
        console.log(`   Balance check ${i + 1}/12: ${Number(usdcBalance) / 1e6} USDC`);
        if (usdcBalance >= TEST_AMOUNT) {
          console.log('✅ USDC received!');
          break;
        }
      }
    }
    
    if (usdcBalance < TEST_AMOUNT) {
      console.error('❌ Still insufficient USDC after withdrawal attempt');
      process.exit(1);
    }
  }

  // Step 1: Approve vault to spend USDC
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STEP 1: Approve Vault');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const allowance = await usdc.allowance(wallet.address, VAULT_ADDRESS);
  if (allowance < TEST_AMOUNT) {
    console.log('Approving vault to spend USDC...');
    const approveTx = await usdc.approve(VAULT_ADDRESS, ethers.MaxUint256);
    await approveTx.wait();
    console.log('✅ Approved');
  } else {
    console.log('✅ Already approved');
  }

  // Step 2: Deposit to vault
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STEP 2: Deposit to Vault');
  console.log('═══════════════════════════════════════════════════════════════');
  
  console.log(`Depositing ${Number(TEST_AMOUNT) / 1e6} USDC...`);
  const depositTx = await vault.deposit(TEST_AMOUNT, wallet.address);
  const depositReceipt = await depositTx.wait();
  console.log(`✅ Deposit TX: ${depositReceipt.hash}`);
  
  const shares = await vault.balanceOf(wallet.address);
  console.log(`   Shares received: ${Number(shares) / 1e6}`);
  
  // Check strategy state
  const strategyIdle = await strategy.getIdleBalance();
  console.log(`   Strategy idle balance: ${Number(strategyIdle) / 1e6} USDC`);

  // Step 3: Keeper withdraws capital (simulating deployment to exchanges)
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STEP 3: Keeper Withdraws Capital (simulates exchange deployment)');
  console.log('═══════════════════════════════════════════════════════════════');
  
  if (strategyIdle > 0n) {
    console.log(`Keeper withdrawing ${Number(strategyIdle) / 1e6} USDC from strategy...`);
    const withdrawToKeeperTx = await strategy.withdrawToKeeper(strategyIdle);
    await withdrawToKeeperTx.wait();
    console.log('✅ Capital withdrawn to keeper wallet');
    
    const keeperUsdcBalance = await usdc.balanceOf(wallet.address);
    console.log(`   Keeper USDC balance: ${Number(keeperUsdcBalance) / 1e6} USDC`);
  }

  // Step 4: User requests withdrawal
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STEP 4: User Requests Withdrawal');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const sharesToWithdraw = await vault.balanceOf(wallet.address);
  console.log(`Requesting withdrawal of ${Number(sharesToWithdraw) / 1e6} shares...`);
  
  const requestTx = await vault.requestWithdrawal(sharesToWithdraw);
  const requestReceipt = await requestTx.wait();
  console.log(`✅ Request TX: ${requestReceipt.hash}`);
  
  // Parse event to get request ID
  const requestEvent = requestReceipt.logs.find((log: any) => {
    try {
      const parsed = vault.interface.parseLog(log);
      return parsed?.name === 'WithdrawalRequested';
    } catch { return false; }
  });
  
  let vaultRequestId = 0n;
  if (requestEvent) {
    const parsed = vault.interface.parseLog(requestEvent);
    vaultRequestId = parsed?.args.requestId;
    console.log(`   Vault Request ID: ${vaultRequestId}`);
    console.log(`   Assets to withdraw: ${Number(parsed?.args.assets) / 1e6} USDC`);
  }
  
  // Check vault request
  const vaultRequest = await vault.getWithdrawalRequest(vaultRequestId);
  console.log(`   Request status - Fulfilled: ${vaultRequest.fulfilled}, Claimed: ${vaultRequest.claimed}`);
  
  // Check strategy queue
  const strategyQueueLength = await strategy.getWithdrawalQueueLength();
  const strategyPending = await strategy.pendingWithdrawals();
  console.log(`   Strategy queue length: ${strategyQueueLength}`);
  console.log(`   Strategy pending withdrawals: ${Number(strategyPending) / 1e6} USDC`);

  // Step 5: Keeper fulfills withdrawal
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STEP 5: Keeper Fulfills Withdrawal');
  console.log('═══════════════════════════════════════════════════════════════');
  
  // Send USDC back to strategy
  const amountToFulfill = vaultRequest.assets;
  console.log(`Sending ${Number(amountToFulfill) / 1e6} USDC back to strategy...`);
  const transferTx = await usdc.transfer(STRATEGY_ADDRESS, amountToFulfill);
  await transferTx.wait();
  console.log('✅ USDC sent to strategy');
  
  // Fulfill on strategy
  console.log('Calling strategy.fulfillWithdrawal(0)...');
  const fulfillStrategyTx = await strategy.fulfillWithdrawal(0);
  await fulfillStrategyTx.wait();
  console.log('✅ Strategy withdrawal fulfilled - USDC sent to vault');
  
  // Mark vault request as fulfilled
  console.log('Calling vault.markWithdrawalFulfilled...');
  const markFulfilledTx = await vault.markWithdrawalFulfilled(vaultRequestId);
  await markFulfilledTx.wait();
  console.log('✅ Vault request marked as fulfilled');
  
  // Check status
  const updatedRequest = await vault.getWithdrawalRequest(vaultRequestId);
  console.log(`   Request status - Fulfilled: ${updatedRequest.fulfilled}, Claimed: ${updatedRequest.claimed}`);

  // Step 6: User claims withdrawal
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STEP 6: User Claims Withdrawal');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const balanceBefore = await usdc.balanceOf(wallet.address);
  console.log(`Balance before claim: ${Number(balanceBefore) / 1e6} USDC`);
  
  console.log('Calling vault.claimWithdrawal...');
  const claimTx = await vault.claimWithdrawal(vaultRequestId);
  const claimReceipt = await claimTx.wait();
  console.log(`✅ Claim TX: ${claimReceipt.hash}`);
  
  const balanceAfter = await usdc.balanceOf(wallet.address);
  console.log(`Balance after claim: ${Number(balanceAfter) / 1e6} USDC`);
  console.log(`USDC received: ${Number(balanceAfter - balanceBefore) / 1e6} USDC`);

  // Final state
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('FINAL STATE');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const finalRequest = await vault.getWithdrawalRequest(vaultRequestId);
  console.log(`Request ${vaultRequestId}:`);
  console.log(`  - Fulfilled: ${finalRequest.fulfilled}`);
  console.log(`  - Claimed: ${finalRequest.claimed}`);
  
  const finalShares = await vault.balanceOf(wallet.address);
  const finalVaultAssets = await vault.totalAssets();
  console.log(`\nVault State:`);
  console.log(`  - Your shares: ${Number(finalShares) / 1e6}`);
  console.log(`  - Total assets: ${Number(finalVaultAssets) / 1e6} USDC`);
  
  console.log('\n✅ FULL WITHDRAWAL FLOW COMPLETED SUCCESSFULLY! ✅\n');
}

main().catch(console.error);

