import axios, { AxiosError } from 'axios';
import { ethers } from 'ethers';
import 'dotenv/config';

interface EnvConfig {
  user: string; // EOA address
  signer: string; // Signer address
  privateKey: string; // Private key (with or without 0x prefix)
  baseUrl: string;
  symbol: string;
  usdSize: number;
  recvWindow?: number;
}

type OrderSide = 'BUY' | 'SELL';
type OrderType = 'MARKET' | 'LIMIT';

const DEFAULT_BASE_URL = 'https://fapi.asterdex.com';
const ORDER_ENDPOINT = '/fapi/v3/order';

export function loadConfig(): EnvConfig {
  const user = process.env.ASTER_USER;
  const signer = process.env.ASTER_SIGNER;
  const privateKey = process.env.ASTER_PRIVATE_KEY;
  const baseUrl = process.env.ASTER_BASE_URL ?? DEFAULT_BASE_URL;
  const symbol = process.env.ASTER_SYMBOL ?? 'BNBUSDT';
  const usdSizeRaw = process.env.ASTER_POSITION_SIZE_USD;
  const recvWindowRaw = process.env.ASTER_RECV_WINDOW;

  if (!user) {
    throw new Error('Missing ASTER_USER environment variable (your EOA address)');
  }

  if (!signer) {
    throw new Error('Missing ASTER_SIGNER environment variable (signer address from API wallet)');
  }

  if (!privateKey) {
    throw new Error('Missing ASTER_PRIVATE_KEY environment variable');
  }

  if (!usdSizeRaw) {
    throw new Error('Missing ASTER_POSITION_SIZE_USD environment variable');
  }

  const usdSize = Number(usdSizeRaw);
  if (!Number.isFinite(usdSize) || usdSize <= 0) {
    throw new Error('ASTER_POSITION_SIZE_USD must be a positive number');
  }

  const recvWindow = recvWindowRaw ? Number(recvWindowRaw) : undefined;
  if (recvWindow !== undefined && (!Number.isInteger(recvWindow) || recvWindow <= 0)) {
    throw new Error('ASTER_RECV_WINDOW must be a positive integer when provided');
  }

  // Ensure private key has 0x prefix
  const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

  return {
    user,
    signer,
    privateKey: normalizedPrivateKey,
    baseUrl,
    symbol,
    usdSize,
    recvWindow,
  };
}

/**
 * Trim and convert all values in dictionary to strings (matching Python _trim_dict)
 */
function trimDict(myDict: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(myDict)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      const newValue = value.map((item) => {
        if (typeof item === 'object' && item !== null) {
          return JSON.stringify(trimDict(item));
        }
        return String(item);
      });
      result[key] = JSON.stringify(newValue);
    } else if (typeof value === 'object') {
      result[key] = JSON.stringify(trimDict(value));
    } else {
      result[key] = String(value);
    }
  }

  return result;
}

/**
 * Create Ethereum signature for Aster DEX API (matching Python sign function)
 */
export function signParams(
  params: Record<string, any>,
  user: string,
  signer: string,
  privateKey: string,
  nonce: number,
): Record<string, any> {
  // Remove null/undefined values
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined),
  );

  // Add recvWindow and timestamp
  cleanParams.recvWindow = cleanParams.recvWindow ?? 50000;
  cleanParams.timestamp = Math.floor(Date.now());

  // Trim and convert to strings
  const trimmedParams = trimDict(cleanParams);

  // Create JSON string with sorted keys (matching Python json.dumps with sort_keys=True)
  const jsonStr = JSON.stringify(trimmedParams, Object.keys(trimmedParams).sort());

  // ABI encode: encode(['string', 'address', 'address', 'uint256'], [json_str, user, signer, nonce])
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['string', 'address', 'address', 'uint256'],
    [jsonStr, user, signer, nonce],
  );

  // Keccak256 hash
  const keccakHash = ethers.keccak256(encoded);

  // Sign the hash (encode_defunct in Python creates a message hash, then signs it)
  // encode_defunct(hexstr=keccak_hex) in eth_account:
  // - Takes hex string, converts to bytes
  // - Creates: keccak256("\x19Ethereum Signed Message:\n" + len(bytes) + bytes)
  const wallet = new ethers.Wallet(privateKey);
  
  // Convert hex to bytes (this is what encode_defunct does with hexstr)
  const hashBytes = ethers.getBytes(keccakHash);
  
  // Create the message hash manually (replicating encode_defunct)
  // Format: "\x19Ethereum Signed Message:\n" + length_as_string + bytes
  const prefix = '\x19Ethereum Signed Message:\n';
  const lengthStr = hashBytes.length.toString();
  const message = ethers.concat([
    ethers.toUtf8Bytes(prefix),
    ethers.toUtf8Bytes(lengthStr),
    hashBytes,
  ]);
  
  // Hash the message (this is what encode_defunct returns)
  const messageHash = ethers.keccak256(message);
  
  // Sign the message hash (Account.sign_message in Python)
  const signature = wallet.signingKey.sign(ethers.getBytes(messageHash));

  // Serialize signature to hex (r + s + v)
  // Python: '0x' + signed_message.signature.hex()
  const signatureHex = ethers.Signature.from({
    r: signature.r,
    s: signature.s,
    v: signature.v,
  }).serialized;

  const signedParams = {
    ...cleanParams,
    nonce,
    user,
    signer,
    signature: signatureHex, // Already includes 0x prefix
  };

  return signedParams;
}

type OrderRequest = {
  symbol: string;
  positionSide?: string;
  side: OrderSide;
  type: OrderType;
  quantity?: string;  // For specifying asset amount (e.g., "0.5" = 0.5 BNB)
  quoteOrderQty?: string;  // For specifying quote currency amount (e.g., "0.5" = $0.5 USD)
  timestamp?: number;
  recvWindow?: number;
};

export async function placeMarketOrder(config: EnvConfig): Promise<void> {
  const client = axios.create({
    baseURL: config.baseUrl,
    timeout: 30000,
  });

  // First, fetch exchange info to get precision requirements
  let stepSize = 0.001; // Default to 3 decimal places
  let currentPrice: number;
  
  try {
    // Get exchange info for the symbol to find stepSize (quantity precision)
    const exchangeInfoResponse = await client.get(`/fapi/v1/exchangeInfo`);
    const symbolInfo = exchangeInfoResponse.data.symbols?.find((s: any) => s.symbol === config.symbol);
    if (symbolInfo) {
      const quantityFilter = symbolInfo.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
      if (quantityFilter?.stepSize) {
        stepSize = parseFloat(quantityFilter.stepSize);
        console.log(`Step size for ${config.symbol}: ${stepSize}`);
      }
    }
  } catch (error) {
    console.warn('Could not fetch exchange info, using default precision');
  }

  // Fetch current price
  try {
    const priceResponse = await client.get(`/fapi/v1/ticker/price?symbol=${config.symbol}`);
    currentPrice = parseFloat(priceResponse.data.price);
    console.log(`Current ${config.symbol} price: $${currentPrice}`);
  } catch (error) {
    console.warn('Could not fetch current price, using estimated quantity');
    currentPrice = 500;
  }

  // Calculate quantity from USD value and round to stepSize precision
  // quantity = usdSize / currentPrice
  const rawQuantity = config.usdSize / currentPrice;
  // Round to stepSize precision
  const precision = stepSize.toString().split('.')[1]?.length || 3;
  const quantity = rawQuantity.toFixed(precision);
  
  // Check minimum quantity
  const minQuantity = stepSize; // stepSize is already a number
  const quantityNum = parseFloat(quantity);
  if (quantityNum < minQuantity) {
    const minUsd = minQuantity * currentPrice;
    throw new Error(
      `Order size too small! Minimum order is ${minQuantity} ${config.symbol.replace('USDT', '')} ($${minUsd.toFixed(2)} USD). ` +
      `You requested $${config.usdSize} USD which equals ${rawQuantity.toFixed(6)} ${config.symbol.replace('USDT', '')}. ` +
      `Please increase ASTER_POSITION_SIZE_USD to at least ${minUsd.toFixed(2)}.`
    );
  }
  
  console.log(`Calculated quantity: ${quantity} ${config.symbol.replace('USDT', '')} for $${config.usdSize} USD`);

  // Generate nonce (microseconds timestamp)
  const nonce = Math.floor(Date.now() * 1000);

  const orderParams: OrderRequest = {
    symbol: config.symbol,
    positionSide: 'BOTH', // Required parameter (from Python example)
    side: 'BUY',
    type: 'MARKET',
    quantity: quantity, // Calculated quantity in base asset
    recvWindow: config.recvWindow ?? 50000,
  };

  // Sign the parameters
  const signedParams = signParams(
    orderParams,
    config.user,
    config.signer,
    config.privateKey,
    nonce,
  );

  const url = ORDER_ENDPOINT;
  const fullUrl = `${config.baseUrl}${url}`;

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'TypeScriptApp/1.0',
  };

  // Debug logging
  console.log('\n🔍 Debug Information:');
  console.log('Base URL:', config.baseUrl);
  console.log('Endpoint:', ORDER_ENDPOINT);
  console.log('Full URL:', fullUrl);
  console.log('User (EOA):', config.user);
  console.log('Signer:', config.signer);
  console.log('Nonce:', nonce);
  console.log('Order Params:', JSON.stringify(orderParams, null, 2));
  console.log('Signed Params (without private key):', JSON.stringify({ ...signedParams, signature: signedParams.signature.substring(0, 10) + '...' }, null, 2));
  console.log('');

  try {
    // Use form data (application/x-www-form-urlencoded)
    // Match Python: requests.post(url, data=my_dict, headers=headers)
    const formData = new URLSearchParams();
    for (const [key, value] of Object.entries(signedParams)) {
      if (value !== null && value !== undefined) {
        formData.append(key, String(value));
      }
    }

    console.log('Form Data:', formData.toString());
    console.log('');

    const response = await client.post(url, formData.toString(), { headers });
    console.log('✅ Order submitted successfully');
    console.log('Response Status:', response.status);
    console.log('Response Data:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('\n❌ Request failed with details:');
    if (axios.isAxiosError(error)) {
      console.error('Status:', error.response?.status);
      console.error('Status Text:', error.response?.statusText);
      console.error('Response Headers:', JSON.stringify(error.response?.headers, null, 2));
      console.error('Response Data:', JSON.stringify(error.response?.data, null, 2));
      console.error('Request URL:', error.config?.url);
      console.error('Request Method:', error.config?.method);
      console.error('Request Headers:', JSON.stringify(error.config?.headers, null, 2));
    }
    throw error;
  }
}

export function describeAxiosError(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  const axiosError = error as AxiosError<{ code?: string; msg?: string } | string>;
  const status = axiosError.response?.status;
  const statusText = axiosError.response?.statusText;

  if (typeof axiosError.response?.data === 'string') {
    return `HTTP ${status} ${statusText}: ${axiosError.response.data}`;
  }

  if (axiosError.response?.data && typeof axiosError.response.data === 'object') {
    const payload = axiosError.response.data;
    const code = (payload as { code?: string }).code;
    const message = (payload as { msg?: string }).msg;
    return `HTTP ${status} ${statusText}: ${code ?? 'UNKNOWN_CODE'} - ${message ?? 'No message'}`;
  }

  if (axiosError.request && !axiosError.response) {
    return 'No response received from Aster DEX (network or timeout issue)';
  }

  return axiosError.message;
}

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    console.log(`Placing MARKET BUY on ${config.symbol} for ${config.usdSize} USD...`);
    await placeMarketOrder(config);
  } catch (error) {
    console.error('❌ Failed to place order');
    console.error(describeAxiosError(error));
    process.exitCode = 1;
  }
}

void main();
