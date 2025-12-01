/**
 * Test script for Aster withdrawal with EIP712 signature
 * This tests the withdrawal endpoint using the correct EIP712 signing method
 */

import * as dotenv from 'dotenv';
import axios from 'axios';
import { ethers } from 'ethers';

dotenv.config();

const ASTER_BASE_URL = 'https://www.asterdex.com';
const FAPI_BASE_URL = 'https://fapi.asterdex.com';
const USER_ADDRESS = process.env.ASTER_USER;
const SIGNER_ADDRESS = process.env.ASTER_SIGNER;
// Use PRIVATE_KEY from .env (not ASTER_PRIVATE_KEY) for HMAC signature
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.ASTER_PRIVATE_KEY;
const PRIVATE_KEY_FOR_EIP712 = process.env.ASTER_PRIVATE_KEY || process.env.PRIVATE_KEY;
const API_KEY = process.env.ASTER_API_KEY;
const API_SECRET = process.env.ASTER_API_SECRET;

if (!USER_ADDRESS || !SIGNER_ADDRESS || !PRIVATE_KEY_FOR_EIP712) {
  console.error('❌ ERROR: ASTER_USER, ASTER_SIGNER, and ASTER_PRIVATE_KEY (or PRIVATE_KEY) must be set in .env');
  process.exit(1);
}

if (!PRIVATE_KEY) {
  console.error('❌ ERROR: PRIVATE_KEY must be set in .env for HMAC signature');
  process.exit(1);
}

if (!API_KEY || !API_SECRET) {
  console.warn('⚠️  WARNING: ASTER_API_KEY and ASTER_API_SECRET not set. Will try endpoint without API key auth.');
}

/**
 * Trim dictionary values (convert to strings, remove null/undefined)
 */
function trimDict(myDict: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(myDict)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'boolean') {
      result[key] = String(value);
    } else if (typeof value === 'number') {
      result[key] = String(value);
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

async function testWithdrawal() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      TEST ASTER WITHDRAWAL (EIP712 SIGNATURE)           ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log(`User Address: ${USER_ADDRESS}`);
  console.log(`Signer Address: ${SIGNER_ADDRESS}`);
  console.log(`Base URL: ${ASTER_BASE_URL}\n`);

  // Initialize wallet
  const normalizedPrivateKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const wallet = new ethers.Wallet(normalizedPrivateKey);
  console.log(`Wallet Address: ${wallet.address}\n`);

  // Test parameters
  const testParams = {
    asset: 'USDT',
    amount: 1.0, // Small test amount
    destination: '0xa90714a15d6e5c0eb3096462de8dc4b22e01589a', // Central wallet
    chainId: 42161, // Arbitrum
  };

  console.log('📋 Withdrawal Parameters:');
  console.log(`   Asset: ${testParams.asset}`);
  console.log(`   Amount: ${testParams.amount}`);
  console.log(`   Destination: ${testParams.destination}`);
  console.log(`   Chain ID: ${testParams.chainId} (Arbitrum)\n`);

  try {
    // Get withdrawal fee from API (per Aster documentation section 3)
    // Endpoint: /bapi/futures/v1/public/future/aster/estimate-withdraw-fee
    console.log('💰 Querying withdrawal fee from API...\n');
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
        // gasCost is the estimated withdrawal fee in token units
        fee = feeResponse.data.data.gasCost.toString();
        console.log(`   ✅ Fee from API: ${fee} ${testParams.asset}`);
        console.log(`   Gas Limit: ${feeResponse.data.data.gasLimit || 'N/A'}`);
        console.log(`   Gas USD Value: ${feeResponse.data.data.gasUsdValue || 'N/A'}\n`);
      } else {
        // Fallback to a default fee
        fee = '0.01';
        console.log(`   ⚠️  API response format unexpected, using default: ${fee}\n`);
      }
    } catch (feeError: any) {
      // Fallback to a default fee if API call fails
      fee = '0.01';
      console.log(`   ⚠️  Failed to query fee from API: ${feeError.message}`);
      console.log(`   Using default fee: ${fee}\n`);
    }
    
    // Generate nonce (timestamp in milliseconds, then multiply by 1000 for microseconds)
    const nonceMs = Date.now();
    const nonceValue = nonceMs * 1000; // Convert to microseconds
    const nonceString = nonceValue.toString(); // String for request body
    
    console.log(`   Nonce (microseconds): ${nonceString}\n`);
    
    // Map chainId to chain name (required for EIP712 signature)
    const chainNameMap: Record<number, string> = {
      56: 'BSC',
      42161: 'Arbitrum',
      1: 'ETH',
    };
    const destinationChain = chainNameMap[testParams.chainId] || 'Arbitrum';
    
    console.log('🔐 Creating EIP712 Signature...\n');
    
    // Build EIP712 domain (per Aster documentation)
    const domain = {
      name: 'Aster',
      version: '1',
      chainId: testParams.chainId, // The chainId of the withdraw chain
      verifyingContract: '0x0000000000000000000000000000000000000000', // Fixed zero address
    };
    
    console.log('   EIP712 Domain:');
    console.log(`      name: ${domain.name}`);
    console.log(`      version: ${domain.version}`);
    console.log(`      chainId: ${domain.chainId}`);
    console.log(`      verifyingContract: ${domain.verifyingContract}\n`);
    
    // Build EIP712 types (per Aster documentation)
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
    
    // Build EIP712 message (per Aster documentation)
    const message = {
      type: 'Withdraw',
      destination: testParams.destination.toLowerCase(),
      'destination Chain': destinationChain,
      token: testParams.asset.toUpperCase(),
      amount: testParams.amount.toFixed(2),
      fee: fee,
      nonce: nonceValue, // Number, ethers.js will convert to uint256
      'aster chain': 'Mainnet',
    };
    
    console.log('   EIP712 Message:');
    console.log(`      type: ${message.type}`);
    console.log(`      destination: ${message.destination}`);
    console.log(`      destination Chain: ${message['destination Chain']}`);
    console.log(`      token: ${message.token}`);
    console.log(`      amount: ${message.amount}`);
    console.log(`      fee: ${message.fee}`);
    console.log(`      nonce: ${message.nonce}`);
    console.log(`      aster chain: ${message['aster chain']}\n`);
    
    // Sign using EIP712 typed data
    console.log('   Signing with wallet...');
    const userSignature = await wallet.signTypedData(domain, types, message);
    console.log(`   ✅ Signature created: ${userSignature.substring(0, 20)}...\n`);

    // Build request body (per Aster API documentation)
    const requestBody = {
      accountType: 'spot', // Withdrawals come from spot account
      amount: testParams.amount.toFixed(2),
      chainId: testParams.chainId,
      currency: testParams.asset.toUpperCase(),
      fee: fee,
      nonce: nonceString, // String representation of nonce (timestamp in microseconds)
      receiver: testParams.destination.toLowerCase(),
      userSignature: userSignature,
    };

    console.log('📤 Request Details:');
    console.log(`   Method: POST`);
    console.log(`   URL: ${ASTER_BASE_URL}/bapi/futures/v1/private/future/aster/user-withdraw`);
    console.log(`   Body: ${JSON.stringify(requestBody, null, 2)}\n`);

    // Try fapi endpoint with API key authentication (per Aster docs section 6)
    // This endpoint uses API key + HMAC signature instead of session-based auth
    if (!API_KEY || !API_SECRET) {
      throw new Error('ASTER_API_KEY and ASTER_API_SECRET required for fapi endpoint');
    }
    
    console.log('🚀 Attempting withdrawal via fapi endpoint (with API key auth)...\n');
    
    // Build query string with HMAC signature using PRIVATE_KEY (not API_SECRET)
    // Per Aster docs section 6: withdraw by API [evm] [futures]
    const crypto = await import('crypto');
    const timestamp = Date.now();
    const recvWindow = 60000;
    
    // Build parameters for HMAC signing
    // Per Aster docs section 6: parameters for HMAC are chainId, asset, amount, fee, receiver, nonce, userSignature, recvWindow, timestamp
    // Note: userSignature is the EIP712 signature and IS included in the HMAC calculation
    
    // Parameters for HMAC signature (exclude signature itself)
    // Fee is required - need to include it in HMAC
    const hmacParams: Record<string, any> = {
      chainId: testParams.chainId,
      asset: testParams.asset.toUpperCase(),
      amount: testParams.amount.toFixed(2),
      fee: fee, // Fee is required - must be included in HMAC
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
    
    console.log('   Query string for HMAC signing:');
    console.log(`   ${queryString.substring(0, 400)}...\n`);
    
    // Create HMAC SHA256 signature using PRIVATE_KEY (not API_SECRET)
    // Remove 0x prefix if present
    const privateKeyForHmac = PRIVATE_KEY.replace(/^0x/, '');
    const signature = crypto.createHmac('sha256', privateKeyForHmac)
      .update(queryString)
      .digest('hex');
    
    console.log(`   HMAC Signature (using PRIVATE_KEY): ${signature}\n`);
    
    // Build final query string: include all params + signature last
    const finalQueryString = `${queryString}&signature=${signature}`;
    
    console.log('📤 Request Details:');
    console.log(`   Method: POST`);
    console.log(`   URL: ${FAPI_BASE_URL}/fapi/aster/user-withdraw`);
    console.log(`   Query String: ${finalQueryString.substring(0, 200)}...`);
    console.log(`   Headers: X-MBX-APIKEY: ${API_KEY?.substring(0, 10)}...\n`);
    
    const response = await axios.post(
      `${FAPI_BASE_URL}/fapi/aster/user-withdraw?${finalQueryString}`,
      {}, // Empty body for fapi endpoint
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
      console.log(`✅ Withdrawal successful!`);
      console.log(`   Withdrawal ID: ${withdrawId}`);
      console.log(`   Hash: ${hash}`);
    } else {
      console.log('⚠️  Response received but format unexpected');
      console.log(`   Full response: ${JSON.stringify(response.data, null, 2)}`);
    }
  } catch (error: any) {
    console.error('\n❌ Error occurred:');
    if (error.response) {
      console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
      console.error(`   Error Code: ${error.response.data?.code || 'N/A'}`);
      console.error(`   Error Message: ${error.response.data?.message || error.response.data?.msg || 'N/A'}`);
      console.error(`   Full Response: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error(`   No response received: ${error.message}`);
    } else {
      console.error(`   Request setup error: ${error.message}`);
    }
    if (error.stack) {
      console.error(`\n   Stack: ${error.stack}`);
    }
    process.exit(1);
  }
}

// Run the test
testWithdrawal()
  .then(() => {
    console.log('\n✅ Test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });

