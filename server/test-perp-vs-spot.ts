import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Test if PERP orders work - if they do, the issue is spot-specific
 */
async function main() {
  const privateKey = process.env.PRIVATE_KEY!;
  const walletAddress = '0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03';
  
  const sdk = new Hyperliquid({ 
    privateKey, 
    walletAddress,
    testnet: false,
    enableWs: false 
  });
  
  // Try placing a tiny PERP order (will likely fail due to no margin, but let's see the error)
  console.log('\nTrying PERP order...');
  try {
    const result = await sdk.exchange.placeOrder({
      coin: 'ETH-PERP',
      is_buy: false, // Short
      sz: 0.001, // Tiny size
      limit_px: 5000, // Way above market
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    });
    console.log('PERP Result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('PERP Error:', e.message);
  }
  
  // Now try spot again but check what the SDK is actually doing
  console.log('\n=== SPOT ORDER DEBUG ===');
  const spotState = await sdk.info.spot.getSpotClearinghouseState(walletAddress);
  const hype = spotState.balances.find((b: any) => b.coin === 'HYPE-SPOT');
  console.log(`HYPE balance: ${hype.total} (token: ${hype.token})`);
  
  // The error says asset=10107, which is pair index 107 + 10000
  // But balance is token 150
  // Maybe we need to check balance differently?
  console.log('\nTrying spot order one more time...');
  const spotResult = await sdk.exchange.placeOrder({
    coin: 'HYPE-SPOT',
    is_buy: false,
    sz: 0.01,
    limit_px: 30,
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: false,
  });
  console.log('Spot Result:', JSON.stringify(spotResult, null, 2));
}

main().catch(console.error);

