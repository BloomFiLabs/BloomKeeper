/**
 * Test Aster withdrawal using EIP712 signature (matches web interface)
 * This script tests the /fapi/aster/user-withdraw endpoint that the web interface uses
 */

import * as dotenv from 'dotenv';
import axios from 'axios';
import { ethers } from 'ethers';
import * as crypto from 'crypto';

dotenv.config();

const FAPI_BASE_URL = 'https://fapi.asterdex.com';
const API_KEY = process.env.ASTER_API_KEY;
const API_SECRET = process.env.ASTER_API_SECRET || process.env.ASTER_API_SECRET_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.ASTER_PRIVATE_KEY;

if (!API_KEY || !API_SECRET) {
  console.error('❌ ERROR: ASTER_API_KEY and ASTER_API_SECRET must be set in .env');
  process.exit(1);
}

if (!PRIVATE_KEY) {
  console.error('❌ ERROR: PRIVATE_KEY or ASTER_PRIVATE_KEY must be set in .env');
  process.exit(1);
}

async function checkBalance() {
  console.log('💰 Checking account balance...\n');
  
  try {
    const timestamp = Date.now();
    const recvWindow = 50000;
    
    const params: Record<string, any> = {
      timestamp,
      recvWindow,
    };
    
    const queryString = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');
    
    const signature = crypto
      .createHmac('sha256', API_SECRET!)
      .update(queryString)
      .digest('hex');
    
    const finalParams = { ...params, signature };
    const queryParams: string[] = [];
    const signatureParam: string[] = [];
    for (const [key, value] of Object.entries(finalParams)) {
      if (key === 'signature') {
        signatureParam.push(`${key}=${value}`);
      } else {
        queryParams.push(`${key}=${value}`);
      }
    }
    queryParams.sort();
    const finalQueryString = queryParams.join('&') + (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

    const response = await axios.get(
      `${FAPI_BASE_URL}/fapi/v4/account?${finalQueryString}`,
      {
        headers: {
          'X-MBX-APIKEY': API_KEY!,
        },
        timeout: 10000,
      }
    );

    const assets = response.data?.assets || [];
    const usdtAsset = assets.find((a: any) => a.asset === 'USDT' || a.asset === 'USDC');
    
    if (usdtAsset) {
      console.log(`✅ ${usdtAsset.asset} Balance: ${usdtAsset.walletBalance}`);
      console.log(`   Available: ${usdtAsset.availableBalance}`);
      console.log(`   Max Withdraw: ${usdtAsset.maxWithdrawAmount}\n`);
      return { balance: parseFloat(usdtAsset.availableBalance || '0'), asset: usdtAsset.asset };
    } else {
      console.log('⚠️  USDT/USDC asset not found in account\n');
      return { balance: 0, asset: 'USDT' };
    }
  } catch (error: any) {
    console.log(`❌ Balance check failed: ${error.response?.data?.msg || error.message}\n`);
    return { balance: 0, asset: 'USDT' };
  }
}

async function testWithdrawal() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   TEST ASTER WITHDRAWAL (EIP712 - Web Interface Flow)  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Check balance first
  const { balance, asset } = await checkBalance();
  
  if (balance < 2) {
    console.log(`⚠️  Insufficient balance for withdrawal test (need at least $2 ${asset})`);
    console.log('   Skipping withdrawal test\n');
    return;
  }

  // Initialize wallet
  if (!PRIVATE_KEY) {
    console.error('❌ ERROR: PRIVATE_KEY is required');
    process.exit(1);
  }
  const normalizedPrivateKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const wallet = new ethers.Wallet(normalizedPrivateKey);
  console.log(`🔐 Wallet Address: ${wallet.address}\n`);

  // Test parameters
  const testParams = {
    asset: asset, // Use asset from balance check
    amount: 1.0, // Small test amount
    destination: '0xa90714a15d6e5c0eb3096462de8dc4b22e01589a', // Your wallet
    chainId: 42161, // Arbitrum
  };

  console.log('📋 Withdrawal Parameters:');
  console.log(`   Asset: ${testParams.asset}`);
  console.log(`   Amount: ${testParams.amount}`);
  console.log(`   Destination: ${testParams.destination}`);
  console.log(`   Chain ID: ${testParams.chainId} (Arbitrum)\n`);

  try {
    // Step 1: Get withdrawal fee from API
    console.log('💰 Step 1: Querying withdrawal fee from API...\n');
    let fee: string;
    try {
      const feeResponse = await axios.get(
        'https://www.asterdex.com/bapi/futures/v1/public/future/aster/estimate-withdraw-fee',
        {
          params: {
            chainId: testParams.chainId,
            network: 'EVM',
            currency: testParams.asset.toUpperCase(),
            accountType: 'spot',
          },
          timeout: 10000,
        }
      );
      
      if (feeResponse.data?.success && feeResponse.data?.data?.gasCost !== undefined) {
        fee = feeResponse.data.data.gasCost.toString();
        console.log(`   ✅ Fee from API: ${fee} ${testParams.asset}`);
        console.log(`   Gas Limit: ${feeResponse.data.data.gasLimit || 'N/A'}`);
        console.log(`   Gas USD Value: ${feeResponse.data.data.gasUsdValue || 'N/A'}\n`);
      } else {
        fee = '0.5'; // Fallback
        console.log(`   ⚠️  API response format unexpected, using default: ${fee}\n`);
      }
    } catch (feeError: any) {
      fee = '0.5'; // Fallback
      console.log(`   ⚠️  Failed to query fee from API: ${feeError.message}`);
      console.log(`   Using default fee: ${fee}\n`);
    }
    
    // Step 2: Generate nonce (timestamp in milliseconds * 1000 for microseconds)
    const nonceMs = Date.now();
    const nonceValue = nonceMs * 1000; // Convert to microseconds
    const nonceString = nonceValue.toString(); // String for HMAC
    
    console.log(`🔢 Step 2: Generated nonce: ${nonceString} (${nonceMs}ms * 1000)\n`);
    
    // Step 3: Map chainId to chain name
    const chainNameMap: Record<number, string> = {
      56: 'BSC',
      42161: 'Arbitrum',
      1: 'ETH',
    };
    const destinationChain = chainNameMap[testParams.chainId] || 'Arbitrum';
    
    // Step 4: Build EIP712 domain (matches web interface)
    const domain = {
      name: 'Aster',
      version: '1',
      chainId: testParams.chainId,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    };
    
    // Step 5: Build EIP712 types (matches web interface)
    const types = {
      Action: [
        { name: 'type', type: 'string' },
        { name: 'destination', type: 'address' },
        { name: 'destination Chain', type: 'string' },
        { name: 'token', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'fee', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'aster chain', type: 'string' },
      ],
    };
    
    // Step 6: Build EIP712 message (matches web interface exactly)
    const message = {
      type: 'Withdraw',
      destination: testParams.destination.toLowerCase(),
      'destination Chain': destinationChain,
      token: testParams.asset.toUpperCase(),
      amount: testParams.amount.toFixed(2),
      fee: fee,
      nonce: nonceValue, // Number (ethers.js converts to uint256)
      'aster chain': 'Mainnet',
    };
    
    console.log('📝 Step 3: EIP712 Message Structure:');
    console.log(`   Primary type: Action`);
    console.log(`   Type: ${message.type}`);
    console.log(`   Destination: ${message.destination}`);
    console.log(`   Destination Chain: ${message['destination Chain']}`);
    console.log(`   Token: ${message.token}`);
    console.log(`   Amount: ${message.amount}`);
    console.log(`   Fee: ${message.fee}`);
    console.log(`   Nonce: ${message.nonce}`);
    console.log(`   Aster chain: ${message['aster chain']}\n`);
    
    // Step 7: Sign using EIP712 typed data
    console.log('✍️  Step 4: Signing with wallet (EIP712)...');
    const userSignature = await wallet.signTypedData(domain, types, message);
    console.log(`   ✅ EIP712 Signature: ${userSignature.substring(0, 20)}...\n`);
    
    // Step 8: Build HMAC parameters (per Aster docs section 6)
    // Parameters: chainId, asset, amount, fee, receiver, nonce, userSignature, recvWindow, timestamp
    const timestamp = Date.now();
    const recvWindow = 60000;
    
    const hmacParams: Record<string, any> = {
      chainId: testParams.chainId.toString(),
      asset: testParams.asset.toUpperCase(),
      amount: testParams.amount.toFixed(2),
      fee: fee,
      receiver: testParams.destination.toLowerCase(),
      nonce: nonceString,
      userSignature: userSignature, // EIP712 signature - included in HMAC
      recvWindow: recvWindow,
      timestamp: timestamp,
    };
    
    // Remove null/undefined values
    const cleanParams = Object.fromEntries(
      Object.entries(hmacParams).filter(([, value]) => value !== null && value !== undefined)
    );
    
    // Build query string for HMAC signing (sorted alphabetically)
    const queryString = Object.keys(cleanParams)
      .sort()
      .map((key) => `${key}=${cleanParams[key]}`) // No URL encoding
      .join('&');
    
    console.log('🔐 Step 5: HMAC Signing:');
    console.log(`   Query string (first 300 chars): ${queryString.substring(0, 300)}...`);
    console.log(`   Query string length: ${queryString.length}\n`);
    
    // Step 9: Create HMAC SHA256 signature using PRIVATE_KEY
    if (!PRIVATE_KEY) {
      throw new Error('PRIVATE_KEY is required for HMAC signing');
    }
    const privateKeyForHmac = PRIVATE_KEY.replace(/^0x/, '');
    const hmacSignature = crypto.createHmac('sha256', privateKeyForHmac)
      .update(queryString)
      .digest('hex');
    
    console.log(`   ✅ HMAC Signature: ${hmacSignature.substring(0, 20)}...\n`);
    
    // Step 10: Build final query string with signature last
    const finalQueryString = `${queryString}&signature=${hmacSignature}`;
    
    console.log('📤 Step 6: Sending withdrawal request...');
    console.log(`   Method: POST`);
    console.log(`   URL: ${FAPI_BASE_URL}/fapi/aster/user-withdraw`);
    console.log(`   Query String (first 200 chars): ${finalQueryString.substring(0, 200)}...`);
    console.log(`   Headers: X-MBX-APIKEY: ${API_KEY?.substring(0, 10)}...\n`);
    
    console.log('⚠️  WARNING: This will attempt a REAL withdrawal!\n');
    console.log('Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 11: Make the request
    const response = await axios.post(
      `${FAPI_BASE_URL}/fapi/aster/user-withdraw?${finalQueryString}`,
      {}, // Empty body
      {
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': API_KEY!,
        },
        timeout: 30000,
      }
    );

    console.log('✅ Response received:');
    console.log(`   Status: ${response.status} ${response.statusText}`);
    console.log(`   Data: ${JSON.stringify(response.data, null, 2)}\n`);

    // Handle response (per Aster API documentation section 6)
    if (response.data && response.data.withdrawId) {
      const withdrawId = response.data.withdrawId;
      const hash = response.data.hash || 'unknown';
      console.log(`✅✅✅ WITHDRAWAL SUCCESSFUL! ✅✅✅`);
      console.log(`   Withdrawal ID: ${withdrawId}`);
      console.log(`   Hash: ${hash}`);
      console.log(`   Amount: ${testParams.amount} ${testParams.asset}`);
      console.log(`   To: ${testParams.destination}`);
      console.log(`\n   Check your wallet on Arbitrum to confirm receipt!\n`);
    } else {
      console.log('⚠️  Response received but format unexpected');
      console.log(`   Full response: ${JSON.stringify(response.data, null, 2)}\n`);
    }
  } catch (error: any) {
    console.error('\n❌ Withdrawal failed:');
    if (error.response) {
      console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
      console.error(`   Error Code: ${error.response.data?.code || 'N/A'}`);
      console.error(`   Error Message: ${error.response.data?.msg || error.response.data?.message || 'N/A'}`);
      
      if (error.response.data?.code === -1000 && error.response.data?.msg?.includes('Multi chain limit')) {
        console.error('\n   ⚠️  Multi-chain limit error:');
        console.error('      Aster limits withdrawals across different chains.');
        console.error('      You may need to wait before trying again.\n');
      }
      
      console.error(`   Full Response: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error(`   No response received: ${error.message}`);
    } else {
      console.error(`   Request setup error: ${error.message}`);
    }
    throw error;
  }
}

// Run the test
testWithdrawal()
  .then(() => {
    console.log('✅ Test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  });

