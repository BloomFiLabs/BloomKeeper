/**
 * Test script for Hyperliquid withdrawal
 * This tests the withdrawal functionality using the Hyperliquid SDK
 */

import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const DESTINATION = '0xa90714a15d6e5c0eb3096462de8dc4b22e01589a'; // Arbitrum address
const WITHDRAWAL_AMOUNT = 2.0; // USDC (must be > $1 fee)

if (!PRIVATE_KEY) {
  console.error('❌ ERROR: PRIVATE_KEY must be set in .env');
  process.exit(1);
}

async function testHyperliquidWithdrawal() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      TEST HYPERLIQUID WITHDRAWAL                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const walletAddress = wallet.address;

  console.log(`📋 Withdrawal Parameters:`);
  console.log(`   Wallet: ${walletAddress}`);
  console.log(`   Destination: ${DESTINATION}`);
  console.log(`   Amount: ${WITHDRAWAL_AMOUNT} USDC`);
  console.log(`   Network: Arbitrum\n`);

  try {
    // Initialize SDK clients
    console.log('📡 Initializing HyperLiquid SDK...\n');
    const transport = new HttpTransport({ isTestnet: false });
    const infoClient = new InfoClient({ transport });
    const exchangeClient = new ExchangeClient({
      wallet: PRIVATE_KEY,
      transport,
    });

    console.log('✅ SDK initialized\n');

    // Check account state
    console.log('💰 Checking Account State...\n');
    const clearinghouseState = await infoClient.clearinghouseState({ user: walletAddress });
    const marginSummary = clearinghouseState.marginSummary;
    const accountValue = parseFloat(marginSummary.accountValue || '0');
    const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
    const perpAvailable = accountValue - totalMarginUsed;

    console.log(`   Account Value: $${accountValue.toFixed(2)}`);
    console.log(`   Total Margin Used: $${totalMarginUsed.toFixed(2)}`);
    console.log(`   Perp Available: $${perpAvailable.toFixed(2)}\n`);

    // Check if we have enough balance
    const WITHDRAWAL_FEE_USDC = 1.0;
    const totalRequired = WITHDRAWAL_AMOUNT + WITHDRAWAL_FEE_USDC;
    if (perpAvailable < totalRequired) {
      console.error(`❌ Insufficient balance. Required: $${totalRequired.toFixed(2)}, Available: $${perpAvailable.toFixed(2)}`);
      return;
    }

    // Check what methods are available on ExchangeClient
    console.log('🔍 Checking ExchangeClient methods...\n');
    const exchangeClientMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(exchangeClient));
    console.log(`   Available methods: ${exchangeClientMethods.filter(m => m !== 'constructor').join(', ')}\n`);

    // Check if initiateWithdrawal exists
    console.log(`   initiateWithdrawal exists: ${typeof (exchangeClient as any).initiateWithdrawal === 'function'}\n`);

    // Try to find withdrawal-related methods
    const withdrawalMethods = exchangeClientMethods.filter(m => 
      m.toLowerCase().includes('withdraw') || 
      m.toLowerCase().includes('withdrawal')
    );
    if (withdrawalMethods.length > 0) {
      console.log(`   Withdrawal-related methods: ${withdrawalMethods.join(', ')}\n`);
    }

    // Check wsPayloads (WebSocket payloads)
    if ((exchangeClient as any).wsPayloads) {
      console.log('🔍 Checking wsPayloads methods...\n');
      const wsPayloads = (exchangeClient as any).wsPayloads;
      const wsMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(wsPayloads));
      console.log(`   wsPayloads methods: ${wsMethods.filter(m => m !== 'constructor').join(', ')}\n`);
      
      if (typeof wsPayloads.initiateWithdrawal === 'function') {
        console.log('   ✅ initiateWithdrawal found in wsPayloads!\n');
      }
    }

    // Try calling withdraw3 via exchangeClient (this is the correct method)
    // withdraw3 expects an object with destination and amount properties
    console.log('🚀 Attempting withdrawal via exchangeClient.withdraw3...\n');
    if (typeof (exchangeClient as any).withdraw3 === 'function') {
      try {
        console.log(`   Calling withdraw3({ destination: ${DESTINATION}, amount: ${WITHDRAWAL_AMOUNT} })...\n`);
        const result = await (exchangeClient as any).withdraw3({
          destination: DESTINATION,
          amount: WITHDRAWAL_AMOUNT,
        });
        console.log('✅ Withdrawal successful!');
        console.log(`   Result: ${JSON.stringify(result, null, 2)}\n`);
        return;
      } catch (error: any) {
        console.error(`❌ Error calling withdraw3: ${error.message}\n`);
        if (error.stack) {
          console.error(`   Stack: ${error.stack}\n`);
        }
      }
    } else {
      console.error('❌ withdraw3 method not found on exchangeClient\n');
    }

    // Try calling via wsPayloads
    if ((exchangeClient as any).wsPayloads && typeof (exchangeClient as any).wsPayloads.initiateWithdrawal === 'function') {
      console.log('🚀 Attempting withdrawal via wsPayloads.initiateWithdrawal...\n');
      try {
        const result = await (exchangeClient as any).wsPayloads.initiateWithdrawal(
          DESTINATION,
          WITHDRAWAL_AMOUNT
        );
        console.log('✅ Withdrawal successful!');
        console.log(`   Result: ${JSON.stringify(result, null, 2)}\n`);
        return;
      } catch (error: any) {
        console.error(`❌ Error calling wsPayloads.initiateWithdrawal: ${error.message}\n`);
        if (error.stack) {
          console.error(`   Stack: ${error.stack}\n`);
        }
      }
    }

    // Try to find the method in the SDK
    console.log('🔍 Searching for withdrawal methods in SDK...\n');
    console.log('   ExchangeClient type:', typeof exchangeClient);
    console.log('   ExchangeClient keys:', Object.keys(exchangeClient).join(', '));
    
    // Check if there's a different method name
    const possibleMethods = [
      'withdraw',
      'withdrawExternal',
      'initiateWithdrawal',
      'withdrawToArbitrum',
      'bridgeToArbitrum',
    ];

    for (const methodName of possibleMethods) {
      if (typeof (exchangeClient as any)[methodName] === 'function') {
        console.log(`   ✅ Found method: ${methodName}\n`);
        try {
          const result = await (exchangeClient as any)[methodName](DESTINATION, WITHDRAWAL_AMOUNT);
          console.log(`✅ Withdrawal successful using ${methodName}!`);
          console.log(`   Result: ${JSON.stringify(result, null, 2)}\n`);
          return;
        } catch (error: any) {
          console.error(`   ❌ Error calling ${methodName}: ${error.message}\n`);
        }
      }
    }

    console.error('❌ No withdrawal method found in ExchangeClient\n');
    console.log('💡 Suggestions:');
    console.log('   1. Check @nktkas/hyperliquid SDK version');
    console.log('   2. Check SDK documentation for withdrawal methods');
    console.log('   3. Check if withdrawal requires a different approach (e.g., WebSocket)');

  } catch (error: any) {
    console.error('\n❌ Error occurred:');
    console.error(`   ${error.message}`);
    if (error.stack) {
      console.error(`\n   Stack: ${error.stack}`);
    }
  }
}

testHyperliquidWithdrawal().catch(console.error);

