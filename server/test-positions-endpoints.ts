import * as dotenv from 'dotenv';
import axios from 'axios';
import * as crypto from 'crypto';

dotenv.config();

/**
 * Test script to query positions from Lighter and Aster exchanges
 * This helps us understand the response format for implementing position fetching
 */

async function testLighterPositions() {
  console.log('\n' + '='.repeat(60));
  console.log('🔍 TESTING LIGHTER POSITIONS ENDPOINT');
  console.log('='.repeat(60));

  const accountIndex = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '1000');
  const explorerUrl = `https://explorer.elliot.ai/api/accounts/${accountIndex}/positions`;

  console.log(`\n📡 Endpoint: ${explorerUrl}`);
  console.log(`📊 Account Index: ${accountIndex}\n`);

  try {
    const response = await axios.get(explorerUrl, {
      timeout: 10000,
      headers: { accept: 'application/json' },
    });

    console.log('✅ Status Code:', response.status);
    console.log('\n📦 Response Structure:');
    console.log(JSON.stringify(response.data, null, 2));

    // Try to parse positions if they exist
    // Lighter returns positions as an object with market_index as keys
    let positionsData: any[] = [];
    if (response.data?.positions && typeof response.data.positions === 'object') {
      // Convert object to array
      positionsData = Object.values(response.data.positions);
    } else if (Array.isArray(response.data)) {
      positionsData = response.data;
    } else if (Array.isArray(response.data?.positions)) {
      positionsData = response.data.positions;
    }
    
    console.log(`\n📈 Found ${positionsData.length} position(s)`);

    if (positionsData.length > 0) {
      console.log('\n📋 Position Details:');
      positionsData.forEach((pos: any, index: number) => {
        console.log(`\n  Position ${index + 1}:`);
        console.log(`    Market Index: ${pos.market_index ?? pos.marketIndex ?? pos.index ?? 'N/A'}`);
        console.log(`    Size: ${pos.size ?? pos.positionSize ?? pos.amount ?? 'N/A'}`);
        console.log(`    Side: ${pos.side ?? 'N/A'}`);
        console.log(`    Entry Price: ${pos.entry_price ?? pos.entryPrice ?? pos.avgEntryPrice ?? 'N/A'}`);
        console.log(`    Mark Price: ${pos.mark_price ?? pos.markPrice ?? pos.currentPrice ?? 'N/A'}`);
        console.log(`    Unrealized PnL: ${pos.unrealized_pnl ?? pos.unrealizedPnl ?? pos.pnl ?? 'N/A'}`);
        console.log(`    Leverage: ${pos.leverage ?? 'N/A'}`);
        console.log(`    Full Data: ${JSON.stringify(pos, null, 4)}`);
      });
    } else {
      console.log('   (No open positions)');
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Response:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

async function testAsterAccount() {
  console.log('\n' + '='.repeat(60));
  console.log('🔍 TESTING ASTER ACCOUNT ENDPOINT');
  console.log('='.repeat(60));

  const baseUrl = (process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com').replace(/\/$/, '');
  const apiKey = process.env.ASTER_API_KEY;
  const apiSecret = process.env.ASTER_API_SECRET;
  // Try both v2 and v4 endpoints
  const endpoints = ['/fapi/v4/account', '/fapi/v2/account', '/fapi/v2/positionRisk'];

  console.log(`\n📡 Base URL: ${baseUrl}`);
  console.log(`🔑 API Key: ${apiKey ? '✅ Set' : '❌ Missing'}`);
  console.log(`🔐 API Secret: ${apiSecret ? '✅ Set' : '❌ Missing'}\n`);

  if (!apiKey || !apiSecret) {
    console.error('❌ ASTER_API_KEY and ASTER_API_SECRET are required');
    return;
  }

  // Try each endpoint
  for (const endpoint of endpoints) {
    console.log(`\n🔍 Trying endpoint: ${endpoint}`);
    
    try {
      // Create HMAC signature (same logic as AsterExchangeAdapter)
      const params: Record<string, any> = {
        timestamp: Date.now(), // Milliseconds
        recvWindow: 50000,
      };

      // Create query string for HMAC signing (sorted alphabetically, no URL encoding)
      const queryString = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join('&');

      // Create HMAC SHA256 signature
      const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');

      // Add signature to params (as last parameter)
      params.signature = signature;

      // Build query string with signature (sorted, signature last)
      const sortedKeys = Object.keys(params).sort();
      const finalQueryString = sortedKeys
        .map((key) => `${key}=${params[key]}`)
        .join('&');

      const url = `${baseUrl}${endpoint}?${finalQueryString}`;

      console.log('📤 Request URL (without signature):', `${baseUrl}${endpoint}?timestamp=${params.timestamp}&recvWindow=${params.recvWindow}&signature=***`);

      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/json',
        },
      });

      console.log('✅ Status Code:', response.status);
      console.log('\n📦 Full Response:');
      console.log(JSON.stringify(response.data, null, 2));

      // Parse positions if they exist (different endpoints return different structures)
      let positions: any[] = [];
      if (endpoint.includes('positionRisk')) {
        // /fapi/v2/positionRisk returns array directly
        positions = Array.isArray(response.data) ? response.data : [];
      } else {
        // /fapi/v2/account or /fapi/v4/account returns positions in data.positions
        positions = response.data?.positions || [];
      }
      
      console.log(`\n📈 Found ${positions.length} position(s) in response`);

      // Filter to only positions with non-zero size
      const openPositions = positions.filter((pos: any) => {
        const size = parseFloat(pos.positionAmt || '0');
        return size !== 0;
      });

      console.log(`📊 Open Positions (non-zero): ${openPositions.length}`);

      if (openPositions.length > 0) {
        console.log('\n📋 Position Details:');
        openPositions.forEach((pos: any, index: number) => {
          console.log(`\n  Position ${index + 1}:`);
          console.log(`    Symbol: ${pos.symbol ?? 'N/A'}`);
          console.log(`    Position Amount: ${pos.positionAmt ?? 'N/A'}`);
          console.log(`    Entry Price: ${pos.entryPrice ?? 'N/A'}`);
          console.log(`    Mark Price: ${pos.markPrice ?? 'N/A'}`);
          console.log(`    Leverage: ${pos.leverage ?? 'N/A'}`);
          console.log(`    Unrealized Profit: ${pos.unrealizedProfit ?? pos.unRealizedProfit ?? 'N/A'}`);
          console.log(`    Initial Margin: ${pos.initialMargin ?? 'N/A'}`);
          console.log(`    Maintenance Margin: ${pos.maintMargin ?? 'N/A'}`);
          console.log(`    Isolated: ${pos.isolated ?? 'N/A'}`);
          console.log(`    Position Side: ${pos.positionSide ?? 'N/A'}`);
          console.log(`    Max Notional: ${pos.maxNotional ?? 'N/A'}`);
          console.log(`    Liquidation Price: ${pos.liquidationPrice ?? 'N/A'}`);
          console.log(`    Full Data: ${JSON.stringify(pos, null, 4)}`);
        });
      } else {
        console.log('   (No open positions)');
      }

      // Also show account summary (for account endpoints)
      if (response.data && !endpoint.includes('positionRisk')) {
        console.log('\n💰 Account Summary:');
        console.log(`    Total Wallet Balance: ${response.data.totalWalletBalance ?? 'N/A'}`);
        console.log(`    Total Margin Balance: ${response.data.totalMarginBalance ?? 'N/A'}`);
        console.log(`    Total Unrealized Profit: ${response.data.totalUnrealizedProfit ?? 'N/A'}`);
        console.log(`    Available Balance: ${response.data.availableBalance ?? 'N/A'}`);
        console.log(`    Max Withdraw Amount: ${response.data.maxWithdrawAmount ?? 'N/A'}`);
      }
      
      // Success - exit after first successful endpoint
      console.log(`\n✅ Successfully queried ${endpoint}`);
      return;
    } catch (error: any) {
      console.error(`❌ Error with ${endpoint}:`, error.message);
      if (error.response) {
        console.error('   Status:', error.response.status);
        console.error('   Response:', JSON.stringify(error.response.data, null, 2));
      } else if (error.request) {
        console.error('   Request made but no response received');
      }
      // Continue to next endpoint
      if (endpoint !== endpoints[endpoints.length - 1]) {
        console.log('\n   Trying next endpoint...\n');
      }
    }
  }
}

async function main() {
  console.log('🚀 Testing Positions Endpoints\n');
  console.log('This script will query:');
  console.log('  1. Lighter: https://explorer.elliot.ai/api/accounts/{accountIndex}/positions');
  console.log('  2. Aster: GET /fapi/v4/account\n');

  await testLighterPositions();
  await testAsterAccount();

  console.log('\n' + '='.repeat(60));
  console.log('✅ Testing Complete');
  console.log('='.repeat(60) + '\n');
}

main().catch(console.error);

