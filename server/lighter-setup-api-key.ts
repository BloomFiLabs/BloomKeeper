/**
 * Lighter API Key Setup Script
 * 
 * This script sets up an API key for Lighter trading by:
 * 1. Finding your account index from your Ethereum address
 * 2. Generating a new API key pair (40-char private key)
 * 3. Registering the API key with your account
 * 4. Saving the API key for future use
 * 
 * Based on: https://github.com/elliottech/lighter-python/blob/main/examples/system_setup.py
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file (your Ethereum private key - 64 hex chars)
 *   2. Optionally set ACCOUNT_INDEX and API_KEY_INDEX (defaults: auto-detect, 1)
 *   3. Run: npx tsx lighter-setup-api-key.ts
 */

import { SignerClient, ApiClient, AccountApi, createWasmSignerClient } from '@reservoir0x/lighter-ts-sdk';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const ETH_PRIVATE_KEY = process.env.PRIVATE_KEY;
const API_KEY_INDEX = parseInt(process.env.API_KEY_INDEX || '1');

if (!ETH_PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY not found in .env file (Ethereum private key required)');
}

// Normalize Ethereum private key
const normalizedEthKey = ETH_PRIVATE_KEY.startsWith('0x') 
  ? ETH_PRIVATE_KEY.slice(2) 
  : ETH_PRIVATE_KEY;

if (normalizedEthKey.length !== 64) {
  throw new Error('PRIVATE_KEY must be a 64-character Ethereum private key');
}

// ═══════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════

async function setupApiKey() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   LIGHTER API KEY SETUP                                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Get Ethereum address from private key
  const wallet = new ethers.Wallet(`0x${normalizedEthKey}`);
  const ethAddress = wallet.address;

  console.log('📡 Initializing Lighter API client...');
  console.log(`   API Base: ${BASE_URL}`);
  console.log(`   Ethereum Address: ${ethAddress}`);
  console.log(`   API Key Index: ${API_KEY_INDEX}`);
  console.log('');

  const apiClient = new ApiClient({ host: BASE_URL });
  const accountApi = new AccountApi(apiClient);

  try {
    // Step 1: Find account index from Ethereum address
    console.log('🔍 Finding account index...');
    let accountIndex: number;

    try {
      const response: any = await accountApi.getAccountsByL1Address(ethAddress);
      
      // The response can be an array or an object with sub_accounts
      let subAccounts: any[] = [];
      
      if (Array.isArray(response)) {
        // If it's an array, use it directly
        subAccounts = response.flatMap((acc: any) => acc.sub_accounts || [acc]);
      } else if (response.sub_accounts) {
        // If it's an object with sub_accounts
        subAccounts = response.sub_accounts;
      } else if (response.index) {
        // If it's a single account object
        subAccounts = [response];
      }
      
      if (!subAccounts || subAccounts.length === 0) {
        throw new Error(`Account not found for address ${ethAddress}`);
      }

      if (subAccounts.length > 1) {
        console.log('   Multiple accounts found:');
        subAccounts.forEach((subAccount: any, idx: number) => {
          console.log(`     ${idx}: Account Index: ${subAccount.index}`);
        });
        console.log('   Using the first account');
      }

      accountIndex = parseInt(subAccounts[0].index);
      console.log(`   ✅ Found account index: ${accountIndex}`);
      console.log('');

    } catch (error: any) {
      if (error.message && error.message.includes('account not found')) {
        throw new Error(`Account not found for address ${ethAddress}. Please deposit funds first.`);
      }
      throw error;
    }

    // Step 2: Generate API key pair
    console.log('🔑 Generating API key pair...');
    
    // Generate API key using WASM signer directly (doesn't require a client)
    // The WASM signer auto-detects the path, but we can specify it explicitly
    const wasmPath = path.resolve(__dirname, 'node_modules/@reservoir0x/lighter-ts-sdk/wasm/lighter-signer.wasm');
    const wasmSigner = await createWasmSignerClient({
      wasmPath: wasmPath
    });
    
    // Generate API key pair (40-char private key)
    const apiKeyPair = await wasmSigner.generateAPIKey();
    
    if (!apiKeyPair) {
      throw new Error('Failed to generate API key pair');
    }

    const apiPrivateKey = apiKeyPair.privateKey;
    const apiPublicKey = apiKeyPair.publicKey;

    console.log(`   ✅ API key pair generated`);
    console.log(`   Private Key: ${apiPrivateKey.substring(0, 16)}... (${apiPrivateKey.length} chars)`);
    console.log(`   Public Key: ${apiPublicKey.substring(0, 16)}...`);
    console.log('');

    // Step 3: Change API key on account
    console.log('🔐 Registering API key with account...');
    
    // Now create a signer client with the Ethereum key to change the API key
    // We need to use the Ethereum key to sign the change API key transaction
    // But first, let's try using the API client directly or find another way
    
    // Actually, we need a SignerClient initialized with the Ethereum key
    // But the SDK won't accept a 64-char key. Let me check if we can use it differently
    // For now, let's try creating a client with a dummy 40-char key, generate the API key,
    // then use the Ethereum wallet to sign the change API key transaction via the API
    
    // Alternative: Use the API directly to change the key
    // But we need to sign the transaction with Ethereum key
    // This is complex - let's try a different approach
    
    // Create a temporary signer with the generated API key (we'll change it)
    const tempSignerClient = new SignerClient({
      url: BASE_URL,
      privateKey: apiPrivateKey.startsWith('0x') ? apiPrivateKey.slice(2) : apiPrivateKey,
      accountIndex: accountIndex,
      apiKeyIndex: API_KEY_INDEX
    });

    await tempSignerClient.initialize();
    await tempSignerClient.ensureWasmClient();
    
    try {
      const changeResult = await tempSignerClient.changeApiKey({
        ethSigner: wallet, // Pass the ethers wallet to sign with Ethereum key
        newPubkey: apiPublicKey,
        newApiKeyIndex: API_KEY_INDEX
      });

      if (changeResult.error) {
        throw new Error(`Failed to change API key: ${changeResult.error}`);
      }

      console.log('   ✅ API key registered successfully');
      console.log('');

      // Step 4: Wait a bit for the change to propagate
      console.log('⏳ Waiting for API key to propagate...');
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
      console.log('   ✅ Wait complete');
      console.log('');

      // Step 5: Verify the API key works
      console.log('✅ Verifying API key...');
      const verifySignerClient = new SignerClient({
        url: BASE_URL,
        privateKey: apiPrivateKey.startsWith('0x') ? apiPrivateKey.slice(2) : apiPrivateKey,
        accountIndex: accountIndex,
        apiKeyIndex: API_KEY_INDEX
      });

      await verifySignerClient.initialize();
      await verifySignerClient.ensureWasmClient();

      const checkError = await verifySignerClient.checkClient();
      if (checkError) {
        throw new Error(`API key verification failed: ${checkError}`);
      }

      console.log('   ✅ API key verified and working!');
      console.log('');

      // Step 6: Save API key to .env file
      console.log('💾 Saving API key configuration...');
      
      const envPath = path.join(process.cwd(), '.env');
      let envContent = '';

      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf-8');
      }

      // Remove old LIGHTER_API_KEY if exists
      envContent = envContent.replace(/^LIGHTER_API_KEY=.*$/m, '');
      envContent = envContent.replace(/^LIGHTER_ACCOUNT_INDEX=.*$/m, '');
      envContent = envContent.replace(/^LIGHTER_API_KEY_INDEX=.*$/m, '');

      // Add new API key configuration
      envContent += `\n# Lighter API Key Configuration (generated by lighter-setup-api-key.ts)\n`;
      envContent += `LIGHTER_API_KEY=${apiPrivateKey}\n`;
      envContent += `LIGHTER_ACCOUNT_INDEX=${accountIndex}\n`;
      envContent += `LIGHTER_API_KEY_INDEX=${API_KEY_INDEX}\n`;

      fs.writeFileSync(envPath, envContent.trim() + '\n');
      console.log(`   ✅ Configuration saved to .env`);
      console.log('');

      // Summary
      console.log('═══════════════════════════════════════════════════════════');
      console.log('🎉 API KEY SETUP COMPLETE!');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('');
      console.log('Your API key has been saved to .env:');
      console.log(`   LIGHTER_API_KEY=${apiPrivateKey.substring(0, 16)}...`);
      console.log(`   LIGHTER_ACCOUNT_INDEX=${accountIndex}`);
      console.log(`   LIGHTER_API_KEY_INDEX=${API_KEY_INDEX}`);
      console.log('');
      console.log('You can now use lighter-order-simple.ts to place orders!');
      console.log('');

      // Cleanup - check if cleanup method exists
      if (typeof verifySignerClient.cleanup === 'function') {
        await verifySignerClient.cleanup();
      }
      if (typeof tempSignerClient.cleanup === 'function') {
        await tempSignerClient.cleanup();
      }

    } catch (error: any) {
      console.log('   ❌ Failed to register API key');
      throw error;
    }

  } catch (error: any) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('❌ SETUP FAILED');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`   Error: ${error.message}`);
    console.log('');
    console.log('💡 Common issues:');
    console.log('   - Make sure your Ethereum address has funds deposited on Lighter');
    console.log('   - Verify PRIVATE_KEY is correct (64 hex chars)');
    console.log('   - Check that API_KEY_INDEX is available (not already in use)');
    console.log('   - Ensure you have network connectivity');
    throw error;
  } finally {
    await apiClient.close();
  }
}

setupApiKey().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

