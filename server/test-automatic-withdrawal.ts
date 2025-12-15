/**
 * Test Automatic Withdrawal Processing
 * 
 * This test demonstrates that the keeper bot automatically:
 * 1. Detects withdrawal requests
 * 2. Closes positions (least profitable first) if needed
 * 3. Withdraws from exchanges
 * 4. Fulfills the withdrawal
 * 
 * Run this in one terminal, then deposit and request withdrawal in another.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { WithdrawalFulfiller } from './src/infrastructure/adapters/blockchain/WithdrawalFulfiller';
import { KeeperStrategyEventListener } from './src/infrastructure/adapters/blockchain/KeeperStrategyEventListener';
import { HyperliquidExchangeAdapter } from './src/infrastructure/adapters/hyperliquid/HyperliquidExchangeAdapter';
import { ethers, formatUnits } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const VAULT_ADDRESS = '0xb401ff818d0b1DACcFe94929c3A09Ab5a6ec7033';
const STRATEGY_ADDRESS = '0x3E67817526F65C8D21b3242B2C284b64CC555C58';
const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   AUTOMATIC WITHDRAWAL PROCESSING TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Start the NestJS app to initialize all services
  console.log('Starting keeper bot services...\n');
  
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  // Get the services
  const withdrawalFulfiller = app.get(WithdrawalFulfiller);
  const eventListener = app.get(KeeperStrategyEventListener);
  
  console.log('✅ Services initialized\n');
  
  // Check current state
  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   CURRENT STATE');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Check USDC balance on Arbitrum
  const usdc = new ethers.Contract(USDC_ADDRESS, [
    'function balanceOf(address) view returns (uint256)',
  ], provider);
  const usdcBalance = await usdc.balanceOf(wallet.address);
  console.log(`USDC on Arbitrum: ${formatUnits(usdcBalance, 6)} USDC`);
  
  // Check Hyperliquid positions
  const hlState = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: wallet.address }),
  }).then(r => r.json());
  
  console.log(`\nHyperliquid:`);
  console.log(`  Account Value: $${hlState.marginSummary?.accountValue || 0}`);
  console.log(`  Withdrawable: $${hlState.withdrawable || 0}`);
  
  if (hlState.assetPositions?.length > 0) {
    console.log(`  Positions:`);
    for (const pos of hlState.assetPositions) {
      const p = pos.position;
      console.log(`    - ${p.coin}: ${p.szi} @ $${p.entryPx}, PnL: $${p.unrealizedPnl}`);
    }
  }
  
  // Check pending withdrawals
  const pending = withdrawalFulfiller.getPendingWithdrawalsList();
  console.log(`\nPending withdrawals in queue: ${pending.length}`);
  for (const w of pending) {
    console.log(`  - #${w.requestId}: ${formatUnits(w.amount, 6)} USDC, status: ${w.status}`);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('   MANUAL TRIGGER TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Process any pending withdrawals
  if (pending.length > 0) {
    console.log('Processing pending withdrawals...\n');
    const results = await withdrawalFulfiller.processPendingWithdrawals();
    console.log(`Results: processed=${results.processed}, fulfilled=${results.fulfilled}, failed=${results.failed}`);
  } else {
    console.log('No pending withdrawals to process.\n');
    console.log('To test the full flow:');
    console.log('1. Get USDC on Arbitrum (bridge or swap)');
    console.log('2. Approve vault: cast send USDC approve(VAULT, MAX) ...');
    console.log('3. Deposit: cast send VAULT "deposit(uint256,address)" AMOUNT YOUR_ADDRESS ...');
    console.log('4. Request withdrawal: cast send VAULT "requestWithdrawal(uint256)" SHARES ...');
    console.log('5. The keeper will automatically detect and process the withdrawal\n');
    
    console.log('Or simulate a withdrawal event manually:');
    console.log('This will trigger the keeper to close positions and withdraw from exchanges.\n');
  }

  // Keep alive for event listening
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   LISTENING FOR EVENTS (Ctrl+C to stop)');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Process withdrawals periodically
  setInterval(async () => {
    const pending = withdrawalFulfiller.getPendingWithdrawalsList();
    if (pending.length > 0) {
      console.log(`\n[${new Date().toISOString()}] Processing ${pending.length} pending withdrawal(s)...`);
      const results = await withdrawalFulfiller.processPendingWithdrawals();
      console.log(`Results: processed=${results.processed}, fulfilled=${results.fulfilled}, failed=${results.failed}`);
    }
  }, 30000); // Check every 30 seconds

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await app.close();
    process.exit(0);
  });
}

main().catch(console.error);

