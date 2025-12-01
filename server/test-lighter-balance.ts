import dotenv from 'dotenv';
import { SignerClient, ApiClient, AccountApi } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';

dotenv.config();

async function testLighterBalance() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         TEST LIGHTER BALANCE QUERY                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const baseUrl = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
  const apiKey = process.env.LIGHTER_API_KEY;
  const accountIndex = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '1000');
  const apiKeyIndex = parseInt(process.env.LIGHTER_API_KEY_INDEX || '1');

  if (!apiKey) {
    console.error('❌ ERROR: LIGHTER_API_KEY not found in .env file');
    process.exit(1);
  }

  console.log(`📡 Configuration:`);
  console.log(`   Base URL: ${baseUrl}`);
  console.log(`   Account Index: ${accountIndex}`);
  console.log(`   API Key Index: ${apiKeyIndex}`);
  console.log(`   API Key: ${apiKey.substring(0, 8)}... (${apiKey.length} chars)\n`);

  // Normalize API key
  let normalizedKey = apiKey;
  if (normalizedKey.startsWith('0x')) {
    normalizedKey = normalizedKey.slice(2);
  }

  try {
    // Initialize SignerClient
    console.log('🔐 Initializing SignerClient...');
    const signerClient = new SignerClient({
      url: baseUrl,
      privateKey: normalizedKey,
      accountIndex: accountIndex,
      apiKeyIndex: apiKeyIndex,
    });

    await signerClient.initialize();
    await signerClient.ensureWasmClient();
    console.log('✅ SignerClient initialized\n');

    // Try to get account via SignerClient
    console.log('💰 Method 1: Getting balance via SignerClient...');
    try {
      const accountInfo = await (signerClient as any).getAccount?.();
      if (accountInfo?.balance) {
        console.log(`   ✅ Balance: ${accountInfo.balance}`);
        console.log(`   ✅ Address: ${accountInfo.address || 'N/A'}`);
        await signerClient.cleanup();
        return;
      }
    } catch (e: any) {
      console.log(`   ⚠️  SignerClient method failed: ${e.message}`);
    }

    // Try ApiClient
    console.log('\n💰 Method 2: Getting balance via ApiClient...');
    const apiClient = new ApiClient({ host: baseUrl });
    
    // Try apiClient.account.getAccount()
    if ((apiClient as any).account) {
      try {
        const account = await (apiClient as any).account.getAccount();
        console.log(`   ✅ Balance: ${account.balance || 'N/A'}`);
        console.log(`   ✅ Address: ${account.address || 'N/A'}`);
        await signerClient.cleanup();
        return;
      } catch (e: any) {
        console.log(`   ⚠️  apiClient.account.getAccount() failed: ${e.message}`);
      }
    }

    // Try AccountApi class with proper 'by' parameter structure
    // Based on docs: { by: 'index' | 'l1_address', value: string }
    console.log('\n💰 Method 3: Getting balance via AccountApi...');
    try {
      const accountApi = new AccountApi(apiClient);
      // Try with accountIndex using correct format: { by: 'index', value: '571536' }
      console.log(`   Trying with by='index', value='${accountIndex}'`);
      const account = await (accountApi.getAccount as any)({ 
        by: 'index', 
        value: String(accountIndex) 
      });
      console.log(`   ✅ Balance: ${account.balance || 'N/A'}`);
      console.log(`   ✅ Address: ${account.address || 'N/A'}`);
      console.log(`   ✅ Full response:`, JSON.stringify(account, null, 2));
      if (signerClient && typeof signerClient.cleanup === 'function') {
        await signerClient.cleanup();
      }
      return;
    } catch (e: any) {
      console.log(`   ⚠️  AccountApi.getAccount() with index failed: ${e.message}`);
      console.log(`   ⚠️  Error details: ${e.stack?.split('\n')[0] || 'No stack trace'}`);
    }

    // Method 4: Direct REST API call to /api/v1/account endpoint
    // Based on official docs: https://apidocs.lighter.xyz/reference/account-1
    console.log('\n💰 Method 4: Getting balance via direct REST API call...');
    try {
      const response = await axios.get(`${baseUrl}/api/v1/account`, {
        params: {
          by: 'index',
          value: String(accountIndex),
        },
        headers: {
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        timeout: 10000,
      });

      console.log(`   ✅ Status Code: ${response.status}`);
      console.log(`   ✅ Response:`, JSON.stringify(response.data, null, 2));
      
      if (response.data) {
        const collateral = response.data.collateral || response.data.balance || '0';
        console.log(`   ✅ Collateral: ${collateral}`);
        console.log(`   ✅ Status: ${response.data.status || 'N/A'} (1=active, 0=inactive)`);
        if (response.data.positions) {
          console.log(`   ✅ Positions: ${JSON.stringify(response.data.positions, null, 2)}`);
        }
      }

      if (signerClient && typeof signerClient.cleanup === 'function') {
        await signerClient.cleanup();
      }
      return;
    } catch (e: any) {
      console.log(`   ⚠️  Direct REST API call failed: ${e.message}`);
      if (e.response) {
        console.log(`   ⚠️  Status: ${e.response.status}`);
        console.log(`   ⚠️  Response: ${JSON.stringify(e.response.data, null, 2)}`);
      }
    }

    console.log('\n❌ All methods failed to retrieve balance');
    console.log('   This may indicate:');
    console.log('   - API key is invalid');
    console.log('   - Account index is incorrect');
    console.log('   - Lighter API structure has changed');
    console.log('   - Network/connection issues');

  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testLighterBalance().catch(console.error);

