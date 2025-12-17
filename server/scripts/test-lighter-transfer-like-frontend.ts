/**
 * Test Lighter transfer using the EXACT same format as the frontend
 * 
 * Key differences we're testing:
 * 1. Using /api/v1/transfer endpoint instead of /api/v1/fastwithdraw
 * 2. Using ApiKeyIndex 1 (frontend) vs our config's 2
 * 3. Sending JSON body directly instead of form-urlencoded tx_info
 */

import { SignerClient } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const API_PRIVATE_KEY = process.env.LIGHTER_API_KEY || '';
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const BASE_URL = process.env.LIGHTER_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
const DESTINATION_ADDRESS = process.env.CENTRAL_WALLET_ADDRESS || '0xa90714a15D6e5C0EB3096462De8dc4B22E01589A';

// Try BOTH API key indices
const API_KEY_INDEX_OURS = parseInt(process.env.LIGHTER_API_KEY_INDEX || '2');
const API_KEY_INDEX_FRONTEND = 1; // Frontend uses 1

async function checkPoolForApiKey(signerClient: SignerClient, apiKeyIndex: number, authToken: string): Promise<number | null> {
  try {
    const poolResponse = await axios.get(`${BASE_URL}/api/v1/fastwithdraw/info`, {
      params: {
        account_index: ACCOUNT_INDEX,
        auth: authToken,
      },
      timeout: 30000,
    });

    if (poolResponse.data.code === 200) {
      const limit = parseInt(poolResponse.data.withdraw_limit || '0');
      console.log(`  Pool for API key ${apiKeyIndex}: $${(limit / 1e6).toFixed(2)} USDC (to_account: ${poolResponse.data.to_account_index})`);
      return limit / 1e6;
    }
    return null;
  } catch (error: any) {
    console.log(`  Pool check failed for API key ${apiKeyIndex}: ${error.message}`);
    return null;
  }
}

async function tryTransferEndpoint(apiKeyIndex: number) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing with API Key Index: ${apiKeyIndex}`);
  console.log(`${'='.repeat(60)}\n`);

  // Initialize signer with this API key index
  const signerClient = new SignerClient({
    url: BASE_URL,
    privateKey: API_PRIVATE_KEY,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: apiKeyIndex
  });

  await signerClient.initialize();
  await signerClient.ensureWasmClient();
  console.log(`✅ Signer initialized with apiKeyIndex=${apiKeyIndex}\n`);

  const authToken = await signerClient.createAuthTokenWithExpiry(600);

  // Check pool availability
  console.log('📊 Checking fast withdraw pool...');
  const poolLimit = await checkPoolForApiKey(signerClient, apiKeyIndex, authToken);

  // Get nonce for this API key
  console.log('\n📊 Getting nonce...');
  const nonceResponse = await axios.get(`${BASE_URL}/api/v1/nextNonce`, {
    params: {
      account_index: ACCOUNT_INDEX,
      api_key_index: apiKeyIndex,
    },
    timeout: 10000,
  });
  const nonce = nonceResponse.data.nonce;
  console.log(`  Nonce for API key ${apiKeyIndex}: ${nonce}`);

  // Build memo (destination address as bytes)
  const cleanAddress = DESTINATION_ADDRESS.toLowerCase().replace(/^0x/, '');
  const addrBytes = Buffer.from(cleanAddress, 'hex');
  const memoBuffer = Buffer.alloc(32, 0);
  addrBytes.copy(memoBuffer, 0);
  const memoArray = Array.from(memoBuffer);
  const memoHex = memoBuffer.toString('hex');

  // Build transfer body exactly like frontend
  const ASSET_ID_USDC = 3;
  const ROUTE_PERP = 0;
  const CHAIN_ID = 304;
  const TO_ACCOUNT_INDEX = 675395; // Fast withdraw pool (from frontend)
  
  const testAmount = 1000000; // 1 USDC (in micro)
  const testFee = 3000000; // 3 USDC fee (in micro)
  const expiredAt = Date.now() + 600000; // 10 minutes from now

  console.log(`\n📊 Building transfer request like frontend...`);
  console.log(`  Amount: $1 USDC (${testAmount} micro)`);
  console.log(`  Fee: $3 USDC (${testFee} micro)`);
  console.log(`  To Account: ${TO_ACCOUNT_INDEX}`);
  console.log(`  ExpiredAt: ${expiredAt}`);

  // Sign the L1 message
  const toHex = (value: number): string =>
    '0x' + value.toString(16).padStart(16, '0');

  const l1Message = `Transfer\n\nnonce: ${toHex(nonce)}\nfrom: ${toHex(ACCOUNT_INDEX)} (route ${toHex(ROUTE_PERP)})\napi key: ${toHex(apiKeyIndex)}\nto: ${toHex(TO_ACCOUNT_INDEX)} (route ${toHex(ROUTE_PERP)})\nasset: ${toHex(ASSET_ID_USDC)}\namount: ${toHex(testAmount)}\nfee: ${toHex(testFee)}\nchainId: ${toHex(CHAIN_ID)}\nmemo: ${memoHex}\nOnly sign this message for a trusted client!`;

  const wallet = new ethers.Wallet(ETH_PRIVATE_KEY.startsWith('0x') ? ETH_PRIVATE_KEY : `0x${ETH_PRIVATE_KEY}`);
  const l1Sig = await wallet.signMessage(l1Message);
  console.log(`  L1 signature generated`);

  // Sign with WASM signer
  const wasmSigner = (signerClient as any).wallet;
  const transferResult = await wasmSigner.signTransfer({
    toAccountIndex: TO_ACCOUNT_INDEX,
    assetIndex: ASSET_ID_USDC,
    fromRouteType: ROUTE_PERP,
    toRouteType: ROUTE_PERP,
    amount: testAmount,
    usdcFee: testFee,
    memo: memoHex,
    nonce: nonce,
  });

  if (transferResult.error) {
    console.log(`❌ WASM sign error: ${transferResult.error}`);
    return;
  }

  const txInfo = JSON.parse(transferResult.txInfo);
  console.log(`  L2 signature generated`);
  console.log(`\n  Signed tx_info structure:`);
  console.log(JSON.stringify(txInfo, null, 2));

  // Add L1Sig and ExpiredAt
  txInfo.L1Sig = l1Sig;
  // Note: ExpiredAt might need to be added - check if it's already there
  if (!txInfo.ExpiredAt) {
    console.log(`  ⚠️ txInfo does NOT have ExpiredAt - this might be the issue!`);
    // Try adding it
    txInfo.ExpiredAt = expiredAt;
  }

  // Now try BOTH endpoints
  console.log(`\n${'─'.repeat(40)}`);
  console.log('Testing /api/v1/transfer endpoint (like frontend)...');
  console.log(`${'─'.repeat(40)}`);

  // Method 1: POST JSON directly to /api/v1/transfer
  try {
    const transferBody = {
      FromAccountIndex: ACCOUNT_INDEX,
      ApiKeyIndex: apiKeyIndex,
      ToAccountIndex: TO_ACCOUNT_INDEX,
      AssetIndex: ASSET_ID_USDC,
      FromRouteType: ROUTE_PERP,
      ToRouteType: ROUTE_PERP,
      Amount: testAmount,
      USDCFee: testFee,
      Memo: memoArray, // Array of bytes like frontend
      ExpiredAt: expiredAt,
      Nonce: nonce,
      Sig: txInfo.Sig,
      L1Sig: l1Sig,
    };

    console.log(`\n  Request body (frontend format):`);
    console.log(JSON.stringify({ ...transferBody, Sig: '[REDACTED]', L1Sig: '[REDACTED]' }, null, 2));

    const response = await axios.post(
      `${BASE_URL}/api/v1/transfer?auth=${encodeURIComponent(authToken)}`,
      transferBody,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log(`\n  Response from /api/v1/transfer:`);
    console.log(JSON.stringify(response.data, null, 2));

    if (response.data.code === 200) {
      console.log(`\n✅ SUCCESS with /api/v1/transfer endpoint!`);
      console.log(`   TX Hash: ${response.data.tx_hash || response.data.hash}`);
      return true;
    }
  } catch (error: any) {
    console.log(`\n  /api/v1/transfer error: ${error.response?.data?.message || error.message}`);
    if (error.response?.data) {
      console.log(`  Response data:`, JSON.stringify(error.response.data, null, 2));
    }
  }

  // Method 2: Try fastwithdraw with our current approach
  console.log(`\n${'─'.repeat(40)}`);
  console.log('Testing /api/v1/fastwithdraw endpoint (our current approach)...');
  console.log(`${'─'.repeat(40)}`);

  try {
    const txInfoWithL1 = { ...txInfo, L1Sig: l1Sig };
    const formData = new URLSearchParams();
    formData.append('tx_info', JSON.stringify(txInfoWithL1));
    formData.append('to_address', DESTINATION_ADDRESS);

    const response = await axios.post(
      `${BASE_URL}/api/v1/fastwithdraw?auth=${encodeURIComponent(authToken)}`,
      formData.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }
    );

    console.log(`\n  Response from /api/v1/fastwithdraw:`);
    console.log(JSON.stringify(response.data, null, 2));

    if (response.data.code === 200) {
      console.log(`\n✅ SUCCESS with /api/v1/fastwithdraw endpoint!`);
      return true;
    }
  } catch (error: any) {
    console.log(`\n  /api/v1/fastwithdraw error: ${error.response?.data?.message || error.message}`);
    if (error.response?.data) {
      console.log(`  Response data:`, JSON.stringify(error.response.data, null, 2));
    }
  }

  return false;
}

async function main() {
  console.log('🔍 Testing Lighter Transfer - Frontend vs Our Approach\n');
  console.log('Configuration:');
  console.log(`  Account Index: ${ACCOUNT_INDEX}`);
  console.log(`  Our API Key Index: ${API_KEY_INDEX_OURS}`);
  console.log(`  Frontend API Key Index: ${API_KEY_INDEX_FRONTEND}`);
  console.log(`  Destination: ${DESTINATION_ADDRESS}`);

  if (!API_PRIVATE_KEY || !ETH_PRIVATE_KEY) {
    console.error('❌ Missing required keys');
    process.exit(1);
  }

  // Test with frontend's API key index first
  const frontendSuccess = await tryTransferEndpoint(API_KEY_INDEX_FRONTEND);
  
  // Then test with our API key index
  const ourSuccess = await tryTransferEndpoint(API_KEY_INDEX_OURS);

  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Frontend API key (${API_KEY_INDEX_FRONTEND}): ${frontendSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`  Our API key (${API_KEY_INDEX_OURS}): ${ourSuccess ? '✅ SUCCESS' : '❌ FAILED'}`);
  
  if (!frontendSuccess && !ourSuccess) {
    console.log(`\n⚠️ Both failed - the issue is likely:`);
    console.log(`   1. Pool is genuinely depleted for BOTH API keys`);
    console.log(`   2. Or we need to use different endpoints/formats`);
  } else if (frontendSuccess && !ourSuccess) {
    console.log(`\n✅ FOUND THE ISSUE: We should use API key index ${API_KEY_INDEX_FRONTEND}!`);
    console.log(`   Update LIGHTER_API_KEY_INDEX=1 in your .env file`);
  }
}

main().catch(console.error);

