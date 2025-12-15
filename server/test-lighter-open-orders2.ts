import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { SignerClient } from '@reservoir0x/lighter-ts-sdk';

const LIGHTER_API_BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_API_KEY = process.env.LIGHTER_API_KEY || '';
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '623336');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || '1');

async function main() {
  let normalizedKey = LIGHTER_API_KEY;
  if (normalizedKey.startsWith('0x')) normalizedKey = normalizedKey.slice(2);

  const signerClient = new SignerClient({
    url: LIGHTER_API_BASE_URL,
    privateKey: normalizedKey,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX,
  });
  await signerClient.initialize();
  await signerClient.ensureWasmClient();

  const authToken = await signerClient.createAuthTokenWithExpiry(600);

  // Try different endpoint variations
  const endpoints = [
    { url: '/api/v1/accountActiveOrders', params: { auth: authToken, market_id: 70 } },
    { url: '/api/v1/accountActiveOrders', params: { auth: authToken, market_id: 70, account_index: ACCOUNT_INDEX } },
    { url: '/api/v1/accountOrders', params: { auth: authToken, market_id: 70 } },
    { url: '/api/v1/orders', params: { auth: authToken, market_id: 70, account_index: ACCOUNT_INDEX } },
    { url: '/api/v1/openOrders', params: { auth: authToken, market_id: 70 } },
  ];

  for (const ep of endpoints) {
    try {
      console.log(`\nTrying: ${ep.url}`);
      console.log(`  Params: ${JSON.stringify(ep.params)}`);
      const response = await axios.get(`${LIGHTER_API_BASE_URL}${ep.url}`, {
        params: ep.params,
        timeout: 10000,
      });
      console.log(`  Status: ${response.status}`);
      console.log(`  Response: ${JSON.stringify(response.data).substring(0, 500)}`);
    } catch (e: any) {
      console.log(`  Error: ${e.response?.status} - ${JSON.stringify(e.response?.data || e.message).substring(0, 200)}`);
    }
  }
}

main().catch(console.error);
