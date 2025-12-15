/**
 * Close VVV Position and Withdraw to Arbitrum
 * This frees up funds to test the vault withdrawal flow
 */

import * as dotenv from 'dotenv';
import { Hyperliquid } from 'hyperliquid';
import { ethers } from 'ethers';

dotenv.config();

const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       CLOSE POSITION & WITHDRAW TO ARBITRUM');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const walletAddress = '0xa90714a15D6e5C0EB3096462De8dc4B22E01589A';
  
  // Get current state
  console.log('[1/5] Checking current state...\n');
  
  const perpState = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: walletAddress }),
  }).then(r => r.json());
  
  console.log(`  Account Value: $${perpState.marginSummary.accountValue}`);
  console.log(`  Margin Used: $${perpState.marginSummary.totalMarginUsed}`);
  console.log(`  Withdrawable: $${perpState.withdrawable}`);
  
  if (perpState.assetPositions?.length > 0) {
    console.log(`\n  Open Positions:`);
    for (const pos of perpState.assetPositions) {
      const p = pos.position;
      console.log(`    - ${p.coin}: size=${p.szi} @ ${p.entryPx}, PnL: $${p.unrealizedPnl}`);
    }
  }

  // Initialize SDK
  console.log('\n[2/5] Initializing Hyperliquid SDK...\n');
  
  const sdk = new Hyperliquid({
    privateKey: process.env.PRIVATE_KEY!,
    walletAddress: walletAddress,
    testnet: false,
    enableWs: false,
  });
  
  await sdk.connect();
  console.log('  ✅ Connected to Hyperliquid');

  // Close VVV position
  if (perpState.assetPositions?.length > 0) {
    console.log('\n[3/5] Closing positions...\n');
    
    for (const pos of perpState.assetPositions) {
      const p = pos.position;
      const symbol = p.coin;
      const size = parseFloat(p.szi);
      
      console.log(`  Closing ${symbol} position (size: ${size})...`);
      
      // If size is negative (short), we need to buy to close
      // If size is positive (long), we need to sell to close
      const isBuy = size < 0; // Short position -> buy to close
      const closeSize = Math.abs(size);
      
      try {
        const result = await sdk.exchange.marketOrder(
          symbol,
          isBuy,
          closeSize,
          undefined, // slippage
          undefined, // cloid
          undefined  // grouping
        );
        
        console.log(`  Result:`, JSON.stringify(result, null, 2));
        
        if (result.status === 'ok') {
          console.log(`  ✅ Closed ${symbol} position`);
        } else {
          console.log(`  ⚠️ Close failed: ${JSON.stringify(result)}`);
        }
      } catch (e: any) {
        console.log(`  ❌ Error closing position: ${e.message}`);
      }
      
      // Wait a bit between operations
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Check new state
  console.log('\n[4/5] Checking updated state...\n');
  
  const newPerpState = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: walletAddress }),
  }).then(r => r.json());
  
  console.log(`  Account Value: $${newPerpState.marginSummary.accountValue}`);
  console.log(`  Withdrawable: $${newPerpState.withdrawable}`);
  
  const withdrawable = parseFloat(newPerpState.withdrawable || '0');
  
  if (withdrawable < 2) {
    console.log('\n  ⚠️ Not enough withdrawable funds (need at least $2 to cover $1 fee)');
    
    // Check spot and maybe transfer
    const spotState = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: walletAddress }),
    }).then(r => r.json());
    
    const spotUsdc = parseFloat(spotState.balances?.find((b: any) => b.coin === 'USDC')?.total || '0');
    console.log(`  Spot USDC: $${spotUsdc}`);
    
    if (spotUsdc > 2) {
      console.log('\n  Transferring spot USDC to perp account...');
      try {
        const transferResult = await sdk.exchange.transferBetweenSpotAndPerp(spotUsdc, false);
        console.log(`  Transfer result:`, transferResult);
      } catch (e: any) {
        console.log(`  Transfer method may not exist, trying alternative...`);
        // Try using the internal transfer if available
      }
    }
    
    return;
  }

  // Withdraw to Arbitrum
  console.log('\n[5/5] Withdrawing to Arbitrum...\n');
  
  // Leave $1 buffer for fees
  const withdrawAmount = withdrawable - 1.5; // Extra buffer for safety
  
  if (withdrawAmount < 1) {
    console.log('  Not enough to withdraw after fees');
    return;
  }
  
  console.log(`  Withdrawing $${withdrawAmount.toFixed(2)} to ${walletAddress}...`);
  
  try {
    const result = await sdk.exchange.initiateWithdrawal(walletAddress, withdrawAmount);
    console.log(`  Withdrawal result:`, JSON.stringify(result, null, 2));
    
    if (result.status === 'ok') {
      console.log(`  ✅ Withdrawal initiated! Funds will arrive on Arbitrum in 30-120 seconds.`);
      
      // Wait and check Arbitrum balance
      console.log('\n  Waiting for funds to arrive...');
      
      const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
      const usdc = new ethers.Contract(USDC_ADDRESS, [
        'function balanceOf(address) view returns (uint256)'
      ], provider);
      
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const balance = await usdc.balanceOf(walletAddress);
        console.log(`  Balance check ${i + 1}/12: ${Number(balance) / 1e6} USDC`);
        
        if (Number(balance) > 1_000000) {
          console.log(`\n  ✅ Funds arrived! You can now run test-keeper-withdrawal-flow.ts`);
          break;
        }
      }
    } else {
      console.log(`  ⚠️ Withdrawal failed: ${JSON.stringify(result)}`);
    }
  } catch (e: any) {
    console.log(`  ❌ Error: ${e.message}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);

