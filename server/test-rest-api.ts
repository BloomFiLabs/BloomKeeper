import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

// HyperLiquid API endpoint
const API_URL = 'https://api.hyperliquid.xyz';

async function main() {
  const privateKey = process.env.PRIVATE_KEY!;
  const wallet = new ethers.Wallet(privateKey);
  const walletAddress = wallet.address;
  
  console.log('Wallet:', walletAddress);
  
  // Get user state to see balance
  const userStateRes = await fetch(`${API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'clearinghouseState',
      user: walletAddress,
    }),
  });
  const userState = await userStateRes.json();
  console.log('\nUser state:', JSON.stringify(userState, null, 2));
  
  // Get spot meta
  const metaRes = await fetch(`${API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'spotMeta',
    }),
  });
  const meta = await metaRes.json();
  const hypePair = meta.universe.find((p: any) => p.name === 'HYPE-SPOT');
  console.log('\nHYPE-SPOT pair:', JSON.stringify(hypePair, null, 2));
  
  // Try to place order via REST API
  // Need to sign the action
  const action = {
    type: 'order',
    orders: [{
      a: 10107, // HYPE-SPOT pair index
      b: false, // is_buy = false (sell)
      p: '30.0', // price
      s: '1000000', // size in wire format (0.01 * 10^8 = 1000000)
      r: false, // reduce_only
      t: { limit: { tif: 'Ioc' } }, // order_type
    }],
    grouping: 'na',
  };
  
  console.log('\nAction:', JSON.stringify(action, null, 2));
  
  // Sign action
  const message = JSON.stringify(action);
  const signature = await wallet.signMessage(ethers.getBytes(ethers.toUtf8Bytes(message)));
  
  const orderRes = await fetch(`${API_URL}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      nonce: Date.now(),
      signature: {
        r: signature.slice(0, 66),
        s: '0x' + signature.slice(66, 130),
        v: parseInt(signature.slice(130, 132), 16),
      },
      vaultAddress: null,
    }),
  });
  
  const orderResult = await orderRes.json();
  console.log('\nOrder result:', JSON.stringify(orderResult, null, 2));
}

main().catch(console.error);




