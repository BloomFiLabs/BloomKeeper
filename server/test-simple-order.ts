import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const privateKey = process.env.PRIVATE_KEY!;
  const walletAddress = '0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03';
  
  // Try both networks to see which one works
  for (const isTestnet of [false, true]) {
    console.log(`\n=== Trying ${isTestnet ? 'TESTNET' : 'MAINNET'} ===`);
    
    try {
      const sdk = new Hyperliquid({ 
        privateKey, 
        walletAddress,
        testnet: isTestnet, 
        enableWs: false 
      });
      
      // Get spot meta to find HYPE
      const spotMeta = await sdk.info.spot.getSpotMeta();
      const hypePair = spotMeta.universe.find((p: any) => 
        p.tokens && (p.tokens[0] === 150 || p.tokens[1] === 150)
      );
      
      if (hypePair) {
        console.log('Found HYPE pair:', hypePair);
        console.log(`Pair name: ${hypePair.name}`);
        console.log(`Pair index: ${hypePair.index}`);
        
        // Try to place a tiny order
        console.log('\nTrying to place order...');
        const result = await sdk.exchange.placeOrder({
          coin: hypePair.name, // Use the exact name from meta
          is_buy: false,
          sz: 0.01, // Tiny amount
          limit_px: 30, // Below market
          order_type: { limit: { tif: 'Ioc' } },
          reduce_only: false,
        });
        
        console.log('Order result:', JSON.stringify(result, null, 2));
        break; // Found working network
      }
    } catch (e: any) {
      console.log(`Failed: ${e.message}`);
    }
  }
}

main().catch(console.error);





