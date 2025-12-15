import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { SignerClient, ApiClient } from '@reservoir0x/lighter-ts-sdk';
import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';

async function main() {
  console.log('='.repeat(70));
  console.log('FULL CAPACITY ANALYSIS: $500K Volume Target');
  console.log('='.repeat(70));

  const TARGET_VOLUME = 500000;
  const DAYS = 8;
  const DAILY_TARGET = TARGET_VOLUME / DAYS;

  console.log(`\n🎯 TARGET: $${TARGET_VOLUME.toLocaleString()} in ${DAYS} days = $${DAILY_TARGET.toLocaleString()}/day\n`);

  // ==================== GET ALL BALANCES ====================
  console.log('💰 CURRENT CAPITAL ACROSS EXCHANGES:');
  console.log('-'.repeat(50));
  
  let totalCapital = 0;

  // Lighter
  try {
    const LIGHTER_API_BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
    const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
    
    const response = await axios.get(`${LIGHTER_API_BASE_URL}/api/v1/account`, {
      params: { by: 'index', value: String(ACCOUNT_INDEX) },
      timeout: 10000,
    });
    const account = response.data.accounts?.[0];
    const balance = parseFloat(account?.available_balance || '0');
    const equity = parseFloat(account?.collateral || '0');
    totalCapital += equity;
    console.log(`   Lighter:     $${equity.toFixed(2)} (available: $${balance.toFixed(2)})`);
  } catch (e: any) {
    console.log(`   Lighter:     Error - ${e.message}`);
  }

  // Hyperliquid
  try {
    const transport = new HttpTransport({ isTestnet: false });
    const infoClient = new InfoClient({ transport });
    const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS || '0xa90714a15D6e5C0EB3096462De8dc4B22E01589A';
    
    const clearingHouse = await infoClient.clearinghouseState({ user: walletAddress });
    const equity = parseFloat(clearingHouse.marginSummary?.accountValue || '0');
    totalCapital += equity;
    console.log(`   Hyperliquid: $${equity.toFixed(2)}`);
  } catch (e: any) {
    console.log(`   Hyperliquid: Error - ${e.message}`);
  }

  // Aster (approximate based on earlier)
  const asterBalance = 1.10; // From earlier test
  totalCapital += asterBalance;
  console.log(`   Aster:       $${asterBalance.toFixed(2)}`);

  console.log('-'.repeat(50));
  console.log(`   TOTAL:       $${totalCapital.toFixed(2)}`);

  // ==================== VOLUME CALCULATION ====================
  console.log('\n📊 VOLUME GENERATION ANALYSIS:');
  console.log('-'.repeat(50));

  // Volume = (Capital × Leverage × 2) × Turnover × 2 exchanges
  // Each trade generates volume on BOTH sides of the arb
  
  const scenarios = [
    { leverage: 3, turnover: 2, name: 'Conservative (3x lev, 2 rotations/day)' },
    { leverage: 5, turnover: 3, name: 'Moderate (5x lev, 3 rotations/day)' },
    { leverage: 5, turnover: 6, name: 'Aggressive (5x lev, 6 rotations/day)' },
  ];

  for (const s of scenarios) {
    // Volume per exchange = capital × leverage × 2 (open + close) × turnover
    // Total = 2 exchanges
    const dailyVolume = totalCapital * s.leverage * 2 * s.turnover * 2;
    const eightDayVolume = dailyVolume * 8;
    const pctOfTarget = (eightDayVolume / TARGET_VOLUME) * 100;
    
    console.log(`\n   ${s.name}:`);
    console.log(`     Daily volume:  $${dailyVolume.toLocaleString()}`);
    console.log(`     8-day volume:  $${eightDayVolume.toLocaleString()}`);
    console.log(`     % of target:   ${pctOfTarget.toFixed(1)}%`);
  }

  // ==================== WHAT YOU NEED ====================
  console.log('\n\n🚀 WHAT YOU NEED TO HIT $500K:');
  console.log('-'.repeat(50));

  // With 5x leverage and 4 rotations/day (realistic aggressive)
  const targetLeverage = 5;
  const targetTurnover = 4;
  const volumePerDollar = targetLeverage * 2 * targetTurnover * 2 * 8; // per $1 capital over 8 days
  const capitalNeeded = TARGET_VOLUME / volumePerDollar;

  console.log(`   Assuming 5x leverage, 4 rotations/day:`);
  console.log(`   - Volume per $1 capital (8 days): $${volumePerDollar}`);
  console.log(`   - Capital needed for $500K: $${capitalNeeded.toFixed(0)}`);
  console.log(`   - Current capital: $${totalCapital.toFixed(0)}`);
  console.log(`   - Additional needed: $${Math.max(0, capitalNeeded - totalCapital).toFixed(0)}`);

  // Deposit recommendation
  const shortfall = capitalNeeded - totalCapital;
  if (shortfall > 0) {
    console.log(`\n   ⚠️  You need to deposit ~$${Math.ceil(shortfall / 100) * 100} more capital`);
    console.log(`       Split: ~$${Math.ceil(shortfall / 2)} to Lighter, ~$${Math.ceil(shortfall / 2)} to Hyperliquid`);
  }

  console.log('\n' + '='.repeat(70));
}

main().catch(console.error);
