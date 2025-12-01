import dotenv from 'dotenv';
import axios from 'axios';
import * as crypto from 'crypto';

dotenv.config();

async function testAsterBalance() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          TEST ASTER BALANCE QUERY                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Remove trailing slash if present (causes 403 errors)
  let baseUrl = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
  baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
  const apiKey = process.env.ASTER_API_KEY;
  const apiSecret = process.env.ASTER_API_SECRET;
  const user = process.env.ASTER_USER;
  const signer = process.env.ASTER_SIGNER;
  const privateKey = process.env.ASTER_PRIVATE_KEY;

  console.log(`📡 Configuration:`);
  console.log(`   Base URL: ${baseUrl}`);
  console.log(`   API Key: ${apiKey ? apiKey.substring(0, 8) + '...' : 'NOT SET'}`);
  console.log(`   API Secret: ${apiSecret ? '***' + apiSecret.slice(-4) : 'NOT SET'}`);
  console.log(`   User: ${user || 'NOT SET'}`);
  console.log(`   Signer: ${signer || 'NOT SET'}\n`);

  // Test with API key/secret first
  if (apiKey && apiSecret) {
    console.log('🔐 Testing with API Key/Secret authentication...\n');
    await testWithApiKey(baseUrl, apiKey, apiSecret);
  }

  // Test with Ethereum signature if available
  if (user && signer && privateKey) {
    console.log('\n🔐 Testing with Ethereum signature authentication...\n');
    await testWithEthereumSignature(baseUrl, user, signer, privateKey);
  }

  if (!apiKey && !user) {
    console.error('❌ ERROR: No authentication method available');
    console.error('   Set either:');
    console.error('   - ASTER_API_KEY and ASTER_API_SECRET (for API key auth)');
    console.error('   - ASTER_USER, ASTER_SIGNER, and ASTER_PRIVATE_KEY (for signature auth)');
    process.exit(1);
  }
}

async function testWithApiKey(baseUrl: string, apiKey: string, apiSecret: string) {
  try {
    // Create signed params
    const params: Record<string, any> = {};
    // Try milliseconds first (the error said timestamp outside recvWindow, might be format issue)
    params.timestamp = Date.now(); // Use milliseconds
    params.recvWindow = 50000;

    // Create query string for signing (sorted alphabetically)
    // Try WITHOUT URL encoding first (some APIs don't want encoding in signature)
    const queryString = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`) // No URL encoding
      .join('&');

    console.log(`   Query String (for signing): ${queryString}`);

    // Create HMAC signature
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    params.signature = signature;

    console.log('📋 Request Parameters:');
    console.log(`   Timestamp: ${params.timestamp} (seconds)`);
    console.log(`   RecvWindow: ${params.recvWindow}`);
    console.log(`   Signature: ${signature.substring(0, 16)}...`);
    console.log(`   Query String (signed): ${queryString}\n`);

    // Make request
    // Try both header formats - some APIs use Bearer token, others use X-MBX-APIKEY
    const headers: Record<string, string> = {
      'X-MBX-APIKEY': apiKey,
      // Also try Bearer token format (some APIs use this)
      // 'Authorization': `Bearer ${apiKey}`,
    };
    
    // Aster API v3 uses /fapi/v3/balance endpoint
    // Note: Based on official docs, Aster requires Ethereum signature auth, not HMAC API keys
    // API keys might be for a different purpose (like API wallet registration)
    const response = await axios.get(`${baseUrl}/fapi/v3/balance`, {
      params,
      headers,
      timeout: 10000,
    });

    console.log('✅ Request successful!');
    console.log(`   Status: ${response.status}`);
    console.log(`   Response:`, JSON.stringify(response.data, null, 2));

    if (Array.isArray(response.data) && response.data.length > 0) {
      const usdtBalance = response.data.find((b: any) => b.asset === 'USDT');
      if (usdtBalance) {
        console.log(`\n💰 USDT Balance: $${parseFloat(usdtBalance.availableBalance || '0').toFixed(2)}`);
      }
    }

  } catch (error: any) {
    console.error('❌ API Key authentication failed');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Response: ${JSON.stringify(error.response.data)}`);
      
      if (error.response.status === 400 && error.response.data?.msg?.includes('Signature')) {
        console.error('\n💡 Signature validation failed. Try:');
        console.error('   1. Timestamp in milliseconds instead of seconds');
        console.error('   2. Remove URL encoding from query string');
        console.error('   3. Check Aster API docs for exact signature format');
      }
    } else {
      console.error(`   Error: ${error.message}`);
    }
  }
}

async function testWithEthereumSignature(
  baseUrl: string,
  user: string,
  signer: string,
  privateKey: string,
) {
  try {
    const { ethers } = await import('ethers');
    const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(normalizedPrivateKey);

    const nonce = Math.floor(Date.now() * 1000);
    const params: Record<string, any> = {};
    params.timestamp = Math.floor(Date.now());
    params.recvWindow = 50000;

    // Trim and convert to strings (matching adapter logic)
    const trimmedParams: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      trimmedParams[key] = String(value);
    }

    const jsonStr = JSON.stringify(trimmedParams, Object.keys(trimmedParams).sort());

    // Encode with ABI coder
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ['string', 'address', 'address', 'uint256'],
      [jsonStr, user, signer, nonce],
    );

    const keccakHash = ethers.keccak256(encoded);
    const hashBytes = ethers.getBytes(keccakHash);

    const prefix = '\x19Ethereum Signed Message:\n';
    const lengthStr = hashBytes.length.toString();
    const message = ethers.concat([
      ethers.toUtf8Bytes(prefix),
      ethers.toUtf8Bytes(lengthStr),
      hashBytes,
    ]);

    const messageHash = ethers.keccak256(message);
    const signature = wallet.signingKey.sign(ethers.getBytes(messageHash));

    const signatureHex = ethers.Signature.from({
      r: signature.r,
      s: signature.s,
      v: signature.v,
    }).serialized;

    const signedParams = {
      ...params,
      nonce,
      user,
      signer,
      signature: signatureHex,
    };

    console.log('📋 Request Parameters:');
    console.log(`   User: ${user}`);
    console.log(`   Signer: ${signer}`);
    console.log(`   Nonce: ${nonce}`);
    console.log(`   Timestamp: ${params.timestamp}`);
    console.log(`   Signature: ${signatureHex.substring(0, 20)}...\n`);

    const response = await axios.get(`${baseUrl}/fapi/v2/balance`, {
      params: signedParams,
      timeout: 10000,
    });

    console.log('✅ Request successful!');
    console.log(`   Status: ${response.status}`);
    console.log(`   Response:`, JSON.stringify(response.data, null, 2));

    if (Array.isArray(response.data) && response.data.length > 0) {
      const usdtBalance = response.data.find((b: any) => b.asset === 'USDT');
      if (usdtBalance) {
        console.log(`\n💰 USDT Balance: $${parseFloat(usdtBalance.availableBalance || '0').toFixed(2)}`);
      }
    }

  } catch (error: any) {
    console.error('❌ Ethereum signature authentication failed');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Response: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`   Error: ${error.message}`);
    }
  }
}

testAsterBalance().catch(console.error);

