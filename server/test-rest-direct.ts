import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Try REST API directly with EIP-712 signing
 * This bypasses the SDK entirely
 */
async function main() {
  const privateKey = process.env.PRIVATE_KEY!;
  const wallet = new ethers.Wallet(privateKey);
  const walletAddress = wallet.address;
  
  const API_URL = 'https://api.hyperliquid.xyz';
  
  // Get action hash for signing
  const action = {
    type: 'order',
    orders: [{
      a: 10107, // HYPE-SPOT pair index
      b: false, // is_buy = false (sell)
      p: '30.0', // price as string
      s: '1000000', // size in wire format: 0.01 * 10^8 = 1000000
      r: false, // reduce_only
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  };
  
  console.log('Action:', JSON.stringify(action, null, 2));
  
  // HyperLiquid uses EIP-712 signing
  // The domain and types are specific to HyperLiquid
  const domain = {
    name: 'Hyperliquid',
    version: '1',
    chainId: 1337, // HyperLiquid mainnet chain ID (check this!)
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
  
  const types = {
    Order: [
      { name: 'a', type: 'uint64' },
      { name: 'b', type: 'bool' },
      { name: 'p', type: 'string' },
      { name: 's', type: 'string' },
      { name: 'r', type: 'bool' },
      { name: 't', type: 'Limit' },
    ],
    Limit: [
      { name: 'tif', type: 'string' },
    ],
  };
  
  // Actually, HyperLiquid might use a different signing format
  // Let me check the SDK to see how it signs, or try a simpler approach
  
  // For now, let's just try to see what the API expects
  // by checking the SDK's network requests or documentation
  
  console.log('\nNote: HyperLiquid uses EIP-712 signing which is complex.');
  console.log('The SDK handles this automatically. The issue might be elsewhere.');
  console.log('\nCurrent hypothesis: SDK bug where it checks balance for pair (10107)');
  console.log('instead of base token (150). This might require an SDK update or workaround.');
}

main().catch(console.error);




