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
  
  // Check USDC balance
  const spotState = await sdk.info.spot.getSpotClearinghouseState(walletAddress);
  const usdc = spotState.balances.find((b: any) => b.coin === 'USDC-SPOT');
  console.log('USDC balance:', usdc);
  
  // Try BUYING HYPE with USDC (if we have USDC)
  if (usdc && parseFloat(usdc.total) > 0) {
    console.log('\nTrying to BUY HYPE with USDC...');
    const result = await sdk.exchange.placeOrder({
      coin: 'HYPE-SPOT',
      is_buy: true,
      sz: 0.01, // Buy 0.01 HYPE
      limit_px: 30, // At $30
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    });
    console.log('Result:', JSON.stringify(result, null, 2));
  } else {
    console.log('No USDC balance, trying SELL again with exact format...');
    
    // Get exact HYPE balance
    const hype = spotState.balances.find((b: any) => b.coin === 'HYPE-SPOT');
    const available = parseFloat(hype.total) - parseFloat(hype.hold);
    
    // Try with the exact available amount, rounded to 2 decimals (HYPE szDecimals is likely 2)
    const sellSize = Math.floor(available * 100) / 100;
    console.log(`Selling exactly ${sellSize} HYPE...`);
    
    const result = await sdk.exchange.placeOrder({
      coin: 'HYPE-SPOT',
      is_buy: false,
      sz: sellSize.toString(), // Try as string
      limit_px: '30.0', // Try as string
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    });
    console.log('Result:', JSON.stringify(result, null, 2));
  }
}

main().catch(console.error);





