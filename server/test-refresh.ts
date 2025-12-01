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
  
  // Force refresh asset maps
  console.log('Refreshing asset maps...');
  await sdk.refreshAssetMapsNow();
  console.log('Done refreshing');
  
  // Check maps after refresh
  // @ts-ignore
  const sc = sdk.symbolConversion;
  if (sc) {
    console.log('\nAfter refresh:');
    console.log('HYPE-SPOT ->', sc.exchangeToInternalNameMap?.['HYPE-SPOT']);
    console.log('HYPE ->', sc.exchangeToInternalNameMap?.['HYPE']);
  }
  
  // Get balance using the same method the SDK might use
  const spotState = await sdk.info.spot.getSpotClearinghouseState(walletAddress);
  console.log('\nSpot balances:');
  spotState.balances.forEach((b: any) => {
    console.log(`  ${b.coin} (token ${b.token}): ${b.total} (hold: ${b.hold})`);
  });
  
  // Try placing order with refreshed maps
  console.log('\nPlacing order with 0.01 HYPE...');
  const result = await sdk.exchange.placeOrder({
    coin: 'HYPE-SPOT',
    is_buy: false,
    sz: 0.01,
    limit_px: 30,
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: false,
  });
  
  console.log('\nResult:', JSON.stringify(result, null, 2));
}

main().catch(console.error);




