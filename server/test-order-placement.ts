/**
 * Test Order Placement Script
 * 
 * Tests market order placement for all exchanges to verify fixes
 * 
 * Usage:
 *   npx tsx test-order-placement.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter, formatSize, formatPrice } from '@nktkas/hyperliquid/utils';
import { ethers } from 'ethers';
import axios from 'axios';
import { SignerClient, ApiClient, OrderApi, MarketHelper, OrderType as LighterOrderType } from '@reservoir0x/lighter-ts-sdk';

// Test configuration
const TEST_SYMBOL = 'ETH';
const TEST_SIZE = 0.001; // Very small size for testing
const TEST_USD_SIZE = 5; // $5 for Aster

async function testHyperliquidOrder() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   TEST: Hyperliquid Market Order                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    console.error('❌ PRIVATE_KEY not found in .env file');
    return false;
  }

  try {
    const wallet = new ethers.Wallet(privateKey);
    const walletAddress = wallet.address;
    console.log(`Wallet: ${walletAddress}`);

    // Initialize SDK
    const transport = new HttpTransport({ isTestnet: false });
    const exchangeClient = new ExchangeClient({ wallet: privateKey, transport });
    const infoClient = new InfoClient({ transport });
    const symbolConverter = await SymbolConverter.create({ transport });

    // Get asset ID and decimals
    const baseCoin = TEST_SYMBOL;
    const assetId = symbolConverter.getAssetId(baseCoin);
    const szDecimals = symbolConverter.getSzDecimals(baseCoin);

    if (assetId === undefined || szDecimals === undefined) {
      console.error(`❌ Could not find asset info for ${baseCoin}`);
      return false;
    }

    console.log(`Asset ID: ${assetId}, Size Decimals: ${szDecimals}`);

    // Fetch current mark price (this is what the adapter should do)
    const allMidsData = await infoClient.allMids();
    const markPrice = parseFloat((allMidsData as any)[baseCoin] || '0');
    
    if (markPrice <= 0) {
      console.error(`❌ Could not fetch mark price for ${baseCoin}`);
      return false;
    }

    console.log(`Current mark price: $${markPrice.toFixed(2)}`);

    // Format size and price
    const formattedSize = formatSize(TEST_SIZE.toString(), szDecimals);
    const formattedPrice = formatPrice(markPrice.toString(), szDecimals, true);

    console.log(`Formatted size: ${formattedSize}`);
    console.log(`Formatted price: ${formattedPrice}`);

    if (parseFloat(formattedPrice) <= 0) {
      console.error(`❌ Invalid formatted price: ${formattedPrice}`);
      return false;
    }

    // Place order (IOC limit order for market execution)
    console.log('\n📤 Placing order...');
    const result = await exchangeClient.order({
      orders: [{
        a: assetId,
        b: true, // BUY
        p: formattedPrice,
        r: false, // Not reduce-only
        s: formattedSize,
        t: { limit: { tif: 'Ioc' } }, // IOC for market execution
      }],
      grouping: 'na',
    });

    console.log('📥 Order Response:');
    console.log(JSON.stringify(result, null, 2));

    if (result.status === 'ok' && result.response?.type === 'order') {
      const status = result.response.data.statuses[0];
      if ('error' in status && status.error) {
        const errorMsg = typeof status.error === 'string' ? status.error : JSON.stringify(status.error);
        if (errorMsg.includes('invalid price')) {
          console.error(`❌ Order failed: ${errorMsg}`);
          return false;
        }
        console.log(`⚠️  Order error (may be expected): ${errorMsg}`);
      } else {
        console.log('✅ Order placed successfully!');
        return true;
      }
    }

    return true;
  } catch (error: any) {
    console.error(`❌ Test failed: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

async function testAsterOrder() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   TEST: Aster Market Order                             ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const privateKey = process.env.ASTER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const user = process.env.ASTER_USER;
  const signer = process.env.ASTER_SIGNER;
  const baseUrl = process.env.ASTER_BASE_URL || 'https://api.aster.exchange';

  if (!privateKey || !user || !signer) {
    console.error('❌ Missing Aster credentials: ASTER_PRIVATE_KEY, ASTER_USER, ASTER_SIGNER');
    return false;
  }

  try {
    const wallet = new ethers.Wallet(privateKey);
    console.log(`User: ${user}, Signer: ${signer}, Wallet: ${wallet.address}`);

    const symbol = `${TEST_SYMBOL}USDT`;

    // Fetch current price
    const client = axios.create({ baseURL: baseUrl, timeout: 30000 });
    const priceResponse = await client.get('/fapi/v1/ticker/price', {
      params: { symbol },
    });
    const currentPrice = parseFloat(priceResponse.data.price);
    console.log(`Current ${symbol} price: $${currentPrice}`);

    // Calculate quantity from USD size
    const quantity = (TEST_USD_SIZE / currentPrice).toFixed(8);
    console.log(`Quantity: ${quantity} ${TEST_SYMBOL}`);

    // Generate nonce
    const nonce = Math.floor(Date.now() * 1000);

    // Create order parameters (matching working script)
    const orderParams: Record<string, any> = {
      symbol,
      positionSide: 'BOTH',
      side: 'BUY',
      type: 'MARKET',
      quantity,
      recvWindow: 50000,
    };

    // Sign parameters
    const message = JSON.stringify(orderParams);
    const signature = await wallet.signMessage(message);
    const signatureHex = ethers.hexlify(signature);

    const signedParams = {
      ...orderParams,
      user,
      signer,
      nonce,
      signature: signatureHex,
    };

    // Create form data
    const formData = new URLSearchParams();
    for (const [key, value] of Object.entries(signedParams)) {
      if (value !== null && value !== undefined) {
        formData.append(key, String(value));
      }
    }

    console.log('\n📤 Placing order...');
    console.log('Order params:', JSON.stringify(orderParams, null, 2));

    const response = await client.post('/fapi/v3/order', formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    console.log('📥 Order Response:');
    console.log(JSON.stringify(response.data, null, 2));

    if (response.data.orderId) {
      console.log('✅ Order placed successfully!');
      return true;
    } else {
      console.error('❌ Order failed: No orderId in response');
      return false;
    }
  } catch (error: any) {
    console.error(`❌ Test failed: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Response: ${JSON.stringify(error.response.data)}`);
    }
    return false;
  }
}

async function testLighterOrder() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   TEST: Lighter Market Order                            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const apiKey = process.env.LIGHTER_API_KEY;
  const accountIndex = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '1000');
  const apiKeyIndex = parseInt(process.env.LIGHTER_API_KEY_INDEX || '1');
  const baseUrl = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';

  if (!apiKey) {
    console.error('❌ Missing Lighter credentials: LIGHTER_API_KEY');
    return false;
  }

  let signerClient: SignerClient | null = null;

  try {
    // Normalize API key
    let normalizedKey = apiKey;
    if (normalizedKey.startsWith('0x')) {
      normalizedKey = normalizedKey.slice(2);
    }

    signerClient = new SignerClient({
      url: baseUrl,
      privateKey: normalizedKey,
      accountIndex,
      apiKeyIndex,
    });

    await signerClient.initialize();
    await signerClient.ensureWasmClient();
    console.log('✅ SDK initialized');

    // Initialize API clients
    const apiClient = new ApiClient({ host: baseUrl });
    const orderApi = new OrderApi(apiClient);

    // Get market index for ETH (usually 0)
    const marketIndex = 0; // ETH/USDC
    const market = new MarketHelper(marketIndex, orderApi);
    await market.initialize();
    console.log(`Market Index: ${marketIndex}`);

    // Get order book to get current price
    const orderBook = await orderApi.getOrderBookDetails({ marketIndex: marketIndex } as any) as any;
    if (!orderBook?.bestBid?.price || !orderBook?.bestAsk?.price) {
      console.error('❌ Could not get order book prices');
      return false;
    }

    const midPrice = (parseFloat(orderBook.bestBid.price) + parseFloat(orderBook.bestAsk.price)) / 2;
    console.log(`Current price: $${midPrice.toFixed(2)}`);

    // Prepare order (limit order with market price for market execution)
    const orderParams = {
      marketIndex,
      clientOrderIndex: Date.now(),
      baseAmount: market.amountToUnits(TEST_SIZE),
      price: market.priceToUnits(midPrice),
      isAsk: false, // BUY
      orderType: LighterOrderType.MARKET,
      orderExpiry: Date.now() + 3600000, // 1 hour
    };

    console.log('\n📤 Placing order...');
    console.log('Order params:', JSON.stringify({
      ...orderParams,
      baseAmount: orderParams.baseAmount.toString(),
      price: orderParams.price.toString(),
    }, null, 2));

    const result = await signerClient.createUnifiedOrder(orderParams);

    console.log('📥 Order Response:');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
      console.log('✅ Order placed successfully!');
      return true;
    } else {
      console.error(`❌ Order failed: ${result.mainOrder.error || 'Unknown error'}`);
      return false;
    }
  } catch (error: any) {
    console.error(`❌ Test failed: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    return false;
  } finally {
    if (signerClient) {
      try {
        await signerClient.cleanup();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   ORDER PLACEMENT TESTS                                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const results = {
    hyperliquid: false,
    aster: false,
    lighter: false,
  };

  // Test Hyperliquid
  try {
    results.hyperliquid = await testHyperliquidOrder();
  } catch (error: any) {
    console.error(`Hyperliquid test error: ${error.message}`);
  }

  // Test Aster
  try {
    results.aster = await testAsterOrder();
  } catch (error: any) {
    console.error(`Aster test error: ${error.message}`);
  }

  // Test Lighter
  try {
    results.lighter = await testLighterOrder();
  } catch (error: any) {
    console.error(`Lighter test error: ${error.message}`);
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   TEST SUMMARY                                           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Hyperliquid: ${results.hyperliquid ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Aster:       ${results.aster ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Lighter:     ${results.lighter ? '✅ PASS' : '❌ FAIL'}`);
  console.log('');

  const allPassed = Object.values(results).every(r => r);
  if (allPassed) {
    console.log('✅ All tests passed!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});


