import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { SignerClient, ApiClient } from '@reservoir0x/lighter-ts-sdk';

const LIGHTER_API_BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_API_KEY = process.env.LIGHTER_API_KEY || '';
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '1');

async function main() {
  console.log('='.repeat(60));
  console.log('CAPACITY ANALYSIS: $500K Volume in 8 Days');
  console.log('='.repeat(60));
  
  // Target metrics
  const TARGET_VOLUME = 500000;
  const DAYS = 8;
  const DAILY_VOLUME = TARGET_VOLUME / DAYS;
  const HOURLY_VOLUME = DAILY_VOLUME / 24;
  
  console.log('\n📊 TARGET METRICS:');
  console.log(`   Total Volume Target: $${TARGET_VOLUME.toLocaleString()}`);
  console.log(`   Days: ${DAYS}`);
  console.log(`   Required Daily Volume: $${DAILY_VOLUME.toLocaleString()}/day`);
  console.log(`   Required Hourly Volume: $${HOURLY_VOLUME.toFixed(2)}/hour`);
  
  // Get current balances
  console.log('\n💰 CURRENT CAPITAL:');
  
  // Lighter balance
  try {
    const accountResponse = await axios.get(`${LIGHTER_API_BASE_URL}/api/v1/account`, {
      params: { by: 'index', value: String(ACCOUNT_INDEX) },
      timeout: 10000,
    });
    const account = accountResponse.data.accounts?.[0];
    const lighterBalance = parseFloat(account?.available_balance || '0');
    console.log(`   Lighter: $${lighterBalance.toFixed(2)}`);
    
    // Get positions
    const positions = account?.positions?.filter((p: any) => 
      (p.open_order_count > 0 || parseFloat(p.position || '0') !== 0)
    ) || [];
    
    if (positions.length > 0) {
      console.log('   Lighter Positions:');
      for (const p of positions) {
        if (parseFloat(p.position || '0') !== 0) {
          console.log(`     - ${p.symbol}: ${p.position} (value: $${parseFloat(p.position_value || '0').toFixed(2)})`);
        }
      }
    }
  } catch (e: any) {
    console.log(`   Lighter: Error - ${e.message}`);
  }

  // Estimate capacity
  console.log('\n📈 VOLUME GENERATION CAPACITY:');
  
  // Assumptions for funding arbitrage:
  // - Each position open/close cycle = 2x notional in volume
  // - Position sizes typically 1-5x leverage
  // - Turnover rate depends on funding payment frequency
  
  const LEVERAGE = 3; // Average leverage
  const TURNOVER_PER_DAY = 2; // How many times we fully rotate positions
  
  console.log(`   Assumptions:`);
  console.log(`     - Average Leverage: ${LEVERAGE}x`);
  console.log(`     - Position Turnover: ${TURNOVER_PER_DAY}x/day`);
  
  // If you have $300 capital at 3x leverage = $900 notional
  // Opening + closing = $1800 volume per full rotation
  // 2 rotations/day = $3600/day volume per exchange
  // 2 exchanges (Lighter + Hyperliquid) = $7200/day
  
  const estimatedCapital = 300; // Based on what I saw earlier
  const dailyVolumeCapacity = estimatedCapital * LEVERAGE * 2 * TURNOVER_PER_DAY * 2;
  
  console.log(`\n   With ~$${estimatedCapital} capital:`);
  console.log(`     - Notional per side: $${(estimatedCapital * LEVERAGE).toFixed(0)}`);
  console.log(`     - Volume per rotation: $${(estimatedCapital * LEVERAGE * 2 * 2).toFixed(0)}`);
  console.log(`     - Daily volume capacity: $${dailyVolumeCapacity.toFixed(0)}/day`);
  console.log(`     - 8-day volume capacity: $${(dailyVolumeCapacity * 8).toFixed(0)}`);
  
  // Gap analysis
  const gap = DAILY_VOLUME - dailyVolumeCapacity;
  const capitalNeeded = gap > 0 ? (gap / (LEVERAGE * 2 * TURNOVER_PER_DAY * 2)) : 0;
  
  console.log('\n🎯 GAP ANALYSIS:');
  if (gap > 0) {
    console.log(`   ❌ Current capacity: $${dailyVolumeCapacity.toFixed(0)}/day`);
    console.log(`   ❌ Target: $${DAILY_VOLUME.toFixed(0)}/day`);
    console.log(`   ❌ Shortfall: $${gap.toFixed(0)}/day`);
    console.log(`\n   💡 TO REACH TARGET:`);
    console.log(`      Additional capital needed: $${capitalNeeded.toFixed(0)}`);
    console.log(`      OR increase turnover to: ${(DAILY_VOLUME / (estimatedCapital * LEVERAGE * 2 * 2)).toFixed(1)}x/day`);
    console.log(`      OR increase leverage to: ${(DAILY_VOLUME / (estimatedCapital * 2 * TURNOVER_PER_DAY * 2)).toFixed(1)}x`);
  } else {
    console.log(`   ✅ Current daily capacity: $${dailyVolumeCapacity.toFixed(0)}`);
    console.log(`   ✅ Target daily volume: $${DAILY_VOLUME.toFixed(0)}`);
    console.log(`   ✅ You have excess capacity!`);
  }
  
  console.log('\n' + '='.repeat(60));
}

main().catch(console.error);
