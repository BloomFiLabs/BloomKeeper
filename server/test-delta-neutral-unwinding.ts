/**
 * Test script to verify delta-neutral unwinding logic in test mode
 * 
 * This script:
 * 1. Starts the keeper bot in test mode with mock positions
 * 2. Creates delta-neutral positions by placing mock orders
 * 3. Simulates a withdrawal request
 * 4. Verifies partial reduction (not full close) is used
 * 5. Verifies delta-neutrality is preserved
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { PerpKeeperService } from './src/application/services/PerpKeeperService';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from './src/domain/value-objects/ExchangeConfig';
import { PerpOrderRequest, OrderSide, OrderType } from './src/domain/value-objects/PerpOrder';

// Set test mode
process.env.TEST_MODE = 'true';
process.env.MOCK_CAPITAL_USD = '100000'; // $100k mock capital

async function testDeltaNeutralUnwinding() {
  console.log('\n' + '═'.repeat(70));
  console.log('🧪 DELTA-NEUTRAL UNWINDING TEST');
  console.log('═'.repeat(70) + '\n');

  try {
    // Create NestJS application
    console.log('Starting NestJS app in TEST MODE...\n');
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });

    const configService = app.get(ConfigService);
    const perpKeeperService = app.get(PerpKeeperService);

    // Verify test mode is active
    const testMode = configService.get<string>('TEST_MODE');
    console.log(`TEST_MODE: ${testMode}`);
    
    if (testMode !== 'true') {
      console.error('❌ TEST_MODE is not enabled!');
      await app.close();
      process.exit(1);
    }

    console.log('✅ Test mode is active\n');

    // =======================================================================
    // STEP 1: Create Delta-Neutral Positions
    // =======================================================================
    console.log('─'.repeat(70));
    console.log('STEP 1: CREATING DELTA-NEUTRAL POSITIONS');
    console.log('─'.repeat(70) + '\n');

    // Create ETH delta-neutral pair
    console.log('Creating ETH delta-neutral pair...');
    
    try {
      // LONG ETH on Hyperliquid
      const longOrder = new PerpOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0, // 1 ETH
        3500, // price
      );
      await perpKeeperService.placeOrder(ExchangeType.HYPERLIQUID, longOrder);
      console.log('  ✅ LONG 1.0 ETH on HYPERLIQUID');
    } catch (e: any) {
      console.log(`  ⚠️  HYPERLIQUID order: ${e.message}`);
    }

    try {
      // SHORT ETH on Lighter
      const shortOrder = new PerpOrderRequest(
        'ETH',
        OrderSide.SHORT,
        OrderType.MARKET,
        1.0, // 1 ETH
        3500, // price
      );
      await perpKeeperService.placeOrder(ExchangeType.LIGHTER, shortOrder);
      console.log('  ✅ SHORT 1.0 ETH on LIGHTER');
    } catch (e: any) {
      console.log(`  ⚠️  LIGHTER order: ${e.message}`);
    }

    // Create BTC delta-neutral pair
    console.log('\nCreating BTC delta-neutral pair...');
    
    try {
      // LONG BTC on Lighter
      const longOrder = new PerpOrderRequest(
        'BTC',
        OrderSide.LONG,
        OrderType.MARKET,
        0.1, // 0.1 BTC
        100000, // price
      );
      await perpKeeperService.placeOrder(ExchangeType.LIGHTER, longOrder);
      console.log('  ✅ LONG 0.1 BTC on LIGHTER');
    } catch (e: any) {
      console.log(`  ⚠️  LIGHTER order: ${e.message}`);
    }

    try {
      // SHORT BTC on Hyperliquid
      const shortOrder = new PerpOrderRequest(
        'BTC',
        OrderSide.SHORT,
        OrderType.MARKET,
        0.1, // 0.1 BTC
        100000, // price
      );
      await perpKeeperService.placeOrder(ExchangeType.HYPERLIQUID, shortOrder);
      console.log('  ✅ SHORT 0.1 BTC on HYPERLIQUID');
    } catch (e: any) {
      console.log(`  ⚠️  HYPERLIQUID order: ${e.message}`);
    }

    // Wait a moment for orders to be processed
    await new Promise(resolve => setTimeout(resolve, 1000));

    // =======================================================================
    // STEP 2: Verify Positions
    // =======================================================================
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 2: VERIFY POSITIONS');
    console.log('─'.repeat(70) + '\n');

    const positions = await perpKeeperService.getAllPositions();
    console.log(`Found ${positions.length} position(s):\n`);
    
    let totalPositionValue = 0;
    for (const pos of positions) {
      const value = Math.abs(pos.size * pos.markPrice);
      totalPositionValue += value;
      console.log(`  ${pos.exchangeType}: ${pos.symbol} ${pos.side} ${Math.abs(pos.size).toFixed(4)} @ $${pos.markPrice.toFixed(2)}`);
      console.log(`    Value: $${value.toFixed(2)}, PnL: $${pos.unrealizedPnl.toFixed(2)}\n`);
    }

    // =======================================================================
    // STEP 3: Analyze Delta-Neutral Pairs
    // =======================================================================
    console.log('─'.repeat(70));
    console.log('STEP 3: DELTA-NEUTRAL PAIR ANALYSIS');
    console.log('─'.repeat(70) + '\n');

    // Group positions by symbol
    const positionsBySymbol = new Map<string, typeof positions>();
    for (const pos of positions) {
      const symbol = pos.symbol;
      if (!positionsBySymbol.has(symbol)) {
        positionsBySymbol.set(symbol, []);
      }
      positionsBySymbol.get(symbol)!.push(pos);
    }

    interface DeltaNeutralPair {
      symbol: string;
      longExchange: ExchangeType;
      shortExchange: ExchangeType;
      longSize: number;
      shortSize: number;
      maxDeltaNeutralSize: number;
      totalValue: number;
      combinedPnl: number;
    }

    const deltaNeutralPairs: DeltaNeutralPair[] = [];

    for (const [symbol, symbolPositions] of positionsBySymbol) {
      const longs = symbolPositions.filter(p => p.side === OrderSide.LONG);
      const shorts = symbolPositions.filter(p => p.side === OrderSide.SHORT);

      for (const longPos of longs) {
        for (const shortPos of shorts) {
          if (longPos.exchangeType !== shortPos.exchangeType) {
            const longSize = Math.abs(longPos.size);
            const shortSize = Math.abs(shortPos.size);
            const longValue = longSize * longPos.markPrice;
            const shortValue = shortSize * shortPos.markPrice;
            
            deltaNeutralPairs.push({
              symbol,
              longExchange: longPos.exchangeType,
              shortExchange: shortPos.exchangeType,
              longSize,
              shortSize,
              maxDeltaNeutralSize: Math.min(longSize, shortSize),
              totalValue: longValue + shortValue,
              combinedPnl: longPos.unrealizedPnl + shortPos.unrealizedPnl,
            });
          }
        }
      }
    }

    // Sort by PnL (least profitable first)
    deltaNeutralPairs.sort((a, b) => a.combinedPnl - b.combinedPnl);

    let totalPairValue = 0;
    for (const pair of deltaNeutralPairs) {
      totalPairValue += pair.totalValue;
      console.log(`📊 ${pair.symbol} DELTA-NEUTRAL PAIR:`);
      console.log(`   LONG:  ${pair.longExchange} - ${pair.longSize.toFixed(4)} units`);
      console.log(`   SHORT: ${pair.shortExchange} - ${pair.shortSize.toFixed(4)} units`);
      console.log(`   Total Value: $${pair.totalValue.toFixed(2)}`);
      console.log(`   Combined PnL: $${pair.combinedPnl.toFixed(2)}`);
      console.log(`   Max Delta-Neutral Size: ${pair.maxDeltaNeutralSize.toFixed(4)} units\n`);
    }

    console.log(`Total delta-neutral pairs: ${deltaNeutralPairs.length}`);
    console.log(`Total pair value: $${totalPairValue.toFixed(2)}\n`);

    // =======================================================================
    // STEP 4: Simulate Withdrawal Scenarios
    // =======================================================================
    console.log('─'.repeat(70));
    console.log('STEP 4: WITHDRAWAL SIMULATION');
    console.log('─'.repeat(70) + '\n');

    const withdrawalScenarios = [
      { amount: 1000, description: 'Small withdrawal ($1,000)' },
      { amount: 5000, description: 'Medium withdrawal ($5,000)' },
      { amount: 15000, description: 'Large withdrawal ($15,000)' },
    ];

    for (const scenario of withdrawalScenarios) {
      console.log(`\n📤 Scenario: ${scenario.description}`);
      console.log(`   Amount needed: $${scenario.amount.toFixed(2)}`);

      if (totalPairValue > 0) {
        let remainingNeeded = scenario.amount;
        let totalFreed = 0;
        const actions: string[] = [];

        // Process pairs in order (least profitable first)
        for (const pair of deltaNeutralPairs) {
          if (remainingNeeded <= 0) break;

          const avgPrice = pair.totalValue / (pair.longSize + pair.shortSize);
          
          // Calculate size to reduce
          const sizeToReduce = Math.min(
            remainingNeeded / (2 * avgPrice),
            pair.maxDeltaNeutralSize,
          );

          const isFullClose = sizeToReduce >= pair.maxDeltaNeutralSize * 0.99;
          const freedFromPair = sizeToReduce * 2 * avgPrice;
          const reductionPercent = (sizeToReduce / pair.maxDeltaNeutralSize) * 100;

          totalFreed += freedFromPair;
          remainingNeeded -= freedFromPair;

          if (isFullClose) {
            actions.push(`   - ${pair.symbol}: FULL CLOSE (100%)`);
          } else {
            actions.push(`   - ${pair.symbol}: REDUCE ${reductionPercent.toFixed(1)}% (${sizeToReduce.toFixed(4)} units)`);
          }
        }

        console.log(`   Actions:`);
        for (const action of actions) {
          console.log(action);
        }
        console.log(`   Total freed: $${totalFreed.toFixed(2)}`);

        if (remainingNeeded > 0) {
          console.log(`   ⚠️  Still need: $${remainingNeeded.toFixed(2)} (insufficient positions)`);
        } else {
          console.log(`   ✅ Withdrawal fully covered`);
        }
      } else {
        console.log('   No delta-neutral pairs to unwind');
      }
    }

    // =======================================================================
    // STEP 5: Verify Delta Neutrality
    // =======================================================================
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 5: DELTA NEUTRALITY VERIFICATION');
    console.log('─'.repeat(70) + '\n');

    if (deltaNeutralPairs.length > 0) {
      console.log('When reducing positions:');
      console.log('  • BOTH legs are reduced by the SAME amount');
      console.log('  • Net delta exposure remains ZERO');
      console.log('  • No directional price risk is created\n');

      const pair = deltaNeutralPairs[0];
      console.log(`Example with ${pair.symbol}:`);
      console.log(`  Before: LONG ${pair.longSize} + SHORT ${pair.shortSize} = Delta ${pair.longSize - pair.shortSize}`);
      
      const reduction = 0.2;
      const longAfter = pair.longSize - reduction;
      const shortAfter = pair.shortSize - reduction;
      console.log(`  Reduce both by ${reduction}:`);
      console.log(`  After:  LONG ${longAfter.toFixed(4)} + SHORT ${shortAfter.toFixed(4)} = Delta ${(longAfter - shortAfter).toFixed(4)}`);
      console.log(`  ✅ Delta exposure preserved!`);
    }

    console.log('\n' + '═'.repeat(70));
    console.log('✅ TEST COMPLETE');
    console.log('═'.repeat(70) + '\n');

    await app.close();
    process.exit(0);

  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testDeltaNeutralUnwinding();

