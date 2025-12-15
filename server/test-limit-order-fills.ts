/**
 * Test script to verify realistic limit order behavior in test mode
 * 
 * This script:
 * 1. Places limit orders that should NOT fill immediately
 * 2. Shows orders in pending queue
 * 3. Waits for price to cross threshold
 * 4. Shows automatic fills when price moves
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { PerpKeeperService } from './src/application/services/PerpKeeperService';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from './src/domain/value-objects/ExchangeConfig';
import { PerpOrderRequest, OrderSide, OrderType, OrderStatus } from './src/domain/value-objects/PerpOrder';
import { MockExchangeAdapter } from './src/infrastructure/adapters/mock/MockExchangeAdapter';

// Set test mode (realistic limit orders by default)
process.env.TEST_MODE = 'true';
process.env.MOCK_CAPITAL_USD = '100000';
// DO NOT set MOCK_INSTANT_FILL - we want realistic behavior

async function testLimitOrderFills() {
  console.log('\n' + '═'.repeat(70));
  console.log('🧪 REALISTIC LIMIT ORDER TEST');
  console.log('═'.repeat(70) + '\n');

  try {
    console.log('Starting NestJS app in TEST MODE (realistic limit orders)...\n');
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });

    const configService = app.get(ConfigService);
    const perpKeeperService = app.get(PerpKeeperService);

    // Verify settings
    const testMode = configService.get<string>('TEST_MODE');
    const instantFill = configService.get<string>('MOCK_INSTANT_FILL');
    
    console.log(`TEST_MODE: ${testMode}`);
    console.log(`MOCK_INSTANT_FILL: ${instantFill || 'false (realistic)'}\n`);

    // Get mock adapter
    const mockAdapter = perpKeeperService.getExchangeAdapter(ExchangeType.HYPERLIQUID) as MockExchangeAdapter;

    // =========================================================================
    // STEP 1: Get current ETH price
    // =========================================================================
    console.log('─'.repeat(70));
    console.log('STEP 1: GET CURRENT ETH PRICE');
    console.log('─'.repeat(70) + '\n');

    const currentPrice = await mockAdapter.getMarkPrice('ETH');
    console.log(`Current ETH price: $${currentPrice.toFixed(2)}\n`);

    // =========================================================================
    // STEP 2: Place limit orders that should NOT fill immediately
    // =========================================================================
    console.log('─'.repeat(70));
    console.log('STEP 2: PLACE LIMIT ORDERS (should go to pending queue)');
    console.log('─'.repeat(70) + '\n');

    // Buy limit below current price (won't fill immediately)
    const buyLimitPrice = currentPrice * 0.995; // 0.5% below
    console.log(`Placing BUY LIMIT at $${buyLimitPrice.toFixed(2)} (0.5% below current)...`);
    
    const buyOrder = new PerpOrderRequest(
      'ETH',
      OrderSide.LONG,
      OrderType.LIMIT,
      0.5,
      buyLimitPrice,
    );
    
    const buyResponse = await mockAdapter.placeOrder(buyOrder);
    console.log(`  Order ID: ${buyResponse.orderId}`);
    console.log(`  Status: ${buyResponse.status}`);
    console.log(`  ${buyResponse.status === OrderStatus.PENDING ? '🕐 Order is PENDING (waiting for price to drop)' : '✅ Order FILLED immediately'}\n`);

    // Sell limit above current price (won't fill immediately)
    const sellLimitPrice = currentPrice * 1.005; // 0.5% above
    console.log(`Placing SELL LIMIT at $${sellLimitPrice.toFixed(2)} (0.5% above current)...`);
    
    const sellOrder = new PerpOrderRequest(
      'ETH',
      OrderSide.SHORT,
      OrderType.LIMIT,
      0.5,
      sellLimitPrice,
    );
    
    const sellResponse = await mockAdapter.placeOrder(sellOrder);
    console.log(`  Order ID: ${sellResponse.orderId}`);
    console.log(`  Status: ${sellResponse.status}`);
    console.log(`  ${sellResponse.status === OrderStatus.PENDING ? '🕐 Order is PENDING (waiting for price to rise)' : '✅ Order FILLED immediately'}\n`);

    // =========================================================================
    // STEP 3: Show pending orders
    // =========================================================================
    console.log('─'.repeat(70));
    console.log('STEP 3: PENDING ORDERS QUEUE');
    console.log('─'.repeat(70) + '\n');

    const pendingOrders = mockAdapter.getPendingOrders();
    console.log(`Total pending orders: ${pendingOrders.length}\n`);

    for (const order of pendingOrders) {
      console.log(`📋 Order ${order.orderId}:`);
      console.log(`   Symbol: ${order.request.symbol}`);
      console.log(`   Side: ${order.request.side}`);
      console.log(`   Size: ${order.request.size}`);
      console.log(`   Limit Price: $${order.request.price?.toFixed(2)}`);
      console.log(`   Status: ${order.status}`);
      console.log(`   Created: ${order.createdAt.toISOString()}`);
      console.log(`   Expires: ${order.expiresAt.toISOString()}\n`);
    }

    // =========================================================================
    // STEP 4: Place a limit order that SHOULD fill immediately
    // =========================================================================
    console.log('─'.repeat(70));
    console.log('STEP 4: PLACE LIMIT ORDER THAT FILLS IMMEDIATELY');
    console.log('─'.repeat(70) + '\n');

    // Buy limit ABOVE current price (will fill immediately)
    const aggressiveBuyPrice = currentPrice * 1.01; // 1% above
    console.log(`Placing BUY LIMIT at $${aggressiveBuyPrice.toFixed(2)} (1% ABOVE current)...`);
    console.log(`Since price $${currentPrice.toFixed(2)} <= limit $${aggressiveBuyPrice.toFixed(2)}, should fill NOW\n`);
    
    const aggressiveBuy = new PerpOrderRequest(
      'ETH',
      OrderSide.LONG,
      OrderType.LIMIT,
      0.1,
      aggressiveBuyPrice,
    );
    
    const aggressiveResponse = await mockAdapter.placeOrder(aggressiveBuy);
    console.log(`  Order ID: ${aggressiveResponse.orderId}`);
    console.log(`  Status: ${aggressiveResponse.status}`);
    console.log(`  Fill Price: ${aggressiveResponse.averageFillPrice ? '$' + aggressiveResponse.averageFillPrice.toFixed(2) : 'N/A'}`);
    console.log(`  ${aggressiveResponse.status === OrderStatus.FILLED ? '✅ Order FILLED immediately (as expected)' : '❌ Order should have filled!'}\n`);

    // =========================================================================
    // STEP 5: Show positions after fills
    // =========================================================================
    console.log('─'.repeat(70));
    console.log('STEP 5: CURRENT POSITIONS');
    console.log('─'.repeat(70) + '\n');

    const positions = await mockAdapter.getPositions();
    if (positions.length === 0) {
      console.log('No positions (pending orders not filled yet)\n');
    } else {
      for (const pos of positions) {
        console.log(`📊 ${pos.symbol} ${pos.side}: ${pos.size.toFixed(4)} @ $${pos.entryPrice.toFixed(2)}`);
        console.log(`   Mark Price: $${pos.markPrice.toFixed(2)}`);
        console.log(`   PnL: $${pos.unrealizedPnl.toFixed(2)}\n`);
      }
    }

    // =========================================================================
    // STEP 6: Monitor for fills (price polling)
    // =========================================================================
    console.log('─'.repeat(70));
    console.log('STEP 6: MONITOR FOR FILLS');
    console.log('─'.repeat(70) + '\n');

    console.log('Monitoring price changes for 20 seconds...');
    console.log('Pending orders will fill when price crosses their threshold.\n');

    const startTime = Date.now();
    const monitorDuration = 20000; // 20 seconds
    let lastPendingCount = pendingOrders.length;

    while (Date.now() - startTime < monitorDuration) {
      const price = await mockAdapter.getMarkPrice('ETH');
      const pending = mockAdapter.getPendingOrders();
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[${elapsed}s] ETH: $${price.toFixed(2)} | Pending orders: ${pending.length}`);
      
      // Check if any orders filled
      if (pending.length < lastPendingCount) {
        console.log(`   📈 Order filled! Price crossed threshold.`);
      }
      lastPendingCount = pending.length;

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // =========================================================================
    // STEP 7: Cancel remaining pending orders
    // =========================================================================
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 7: CANCEL REMAINING PENDING ORDERS');
    console.log('─'.repeat(70) + '\n');

    const finalPending = mockAdapter.getPendingOrders();
    console.log(`Remaining pending orders: ${finalPending.length}`);

    if (finalPending.length > 0) {
      const cancelled = await mockAdapter.cancelAllOrders('ETH');
      console.log(`Cancelled ${cancelled} orders`);
    }

    // Cleanup
    mockAdapter.stopPricePolling();

    console.log('\n' + '═'.repeat(70));
    console.log('✅ TEST COMPLETE');
    console.log('═'.repeat(70) + '\n');

    console.log('Summary:');
    console.log('• Limit orders below market → PENDING until price drops');
    console.log('• Limit orders above market → FILLED immediately');
    console.log('• Price polling checks every 2 seconds for fills');
    console.log('• Orders expire after 1 hour if not filled\n');

    await app.close();
    process.exit(0);

  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testLimitOrderFills();

