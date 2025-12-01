import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { Hyperliquid, HttpTransport, InfoClient } from '@nktkas/hyperliquid';

dotenv.config();

async function testHyperliquidBalance() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       TEST HYPERLIQUID BALANCE QUERY                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const privateKey = process.env.PRIVATE_KEY || process.env.HYPERLIQUID_PRIVATE_KEY;
  const isTestnet = process.env.HYPERLIQUID_TESTNET === 'true';

  if (!privateKey) {
    console.error('❌ ERROR: PRIVATE_KEY or HYPERLIQUID_PRIVATE_KEY not found in .env file');
    process.exit(1);
  }

  const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(normalizedPrivateKey);
  const walletAddress = wallet.address;

  console.log(`📡 Configuration:`);
  console.log(`   Wallet Address: ${walletAddress}`);
  console.log(`   Testnet: ${isTestnet}\n`);

  try {
    // Initialize SDK
    console.log('🔐 Initializing HyperLiquid SDK...');
    const transport = new HttpTransport({ isTestnet });
    const infoClient = new InfoClient({ transport });
    console.log('✅ SDK initialized\n');

    // Get account state
    console.log('💰 Getting account balance...');
    const clearinghouseState = await infoClient.clearinghouseState({ user: walletAddress });
    const marginSummary = clearinghouseState.marginSummary;

    const accountValue = parseFloat(marginSummary.accountValue || '0');
    const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
    const freeCollateral = accountValue - totalMarginUsed;

    console.log('\n📊 Account Summary:');
    console.log(`   Account Value: $${accountValue.toFixed(2)}`);
    console.log(`   Margin Used: $${totalMarginUsed.toFixed(2)}`);
    console.log(`   Free Collateral: $${freeCollateral.toFixed(2)}\n`);

    // Check positions
    if (clearinghouseState.assetPositions && clearinghouseState.assetPositions.length > 0) {
      console.log('📈 Open Positions:');
      clearinghouseState.assetPositions.forEach((pos: any) => {
        const size = parseFloat(pos.position.szi || '0');
        if (size !== 0) {
          const coin = pos.position.coin;
          const marginUsed = parseFloat(pos.position.marginUsed || '0');
          const unrealizedPnl = parseFloat(pos.position.unrealizedPnl || '0');
          console.log(`   ${coin}: ${size > 0 ? 'LONG' : 'SHORT'} ${Math.abs(size)}`);
          console.log(`     Margin Used: $${marginUsed.toFixed(2)}`);
          console.log(`     Unrealized PnL: $${unrealizedPnl.toFixed(2)}`);
        }
      });
      console.log('');
    } else {
      console.log('📈 No open positions\n');
    }

    console.log('✅ Balance query successful!');
    console.log(`   Available for trading: $${freeCollateral.toFixed(2)}`);

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Response: ${JSON.stringify(error.response.data)}`);
    }
    console.error(error.stack);
    process.exit(1);
  }
}

testHyperliquidBalance().catch(console.error);

