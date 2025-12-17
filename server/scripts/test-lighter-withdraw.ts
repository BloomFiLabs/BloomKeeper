/**
 * Diagnostic script to test Lighter fast withdrawal
 * Compares our implementation with the frontend's approach
 */

import { SignerClient, ApiClient } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const API_PRIVATE_KEY = process.env.LIGHTER_API_KEY || process.env.LIGHTER_API_PRIVATE_KEY || process.env.API_PRIVATE_KEY || '';
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || process.env.ACCOUNT_INDEX || '623336');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || process.env.API_KEY_INDEX || '1');
const BASE_URL = process.env.LIGHTER_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
const DESTINATION_ADDRESS = process.env.CENTRAL_WALLET_ADDRESS || '0xa90714a15D6e5C0EB3096462De8dc4B22E01589A';

async function main() {
  console.log('🔍 Lighter Fast Withdrawal Diagnostic\n');
  console.log('Configuration:');
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  Account Index: ${ACCOUNT_INDEX}`);
  console.log(`  API Key Index: ${API_KEY_INDEX}`);
  console.log(`  Destination: ${DESTINATION_ADDRESS}`);
  console.log(`  Has API Private Key: ${API_PRIVATE_KEY ? 'Yes' : 'No'}`);
  console.log(`  Has ETH Private Key: ${ETH_PRIVATE_KEY ? 'Yes' : 'No'}\n`);

  if (!API_PRIVATE_KEY || !ETH_PRIVATE_KEY) {
    console.error('❌ Missing required keys. Please set LIGHTER_API_PRIVATE_KEY and ETH_PRIVATE_KEY');
    process.exit(1);
  }

  // Initialize signer client
  const signerClient = new SignerClient({
    url: BASE_URL,
    privateKey: API_PRIVATE_KEY,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX
  });

  await signerClient.initialize();
  await signerClient.ensureWasmClient();
  console.log('✅ Signer client initialized\n');

  // Create auth token
  const authToken = await signerClient.createAuthTokenWithExpiry(600);
  console.log(`✅ Auth token created (expires in 10 min)\n`);

  // ============ Step 1: Check Pool Info ============
  console.log('📊 Step 1: Checking fast withdraw pool info...');
  try {
    const poolInfoResponse = await axios.get(`${BASE_URL}/api/v1/fastwithdraw/info`, {
      params: {
        account_index: ACCOUNT_INDEX,
        auth: authToken,
      },
      timeout: 30000,
    });

    console.log('Pool Info Response:');
    console.log(JSON.stringify(poolInfoResponse.data, null, 2));

    if (poolInfoResponse.data.code === 200) {
      const toAccountIndex = poolInfoResponse.data.to_account_index;
      const withdrawLimit = poolInfoResponse.data.withdraw_limit;
      console.log(`\n  To Account Index: ${toAccountIndex}`);
      console.log(`  Withdraw Limit: ${withdrawLimit ? (withdrawLimit / 1e6).toFixed(2) : 'N/A'} USDC`);
      console.log(`  This is the fast withdraw pool limit\n`);

      // Compare with frontend ToAccountIndex (675395)
      if (toAccountIndex !== 675395) {
        console.log(`⚠️ Note: Our pool index (${toAccountIndex}) differs from frontend's (675395)`);
      }
    }
  } catch (error: any) {
    console.error('❌ Failed to get pool info:', error.response?.data || error.message);
  }

  // ============ Step 2: Check transfer routes ============
  console.log('\n📊 Step 2: Checking available transfer routes...');
  try {
    // Try the info endpoint without fastwithdraw prefix
    const infoResponse = await axios.get(`${BASE_URL}/api/v1/transferInfo`, {
      params: {
        account_index: ACCOUNT_INDEX,
        auth: authToken,
      },
      timeout: 30000,
    });
    console.log('Transfer Info Response:');
    console.log(JSON.stringify(infoResponse.data, null, 2));
  } catch (error: any) {
    console.log('Transfer info endpoint not available or returned error:', error.response?.status || error.message);
  }

  // ============ Step 3: Get account balance ============
  console.log('\n📊 Step 3: Getting account balance...');
  try {
    const balanceResponse = await axios.get(`${BASE_URL}/api/v1/accountInfo`, {
      params: {
        account_index: ACCOUNT_INDEX,
        auth: authToken,
      },
      timeout: 30000,
    });

    console.log('Account Info Response:');
    console.log(JSON.stringify(balanceResponse.data, null, 2));
  } catch (error: any) {
    console.error('❌ Failed to get account info:', error.response?.data || error.message);
  }

  // ============ Step 4: Get transfer fee info ============
  console.log('\n📊 Step 4: Getting transfer fee info...');
  const TO_ACCOUNT_INDICES = [675395, 0]; // Try both frontend's pool and account 0
  
  for (const toAccIndex of TO_ACCOUNT_INDICES) {
    try {
      const feeResponse = await axios.get(`${BASE_URL}/api/v1/transferFeeInfo`, {
        params: {
          account_index: ACCOUNT_INDEX,
          to_account_index: toAccIndex,
          auth: authToken,
        },
        timeout: 10000,
      });

      console.log(`Fee Info for to_account_index=${toAccIndex}:`);
      console.log(JSON.stringify(feeResponse.data, null, 2));
      
      if (feeResponse.data.code === 200) {
        const fee = feeResponse.data.transfer_fee_usdc;
        console.log(`  Fee: ${fee ? (fee / 1e6).toFixed(2) : 'N/A'} USDC`);
      }
    } catch (error: any) {
      console.log(`  Error for to_account_index=${toAccIndex}:`, error.response?.data || error.message);
    }
  }

  // ============ Step 5: Get next nonce ============
  console.log('\n📊 Step 5: Getting next nonce...');
  try {
    const nonceResponse = await axios.get(`${BASE_URL}/api/v1/nextNonce`, {
      params: {
        account_index: ACCOUNT_INDEX,
        api_key_index: API_KEY_INDEX,
      },
      timeout: 10000,
    });

    console.log('Nonce Response:');
    console.log(JSON.stringify(nonceResponse.data, null, 2));
  } catch (error: any) {
    console.error('❌ Failed to get nonce:', error.response?.data || error.message);
  }

  // ============ Step 6: Try SDK transfer method (dry run) ============
  console.log('\n📊 Step 6: Testing SDK transfer method (1 USDC dry run)...');
  console.log('This will attempt a small transfer to validate our setup\n');
  
  // Build memo from destination address (20 bytes + 12 zeros)
  const cleanAddress = DESTINATION_ADDRESS.toLowerCase().replace(/^0x/, '');
  const addrBytes = Buffer.from(cleanAddress, 'hex');
  const memoBuffer = Buffer.alloc(32, 0);
  addrBytes.copy(memoBuffer, 0);
  const memoHex = memoBuffer.toString('hex');
  
  console.log(`  Memo (hex): ${memoHex}`);
  console.log(`  Memo (bytes): [${Array.from(memoBuffer).join(', ')}]`);
  
  // Frontend memo for comparison
  const frontendMemo = [169,7,20,161,93,110,92,14,179,9,100,98,222,141,196,178,46,1,88,154,0,0,0,0,0,0,0,0,0,0,0,0];
  console.log(`  Frontend memo: [${frontendMemo.join(', ')}]`);
  
  // Decode frontend memo to address
  const frontendAddrHex = Buffer.from(frontendMemo.slice(0, 20)).toString('hex');
  console.log(`  Frontend memo decoded address: 0x${frontendAddrHex}`);

  // ============ Step 7: Compare our tx_info format with frontend ============
  console.log('\n📊 Step 7: Comparing transaction formats...');
  
  const frontendFormat = {
    "FromAccountIndex": 623336,
    "ApiKeyIndex": 1,
    "ToAccountIndex": 675395,
    "AssetIndex": 3,
    "FromRouteType": 0,
    "ToRouteType": 0,
    "Amount": 67000000,
    "USDCFee": 3000000,
    "Memo": frontendMemo,
    "ExpiredAt": 1765973906158,
    "Nonce": 12,
    "Sig": "...",
    "L1Sig": "..."
  };

  console.log('Frontend transaction format:');
  console.log(JSON.stringify({ ...frontendFormat, Sig: '[REDACTED]', L1Sig: '[REDACTED]' }, null, 2));

  // Our format (what signTransfer produces)
  console.log('\nOur signTransfer params:');
  console.log(JSON.stringify({
    toAccountIndex: 675395,
    assetIndex: 3,
    fromRouteType: 0,
    toRouteType: 0,
    amount: 67000000,
    usdcFee: 3000000,
    memo: memoHex,
    nonce: 12,
    // Note: NO expiredAt!
  }, null, 2));

  console.log('\n⚠️ KEY DIFFERENCE: Frontend includes "ExpiredAt" field, our signTransfer does NOT!');
  console.log('   The ExpiredAt timestamp: 1765973906158');
  console.log(`   Current time: ${Date.now()}`);
  console.log(`   ExpiredAt is ${Math.round((1765973906158 - Date.now()) / 1000 / 60 / 60 / 24)} days in the future`);

  // ============ Step 8: Try using /api/v1/transfer endpoint directly ============
  console.log('\n📊 Step 8: Testing /api/v1/transfer endpoint (like frontend)...');
  
  // Build transaction body exactly like the frontend
  const testAmount = 1000000; // 1 USDC in micro-USDC
  const testFee = 3000000; // 3 USDC fee
  const expiredAt = Date.now() + 600000; // 10 minutes from now
  
  // Get fresh nonce
  let currentNonce = 3090; // fallback
  try {
    const nonceResp = await axios.get(`${BASE_URL}/api/v1/nextNonce`, {
      params: { account_index: ACCOUNT_INDEX, api_key_index: API_KEY_INDEX },
      timeout: 10000,
    });
    if (nonceResp.data.nonce !== undefined) {
      currentNonce = nonceResp.data.nonce;
    }
  } catch (e) {
    console.log('Using fallback nonce');
  }
  
  console.log(`  Building transfer with nonce: ${currentNonce}`);
  console.log(`  Amount: 1 USDC, Fee: 3 USDC, ExpiredAt: ${expiredAt}`);
  
  // The frontend format uses PascalCase JSON keys
  const transferBody = {
    FromAccountIndex: ACCOUNT_INDEX,
    ApiKeyIndex: API_KEY_INDEX,
    ToAccountIndex: 675395, // Fast withdraw pool
    AssetIndex: 3, // USDC
    FromRouteType: 0, // PERP
    ToRouteType: 0, // PERP
    Amount: testAmount,
    USDCFee: testFee,
    Memo: Array.from(memoBuffer), // Send as byte array like frontend
    ExpiredAt: expiredAt,
    Nonce: currentNonce,
    // Sig and L1Sig need to be generated...
  };
  
  console.log('\n  Transfer body structure (without signatures):');
  console.log(JSON.stringify(transferBody, null, 2));
  
  console.log('\n  Note: To fully test, we need to sign this with both L2 and L1 signatures.');
  console.log('  The SDK signTransfer may not include ExpiredAt which could be the issue.');
  
  // Try the SDK's withdraw method for L1 withdrawal (slower but no pool limit)
  console.log('\n📊 Step 8b: Testing SDK standard L1 withdraw...');
  try {
    // Standard L1 withdrawal doesn't use the fast pool
    const [tx, txHash, error] = await (signerClient as any).withdraw({
      usdcAmount: 1, // 1 USDC test
      nonce: -1
    });
    
    if (error) {
      console.log(`❌ L1 withdraw error: ${error}`);
    } else {
      console.log(`✅ L1 withdraw submitted!`);
      console.log(`   TX Hash: ${txHash}`);
      console.log('   Note: L1 withdrawals take longer but dont use fast pool');
    }
  } catch (error: any) {
    console.error('❌ L1 withdraw exception:', error.message);
  }

  // ============ Step 9: Check if there's a different endpoint ============
  console.log('\n📊 Step 9: Checking API endpoints...');
  
  const endpoints = [
    '/api/v1/transfer',
    '/api/v1/fastwithdraw',
    '/api/v1/withdrawFast',
    '/api/v1/withdraw/fast',
  ];
  
  for (const endpoint of endpoints) {
    try {
      // Just check if endpoint exists (OPTIONS or GET)
      const response = await axios.options(`${BASE_URL}${endpoint}`, { timeout: 5000 });
      console.log(`  ${endpoint}: Available (${response.status})`);
    } catch (error: any) {
      const status = error.response?.status || 'N/A';
      console.log(`  ${endpoint}: ${status === 404 ? 'Not found' : status === 405 ? 'Method not allowed (endpoint exists)' : status}`);
    }
  }

  console.log('\n✅ Diagnostic complete!');
  console.log('\nRecommendations:');
  console.log('1. Check if ExpiredAt is required for the transfer');
  console.log('2. Verify we are using the correct ToAccountIndex (675395 matches frontend)');
  console.log('3. Consider using SDK transfer method instead of low-level signTransfer');
  console.log('4. The pool availability check might be checking the wrong thing');
}

main().catch(console.error);

