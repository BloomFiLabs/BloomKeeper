import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const privateKey = process.env.PRIVATE_KEY!;
  const walletAddress = '0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03';
  
  const sdk = new Hyperliquid({ 
    privateKey, 
    walletAddress,
    testnet: false, 
    enableWs: false 
  });
  
  // Get balance first
  const spotState = await sdk.info.spot.getSpotClearinghouseState(walletAddress);
  const hype = spotState.balances.find((b: any) => b.coin === 'HYPE-SPOT');
  const available = parseFloat(hype.total) - parseFloat(hype.hold);
  console.log(`Available: ${available} HYPE`);
  
  // Try using the asset INDEX instead of name
  console.log('\n=== Test 1: Using coin name ===');
  try {
    const r1 = await sdk.exchange.placeOrder({
      coin: 'HYPE-SPOT',
      is_buy: false,
      sz: 0.01,
      limit_px: 30,
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    });
    console.log('Result:', JSON.stringify(r1, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message);
  }
  
  // Try using just 'HYPE' without -SPOT
  console.log('\n=== Test 2: Using just HYPE ===');
  try {
    const r2 = await sdk.exchange.placeOrder({
      coin: 'HYPE',
      is_buy: false,
      sz: 0.01,
      limit_px: 30,
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    });
    console.log('Result:', JSON.stringify(r2, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message);
  }
  
  // Check what the SDK's internal mapping thinks
  // @ts-ignore
  const sc = sdk.symbolConversion;
  if (sc) {
    console.log('\n=== SDK Internal Maps ===');
    console.log('HYPE-SPOT ->', sc.exchangeToInternalNameMap['HYPE-SPOT']);
    console.log('HYPE ->', sc.exchangeToInternalNameMap['HYPE']);
    console.log('Asset 10107 ->', sc.indexToAssetMap?.['10107']);
    console.log('Asset 150 ->', sc.indexToAssetMap?.['150']);
  }
}

main().catch(console.error);





