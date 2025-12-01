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
  
  // Get balance
  const spotState = await sdk.info.spot.getSpotClearinghouseState(walletAddress);
  const hype = spotState.balances.find((b: any) => b.coin === 'HYPE-SPOT');
  const available = parseFloat(hype.total) - parseFloat(hype.hold);
  
  console.log(`Available HYPE: ${available}`);
  
  // Try selling the EXACT available amount
  // HYPE has szDecimals: 2, so round to 2 decimals
  const sellSize = Math.floor(available * 100) / 100; // Round down to 2 decimals
  const sellPrice = 30; // Below market
  
  console.log(`\nTrying to sell EXACT amount: ${sellSize} HYPE @ $${sellPrice}`);
  
  const result = await sdk.exchange.placeOrder({
    coin: 'HYPE-SPOT',
    is_buy: false,
    sz: sellSize,
    limit_px: sellPrice,
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: false,
  });
  
  console.log('\nResult:', JSON.stringify(result, null, 2));
}

main().catch(console.error);





