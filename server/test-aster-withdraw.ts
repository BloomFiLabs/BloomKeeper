/**
 * Test script for Aster withdrawal API
 * This script tests the withdrawal endpoint to debug issues
 */

import * as dotenv from 'dotenv';
import axios from 'axios';
import * as crypto from 'crypto';

dotenv.config();

const ASTER_BASE_URL = 'https://fapi.asterdex.com';
const API_KEY = process.env.ASTER_API_KEY;
const API_SECRET = process.env.ASTER_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error('❌ ERROR: ASTER_API_KEY and ASTER_API_SECRET must be set in .env');
  process.exit(1);
}

/**
 * Sign parameters with API key (HMAC SHA256)
 */
function signParamsWithApiKey(params: Record<string, any>): Record<string, any> {
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined),
  );

  cleanParams.timestamp = Date.now(); // Milliseconds
  cleanParams.recvWindow = cleanParams.recvWindow ?? 50000;

  const queryString = Object.keys(cleanParams)
    .sort()
    .map((key) => `${key}=${cleanParams[key]}`) // No URL encoding for signing
    .join('&');

  const signature = crypto
    .createHmac('sha256', API_SECRET!)
    .update(queryString)
    .digest('hex');

  return {
    ...cleanParams,
    signature,
  };
}

async function testAccountInfo() {
  console.log('🔍 Testing account info endpoint first...\n');
  
  try {
    const params = signParamsWithApiKey({});
    const queryParams: string[] = [];
    const signatureParam: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (key === 'signature') {
        signatureParam.push(`${key}=${value}`);
      } else {
        queryParams.push(`${key}=${value}`);
      }
    }
    queryParams.sort();
    const finalQueryString = queryParams.join('&') + (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

    const response = await axios.get(
      `${ASTER_BASE_URL}/fapi/v2/account?${finalQueryString}`,
      {
        headers: {
          'X-MBX-APIKEY': API_KEY!,
        },
        timeout: 10000,
      }
    );

    console.log('✅ Account info retrieved:');
    console.log(`   Can Withdraw: ${response.data?.canWithdraw || 'N/A'}`);
    console.log(`   Max Withdraw: ${response.data?.maxWithdrawAmount || 'N/A'}`);
    console.log(`   Available Balance: ${response.data?.availableBalance || 'N/A'}\n`);
    
    return response.data;
  } catch (error: any) {
    console.log(`   ❌ Account info failed: ${error.response?.data?.msg || error.message}\n`);
    return null;
  }
}

async function testWithdrawal() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         TEST ASTER WITHDRAWAL API                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log(`API Key: ${API_KEY?.substring(0, 10)}...`);
  console.log(`Base URL: ${ASTER_BASE_URL}\n`);

  // First check account info
  await testAccountInfo();

  // Test parameters
  const testParams = {
    asset: 'USDT',
    amount: '1.0', // Small test amount
    address: '0xa90714a15d6e5c0eb3096462de8dc4b22e01589a', // Central wallet
    chainId: '42161', // Arbitrum
  };

  console.log('📋 Withdrawal Parameters:');
  console.log(`   Asset: ${testParams.asset}`);
  console.log(`   Amount: ${testParams.amount}`);
  console.log(`   Address: ${testParams.address}`);
  console.log(`   Chain ID: ${testParams.chainId}\n`);

  try {
    // Sign the parameters
    console.log('🔐 Signing parameters...');
    const signedParams = signParamsWithApiKey({
      asset: testParams.asset,
      amount: testParams.amount,
      address: testParams.address,
      chainId: testParams.chainId,
    });

    console.log('✅ Parameters signed\n');

    // Build query string with signature last
    const queryParams: string[] = [];
    const signatureParam: string[] = [];
    for (const [key, value] of Object.entries(signedParams)) {
      if (key === 'signature') {
        signatureParam.push(`${key}=${value}`);
      } else {
        queryParams.push(`${key}=${value}`);
      }
    }
    queryParams.sort(); // Sort other params
    const finalQueryString = queryParams.join('&') + (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

    console.log('📤 Request Details:');
    console.log(`   Method: POST`);
    console.log(`   URL: ${ASTER_BASE_URL}/fapi/v1/withdraw`);
    console.log(`   Query String: ${finalQueryString.substring(0, 200)}...`);
    console.log(`   Headers: X-MBX-APIKEY: ${API_KEY?.substring(0, 10)}...\n`);

    // Make the request
    console.log('🚀 Sending withdrawal request...\n');
    
    // Try different approaches
    console.log('📝 Attempt 1: POST with query string (current method)...');
    try {
      const response = await axios.post(
        `${ASTER_BASE_URL}/fapi/v1/withdraw?${finalQueryString}`,
        {}, // Empty body
        {
          headers: {
            'X-MBX-APIKEY': API_KEY!,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
      console.log('✅ Success with query string method!');
      console.log(`   Status: ${response.status}`);
      console.log(`   Data: ${JSON.stringify(response.data, null, 2)}\n`);
      return;
    } catch (error1: any) {
      console.log(`   ❌ Failed: ${error1.response?.data?.msg || error1.message}\n`);
    }

    // Try with body instead of query string
    console.log('📝 Attempt 2: POST with body parameters...');
    try {
      const response = await axios.post(
        `${ASTER_BASE_URL}/fapi/v1/withdraw`,
        signedParams, // Parameters in body
        {
          headers: {
            'X-MBX-APIKEY': API_KEY!,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
      console.log('✅ Success with body method!');
      console.log(`   Status: ${response.status}`);
      console.log(`   Data: ${JSON.stringify(response.data, null, 2)}\n`);
      return;
    } catch (error2: any) {
      console.log(`   ❌ Failed: ${error2.response?.data?.msg || error2.message}\n`);
    }

    // Try without chainId (maybe it's optional or different format)
    console.log('📝 Attempt 3: POST without chainId...');
    try {
      const paramsWithoutChain = signParamsWithApiKey({
        asset: testParams.asset,
        amount: testParams.amount,
        address: testParams.address,
      });
      
      const queryParams2: string[] = [];
      const signatureParam2: string[] = [];
      for (const [key, value] of Object.entries(paramsWithoutChain)) {
        if (key === 'signature') {
          signatureParam2.push(`${key}=${value}`);
        } else {
          queryParams2.push(`${key}=${value}`);
        }
      }
      queryParams2.sort();
      const finalQueryString2 = queryParams2.join('&') + (signatureParam2.length > 0 ? `&${signatureParam2[0]}` : '');

      const response = await axios.post(
        `${ASTER_BASE_URL}/fapi/v1/withdraw?${finalQueryString2}`,
        {},
        {
          headers: {
            'X-MBX-APIKEY': API_KEY!,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
      console.log('✅ Success without chainId!');
      console.log(`   Status: ${response.status}`);
      console.log(`   Data: ${JSON.stringify(response.data, null, 2)}\n`);
      return;
    } catch (error3: any) {
      console.log(`   ❌ Failed: ${error3.response?.data?.msg || error3.message}\n`);
    }

    // If all attempts fail, throw the last error
    throw new Error('All withdrawal attempts failed');

    console.log('✅ Response received:');
    console.log(`   Status: ${response.status} ${response.statusText}`);
    console.log(`   Data: ${JSON.stringify(response.data, null, 2)}\n`);

    if (response.data && (response.data.id || response.data.tranId || response.data.withdrawId)) {
      const withdrawId = response.data.id || response.data.tranId || response.data.withdrawId;
      console.log(`✅ Withdrawal successful! Withdrawal ID: ${withdrawId}`);
    } else {
      console.log('⚠️  Response received but no withdrawal ID found');
    }
  } catch (error: any) {
    console.error('\n❌ Error occurred:');
    if (error.response) {
      console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
      console.error(`   Error Code: ${error.response.data?.code || 'N/A'}`);
      console.error(`   Error Message: ${error.response.data?.msg || error.response.data?.message || 'N/A'}`);
      console.error(`   Full Response: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error(`   No response received: ${error.message}`);
    } else {
      console.error(`   Request setup error: ${error.message}`);
    }
    console.error(`\n   Stack: ${error.stack}`);
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

