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
  
  // Get full spot meta
  const spotMeta = await sdk.info.spot.getSpotMeta();
  console.log('Full spot meta:');
  console.log(JSON.stringify(spotMeta, null, 2));
  
  // Get exchange info which might have szDecimals
  const exchangeInfo = await sdk.info.meta();
  console.log('\nExchange info:');
  console.log(JSON.stringify(exchangeInfo, null, 2));
  
  // Try different size formats
  const sizes = [
    0.01,
    '0.01',
    0.1,
    '0.1',
    0.73,
    '0.73',
  ];
  
  for (const sz of sizes) {
    console.log(`\n=== Trying size: ${sz} (type: ${typeof sz}) ===`);
    try {
      const result = await sdk.exchange.placeOrder({
        coin: 'HYPE-SPOT',
        is_buy: false,
        sz: sz as any,
        limit_px: 30,
        order_type: { limit: { tif: 'Ioc' } },
        reduce_only: false,
      });
      console.log('Result:', JSON.stringify(result, null, 2));
      if (result.response?.data?.statuses?.[0]?.filled) {
        console.log('✅ SUCCESS!');
        break;
      }
    } catch (e: any) {
      console.log('Error:', e.message);
    }
  }
}

main().catch(console.error);





