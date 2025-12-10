import { SignerClient } from '@reservoir0x/lighter-ts-sdk';
import { ethers } from 'ethers';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from server directory first, then parent
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const LIGHTER_API_BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_API_KEY = process.env.LIGHTER_API_KEY;
const LIGHTER_PRIVATE_KEY = process.env.LIGHTER_PRIVATE_KEY || process.env.PRIVATE_KEY; // For EIP712 signing
const LIGHTER_ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const LIGHTER_API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '2');
const CHAIN_ID = 304; // Arbitrum One (0x130)

const ASSET_INDEX_USDC = 3;

async function createAuthTokenWithExpiry(signerClient: SignerClient): Promise<string> {
  // Use SignerClient's create_auth_token_with_expiry method
  if ((signerClient as any).create_auth_token_with_expiry) {
    const token = await (signerClient as any).create_auth_token_with_expiry();
    return `Bearer ${token}`;
  } else if ((signerClient as any).createAuthTokenWithExpiry) {
    const token = await (signerClient as any).createAuthTokenWithExpiry();
    return `Bearer ${token}`;
  } else {
    throw new Error('SignerClient does not have create_auth_token_with_expiry method');
  }
}

async function getNextNonce(accountIndex: number, apiKeyIndex: number): Promise<{ apiKeyIndex: number; nonce: number }> {
  const url = `${LIGHTER_API_BASE_URL}/api/v1/nextNonce`;
  const response = await axios.get(url, {
    params: { account_index: accountIndex, api_key_index: apiKeyIndex },
    timeout: 10000,
  });
  
  // The API might return both api_key_index and nonce (like Python SDK's nonce_manager.next_nonce())
  if (response.data && typeof response.data === 'object') {
    if (response.data.nonce !== undefined && response.data.api_key_index !== undefined) {
      return {
        apiKeyIndex: response.data.api_key_index,
        nonce: response.data.nonce,
      };
    } else if (response.data.nonce !== undefined) {
      return {
        apiKeyIndex: apiKeyIndex, // Use provided one if API doesn't return it
        nonce: response.data.nonce,
      };
    }
  } else if (typeof response.data === 'number') {
    return {
      apiKeyIndex: apiKeyIndex,
      nonce: response.data,
    };
  }
  
  throw new Error(`Unexpected nonce format: ${JSON.stringify(response.data)}`);
}

function memoToHexArray(address: string): number[] {
  const cleanAddress = address.startsWith('0x') 
    ? address.slice(2).toLowerCase() 
    : address.toLowerCase();
  if (cleanAddress.length !== 40) {
    throw new Error(`Invalid address length: ${cleanAddress.length}`);
  }
  const addressBytes = Buffer.from(cleanAddress, 'hex');
  const memo = Buffer.alloc(32, 0);
  addressBytes.copy(memo, 0);
  return Array.from(memo);
}

async function createWithdrawalSignature(params: {
  fromAccountIndex: number;
  apiKeyIndex: number;
  toAccountIndex: number;
  assetIndex: number;
  fromRouteType: number;
  toRouteType: number;
  amount: bigint;
  usdcFee: bigint;
  memo: number[];
  expiredAt: number;
  nonce: number;
}): Promise<{ sig: string; l1Sig: string }> {
  // Use PRIVATE_KEY for EIP712 signing (not SignerClient)
  const privateKey = LIGHTER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY or LIGHTER_PRIVATE_KEY is required for EIP712 signing');
  }
  
  // Normalize private key
  const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(normalizedPrivateKey);
  
  const domain = {
    name: 'Transfer',
    version: '1',
    chainId: CHAIN_ID,
  };
  
  const types = {
    Transfer: [
      { name: 'nonce', type: 'uint256' },
      { name: 'from', type: 'uint256' },
      { name: 'api key', type: 'uint256' },
      { name: 'to', type: 'uint256' },
      { name: 'asset', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
      { name: 'chainId', type: 'uint256' },
      { name: 'memo', type: 'bytes32' },
    ],
  };
  
  const memoBuffer = Buffer.from(params.memo);
  const memoHex = '0x' + memoBuffer.toString('hex');
  
  const toHex = (value: number | bigint): string => {
    const hex = typeof value === 'bigint' 
      ? value.toString(16) 
      : value.toString(16);
    return hex.padStart(64, '0');
  };
  
  const value = {
    nonce: `0x${toHex(params.nonce)}`,
    from: `0x${toHex(params.fromAccountIndex)}`,
    'api key': `0x${toHex(params.apiKeyIndex)}`,
    to: `0x${toHex(params.toAccountIndex)}`,
    asset: `0x${toHex(params.assetIndex)}`,
    amount: `0x${toHex(params.amount)}`,
    fee: `0x${toHex(params.usdcFee)}`,
    chainId: `0x${toHex(CHAIN_ID)}`,
    memo: memoHex,
  };
  
  console.log('EIP712 Value:', JSON.stringify(value, null, 2));
  
  // Sign EIP712 typed data using ethers.js Wallet
  const sigHex = await wallet.signTypedData(domain, types, value);
  
  // Convert hex signature to base64 (remove 0x, convert hex to bytes, then to base64)
  // ethers.js returns hex with 0x prefix, we need base64 without prefix
  const sigBytes = Buffer.from(sigHex.slice(2), 'hex');
  const sig = sigBytes.toString('base64');
  
  // L1 signature - sign the formatted message string
  const memoHexForL1 = memoHex.startsWith('0x') ? memoHex.slice(2) : memoHex;
  const l1Message = `Transfer\nnonce: ${value.nonce}\nfrom: ${value.from} (route 0x${toHex(params.fromRouteType)})\napi key: ${value['api key']}\nto: ${value.to} (route 0x${toHex(params.toRouteType)})\nasset: ${value.asset}\namount: ${value.amount}\nfee: ${value.fee}\nchainId: ${value.chainId}\nmemo: ${memoHexForL1}\n\nOnly sign this message for a trusted client!`;
  
  console.log('\nL1 Message:');
  console.log(l1Message);
  console.log('');
  
  // Sign L1 message using ethers.js Wallet (keep as hex with 0x for L1Sig)
  const l1Sig = await wallet.signMessage(l1Message);
  
  return { sig, l1Sig };
}

async function executeWithdrawal(
  signerClient: SignerClient,
  params: {
    fromAccountIndex: number;
    apiKeyIndex: number;
    toAccountIndex: number;
    assetIndex: number;
    fromRouteType: number;
    toRouteType: number;
    amount: bigint;
    usdcFee: bigint;
    memo: number[];
    expiredAt: number;
    nonce: number;
    sig: string;
    l1Sig: string;
    toAddress?: string;
  }
): Promise<any> {
  const authToken = await createAuthTokenWithExpiry(signerClient);
  
  // tx_info contains the full withdrawal payload
  const txInfo: any = {
    FromAccountIndex: params.fromAccountIndex,
    ApiKeyIndex: params.apiKeyIndex,
    ToAccountIndex: params.toAccountIndex,
    AssetIndex: params.assetIndex,
    FromRouteType: params.fromRouteType,
    ToRouteType: params.toRouteType,
    Amount: params.amount.toString(),
    USDCFee: params.usdcFee.toString(),
    Memo: params.memo,
    ExpiredAt: params.expiredAt,
    Nonce: params.nonce,
    Sig: params.sig,
    L1Sig: params.l1Sig,
  };
  
  // Send as application/x-www-form-urlencoded (matching Python example)
  const formData = new URLSearchParams();
  formData.append('tx_info', JSON.stringify(txInfo));
  formData.append('to_address', params.toAddress || '');
  
  console.log('\n📤 Withdrawal Payload (url-encoded):');
  console.log('tx_info:', JSON.stringify(txInfo, null, 2));
  console.log('to_address:', params.toAddress);
  console.log('');
  
  const response = await axios.post(
    `${LIGHTER_API_BASE_URL}/api/v1/fastwithdraw`,
    formData.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': authToken,
      },
      timeout: 30000,
    }
  );
  
  return response.data;
}

async function main() {
  console.log('🚀 Testing Lighter Withdrawal with EIP712 Signature\n');
  
  if (!LIGHTER_API_KEY) {
    throw new Error('LIGHTER_API_KEY environment variable is required');
  }
  
  // Initialize SignerClient
  const normalizedKey = LIGHTER_API_KEY.startsWith('0x') 
    ? LIGHTER_API_KEY.slice(2) 
    : LIGHTER_API_KEY;
  
  console.log('🔧 Initializing SignerClient...');
  const signerClient = new SignerClient({
    url: LIGHTER_API_BASE_URL,
    privateKey: normalizedKey,
    accountIndex: LIGHTER_ACCOUNT_INDEX,
    apiKeyIndex: LIGHTER_API_KEY_INDEX,
  });
  
  await signerClient.initialize();
  await signerClient.ensureWasmClient();
  console.log('✅ SignerClient initialized\n');
  
  const toAddress = '0xa90714a15D6e5C0EB3096462De8dc4B22E01589A';
  const amount = 7.0;
  const usdcFee = 3.0;
  const amountWei = BigInt(Math.floor(amount * 1e6));
  const feeWei = BigInt(Math.floor(usdcFee * 1e6));
  const toAccountIndex = 3;
  const fromRouteType = 0;
  const toRouteType = 0;
  const expiredAt = Date.now() + 3600000;
  const memo = memoToHexArray(toAddress);
  
  console.log('Memo:', memo);
  console.log('Memo hex:', '0x' + Buffer.from(memo).toString('hex'));
  console.log('');
  
  try {
    console.log(`📝 Getting next nonce for account ${LIGHTER_ACCOUNT_INDEX}, API key ${LIGHTER_API_KEY_INDEX}...`);
    const { apiKeyIndex: actualApiKeyIndex, nonce } = await getNextNonce(LIGHTER_ACCOUNT_INDEX, LIGHTER_API_KEY_INDEX);
    console.log(`✅ Next nonce: ${nonce}, API Key Index: ${actualApiKeyIndex}\n`);
    
    console.log('🔐 Creating EIP712 signature...');
    console.log(`   From: ${LIGHTER_ACCOUNT_INDEX}, To: ${toAccountIndex}, Address: ${toAddress}`);
    console.log(`   Amount: ${amount} USDC, Fee: ${usdcFee} USDC, Nonce: ${nonce}, API Key: ${actualApiKeyIndex}\n`);
    
    const { sig, l1Sig } = await createWithdrawalSignature({
      fromAccountIndex: LIGHTER_ACCOUNT_INDEX,
      apiKeyIndex: actualApiKeyIndex, // Use the API key index returned by the nonce endpoint
      toAccountIndex,
      assetIndex: ASSET_INDEX_USDC,
      fromRouteType,
      toRouteType,
      amount: amountWei,
      usdcFee: feeWei,
      memo,
      expiredAt,
      nonce,
    });
    
    console.log(`✅ Signatures created`);
    console.log(`   Sig: ${sig.substring(0, 66)}...`);
    console.log(`   L1Sig: ${l1Sig.substring(0, 66)}...\n`);
    
    console.log('📤 Executing withdrawal...');
    const result = await executeWithdrawal(signerClient, {
      fromAccountIndex: LIGHTER_ACCOUNT_INDEX,
      apiKeyIndex: actualApiKeyIndex, // Use the API key index returned by the nonce endpoint
      toAccountIndex,
      assetIndex: ASSET_INDEX_USDC,
      fromRouteType,
      toRouteType,
      amount: amountWei,
      usdcFee: feeWei,
      memo,
      expiredAt,
      nonce,
      sig,
      l1Sig,
      toAddress,
    });
    
    console.log('✅ Withdrawal successful!');
    console.log('Response:', JSON.stringify(result, null, 2));
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
