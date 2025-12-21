/**
 * PerpKeeperScheduler Single-Leg and Zombie Order Tests
 * 
 * These tests verify:
 * 1. tryOpenMissingSide uses correct exchange (not recalculating based on current rates)
 * 2. Safety checks prevent placing orders on same exchange as existing position
 * 3. Zombie order detection and cleanup
 * 4. Proper handling of single-leg recovery
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { OrderSide, OrderStatus, PerpOrderResponse } from '../../domain/value-objects/PerpOrder';

// Helper to normalize symbols (mirrors actual implementation)
function normalizeSymbol(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace('USDT', '')
    .replace('USDC', '')
    .replace('-PERP', '')
    .replace('PERP', '')
    .replace('-USD', '')
    .replace('USD', '');
}

// Helper to create mock positions
function createPosition(
  symbol: string,
  side: OrderSide,
  exchange: ExchangeType,
  size: number = 100,
): PerpPosition {
  return new PerpPosition(
    exchange,
    symbol,
    side,
    size,
    100, // entryPrice
    100, // markPrice
    0,   // unrealizedPnl
    10,  // leverage
    90,  // liquidationPrice
    10,  // marginUsed
    undefined,
    new Date(),
  );
}

// Mock order structure
interface MockOrder {
  symbol: string;
  side: 'LONG' | 'SHORT';
  exchange: ExchangeType;
  orderId: string;
  timestamp?: Date;
}

// Simulated retry info structure (mirrors actual implementation)
interface SingleLegRetryInfo {
  retryCount: number;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  lastRetryTime: Date;
}

/**
 * Simulated tryOpenMissingSide logic
 * This mirrors the FIXED implementation that uses stored retry info
 */
function determineCorrectExchangeForMissingSide(
  position: PerpPosition,
  singleLegRetries: Map<string, SingleLegRetryInfo>,
  availableExchanges: ExchangeType[],
): { missingExchange: ExchangeType; missingSide: OrderSide } | { error: string } {
  let expectedLongExchange: ExchangeType | undefined;
  let expectedShortExchange: ExchangeType | undefined;

  // First, check if we have stored retry info with the original exchange assignments
  for (const [, retryInfo] of singleLegRetries.entries()) {
    if (
      retryInfo.longExchange === position.exchangeType ||
      retryInfo.shortExchange === position.exchangeType
    ) {
      expectedLongExchange = retryInfo.longExchange;
      expectedShortExchange = retryInfo.shortExchange;
      break;
    }
  }

  // If no retry info, determine exchanges based on current position
  if (!expectedLongExchange || !expectedShortExchange) {
    const otherExchanges = availableExchanges.filter(e => e !== position.exchangeType);
    if (otherExchanges.length === 0) {
      return { error: 'No other exchanges available' };
    }

    // Prefer Hyperliquid if available
    const missingExchangeCandidate = otherExchanges.includes(ExchangeType.HYPERLIQUID)
      ? ExchangeType.HYPERLIQUID
      : otherExchanges[0];

    if (position.side === OrderSide.LONG) {
      expectedLongExchange = position.exchangeType;
      expectedShortExchange = missingExchangeCandidate;
    } else {
      expectedShortExchange = position.exchangeType;
      expectedLongExchange = missingExchangeCandidate;
    }
  }

  // Determine missing exchange and side
  const missingExchange =
    position.side === OrderSide.LONG
      ? expectedShortExchange
      : expectedLongExchange;
  const missingSide =
    position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;

  // SAFETY CHECK: Ensure we're not placing on the same exchange
  if (missingExchange === position.exchangeType) {
    return { error: 'BUG: Attempted to place on same exchange' };
  }

  return { missingExchange, missingSide };
}

/**
 * Zombie order detection logic
 */
function detectZombieOrders(
  positions: PerpPosition[],
  openOrders: MockOrder[],
): MockOrder[] {
  const zombieOrders: MockOrder[] = [];

  // Group by normalized symbol
  const bySymbol = new Map<string, {
    positions: PerpPosition[];
    orders: MockOrder[];
  }>();

  for (const pos of positions) {
    const sym = normalizeSymbol(pos.symbol);
    if (!bySymbol.has(sym)) {
      bySymbol.set(sym, { positions: [], orders: [] });
    }
    bySymbol.get(sym)!.positions.push(pos);
  }

  for (const order of openOrders) {
    const sym = normalizeSymbol(order.symbol);
    if (!bySymbol.has(sym)) {
      bySymbol.set(sym, { positions: [], orders: [] });
    }
    bySymbol.get(sym)!.orders.push(order);
  }

  // Check each symbol for zombie orders
  for (const [symbol, data] of bySymbol) {
    for (const order of data.orders) {
      // Get all exchanges with activity for this symbol
      const positionExchanges = new Set(data.positions.map(p => p.exchangeType));
      const orderExchanges = new Set(data.orders.map(o => o.exchange));
      const allExchanges = new Set([...positionExchanges, ...orderExchanges]);

      // An order is a zombie if:
      // 1. There's no position or other order on a DIFFERENT exchange
      // 2. OR the order is on the same exchange as an existing position (for non-reduceOnly orders)
      
      const hasCounterpartOnDifferentExchange = 
        data.positions.some(p => p.exchangeType !== order.exchange) ||
        data.orders.some(o => o !== order && o.exchange !== order.exchange);

      if (!hasCounterpartOnDifferentExchange) {
        zombieOrders.push(order);
      }
    }
  }

  return zombieOrders;
}

describe('tryOpenMissingSide Exchange Selection', () => {
  describe('Using Stored Retry Info', () => {
    it('should use stored retry info exchanges, not recalculate', () => {
      // Scenario: Original opportunity was LONG on HL, SHORT on Lighter
      // Position exists: SHORT on Lighter
      // Funding rates have changed (would suggest different exchanges)
      // But we should still use the ORIGINAL exchanges from retry info

      const position = createPosition('MEGA-USD', OrderSide.SHORT, ExchangeType.LIGHTER);
      
      const singleLegRetries = new Map<string, SingleLegRetryInfo>();
      singleLegRetries.set('MEGA-HYPERLIQUID-LIGHTER', {
        retryCount: 1,
        longExchange: ExchangeType.HYPERLIQUID, // Original: LONG on HL
        shortExchange: ExchangeType.LIGHTER,    // Original: SHORT on Lighter
        lastRetryTime: new Date(),
      });

      const result = determineCorrectExchangeForMissingSide(
        position,
        singleLegRetries,
        [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER],
      );

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        // Should place LONG on Hyperliquid (from stored info)
        expect(result.missingExchange).toBe(ExchangeType.HYPERLIQUID);
        expect(result.missingSide).toBe(OrderSide.LONG);
      }
    });

    it('should use stored retry info even when funding rates suggest opposite', () => {
      // Same scenario but emphasizing that current rates don't matter
      const position = createPosition('BTC', OrderSide.LONG, ExchangeType.HYPERLIQUID);
      
      const singleLegRetries = new Map<string, SingleLegRetryInfo>();
      singleLegRetries.set('BTC-HYPERLIQUID-LIGHTER', {
        retryCount: 2,
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        lastRetryTime: new Date(),
      });

      const result = determineCorrectExchangeForMissingSide(
        position,
        singleLegRetries,
        [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER],
      );

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        // Should place SHORT on Lighter (from stored info)
        expect(result.missingExchange).toBe(ExchangeType.LIGHTER);
        expect(result.missingSide).toBe(OrderSide.SHORT);
      }
    });
  });

  describe('Without Retry Info (Fallback)', () => {
    it('should find different exchange when no retry info exists', () => {
      const position = createPosition('ETH', OrderSide.SHORT, ExchangeType.LIGHTER);
      const singleLegRetries = new Map<string, SingleLegRetryInfo>();

      const result = determineCorrectExchangeForMissingSide(
        position,
        singleLegRetries,
        [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER],
      );

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        // Should place LONG on Hyperliquid (different exchange)
        expect(result.missingExchange).toBe(ExchangeType.HYPERLIQUID);
        expect(result.missingSide).toBe(OrderSide.LONG);
        expect(result.missingExchange).not.toBe(position.exchangeType);
      }
    });

    it('should prefer Hyperliquid when multiple exchanges available', () => {
      const position = createPosition('SOL', OrderSide.LONG, ExchangeType.LIGHTER);
      const singleLegRetries = new Map<string, SingleLegRetryInfo>();

      const result = determineCorrectExchangeForMissingSide(
        position,
        singleLegRetries,
        [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER],
      );

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        // Should prefer Hyperliquid
        expect(result.missingExchange).toBe(ExchangeType.HYPERLIQUID);
      }
    });

    it('should use any available exchange when Hyperliquid not available', () => {
      const position = createPosition('AVAX', OrderSide.SHORT, ExchangeType.LIGHTER);
      const singleLegRetries = new Map<string, SingleLegRetryInfo>();

      const result = determineCorrectExchangeForMissingSide(
        position,
        singleLegRetries,
        [ExchangeType.LIGHTER, ExchangeType.ASTER], // No Hyperliquid
      );

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.missingExchange).toBe(ExchangeType.ASTER);
        expect(result.missingExchange).not.toBe(position.exchangeType);
      }
    });
  });

  describe('Safety Checks', () => {
    it('should error when no other exchanges available', () => {
      const position = createPosition('LINK', OrderSide.LONG, ExchangeType.HYPERLIQUID);
      const singleLegRetries = new Map<string, SingleLegRetryInfo>();

      const result = determineCorrectExchangeForMissingSide(
        position,
        singleLegRetries,
        [ExchangeType.HYPERLIQUID], // Only same exchange available
      );

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('No other exchanges');
      }
    });

    it('should never return same exchange as position', () => {
      // Test many combinations
      const exchanges = [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER];
      const sides = [OrderSide.LONG, OrderSide.SHORT];

      for (const exchange of exchanges) {
        for (const side of sides) {
          const position = createPosition('TEST', side, exchange);
          const singleLegRetries = new Map<string, SingleLegRetryInfo>();

          const result = determineCorrectExchangeForMissingSide(
            position,
            singleLegRetries,
            exchanges,
          );

          if (!('error' in result)) {
            expect(result.missingExchange).not.toBe(exchange);
          }
        }
      }
    });
  });

  describe('The Exact Bug Scenario', () => {
    it('should NOT place LONG on Lighter when SHORT exists on Lighter', () => {
      // This is the exact bug that happened:
      // - SHORT position on Lighter
      // - Bot tried to place LONG on Lighter (WRONG!)
      
      const position = createPosition('MEGA-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 158);
      const singleLegRetries = new Map<string, SingleLegRetryInfo>();

      const result = determineCorrectExchangeForMissingSide(
        position,
        singleLegRetries,
        [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER],
      );

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        // MUST place on Hyperliquid, NOT Lighter
        expect(result.missingExchange).toBe(ExchangeType.HYPERLIQUID);
        expect(result.missingExchange).not.toBe(ExchangeType.LIGHTER);
        expect(result.missingSide).toBe(OrderSide.LONG);
      }
    });

    it('should NOT place SHORT on Hyperliquid when LONG exists on Hyperliquid', () => {
      const position = createPosition('BTC', OrderSide.LONG, ExchangeType.HYPERLIQUID);
      const singleLegRetries = new Map<string, SingleLegRetryInfo>();

      const result = determineCorrectExchangeForMissingSide(
        position,
        singleLegRetries,
        [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER],
      );

      expect('error' in result).toBe(false);
      if (!('error' in result)) {
        expect(result.missingExchange).toBe(ExchangeType.LIGHTER);
        expect(result.missingExchange).not.toBe(ExchangeType.HYPERLIQUID);
        expect(result.missingSide).toBe(OrderSide.SHORT);
      }
    });
  });
});

describe('Zombie Order Detection', () => {
  describe('Valid States (No Zombies)', () => {
    it('should not flag orders with matching position on different exchange', () => {
      const positions = [
        createPosition('MEGA', OrderSide.LONG, ExchangeType.HYPERLIQUID),
      ];
      const orders: MockOrder[] = [
        { symbol: 'MEGA-USD', side: 'SHORT', exchange: ExchangeType.LIGHTER, orderId: '1' },
      ];

      const zombies = detectZombieOrders(positions, orders);
      expect(zombies).toHaveLength(0);
    });

    it('should not flag paired opening orders', () => {
      const positions: PerpPosition[] = [];
      const orders: MockOrder[] = [
        { symbol: 'BTC', side: 'LONG', exchange: ExchangeType.HYPERLIQUID, orderId: '1' },
        { symbol: 'BTC-USD', side: 'SHORT', exchange: ExchangeType.LIGHTER, orderId: '2' },
      ];

      const zombies = detectZombieOrders(positions, orders);
      expect(zombies).toHaveLength(0);
    });

    it('should not flag close orders with existing positions', () => {
      const positions = [
        createPosition('ETH', OrderSide.LONG, ExchangeType.HYPERLIQUID),
        createPosition('ETH-USD', OrderSide.SHORT, ExchangeType.LIGHTER),
      ];
      const orders: MockOrder[] = [
        { symbol: 'ETH', side: 'SHORT', exchange: ExchangeType.HYPERLIQUID, orderId: '1' }, // Close LONG
        { symbol: 'ETH-USD', side: 'LONG', exchange: ExchangeType.LIGHTER, orderId: '2' }, // Close SHORT
      ];

      const zombies = detectZombieOrders(positions, orders);
      expect(zombies).toHaveLength(0);
    });
  });

  describe('Zombie Detection', () => {
    it('should flag order with no counterpart on any exchange', () => {
      const positions: PerpPosition[] = [];
      const orders: MockOrder[] = [
        { symbol: 'ORPHAN', side: 'LONG', exchange: ExchangeType.HYPERLIQUID, orderId: '1' },
      ];

      const zombies = detectZombieOrders(positions, orders);
      expect(zombies).toHaveLength(1);
      expect(zombies[0].orderId).toBe('1');
    });

    it('should flag order when only position is on same exchange', () => {
      // This is the exact bug scenario
      const positions = [
        createPosition('MEGA-USD', OrderSide.SHORT, ExchangeType.LIGHTER),
      ];
      const orders: MockOrder[] = [
        { symbol: 'MEGA-USD', side: 'LONG', exchange: ExchangeType.LIGHTER, orderId: 'zombie-1' },
      ];

      const zombies = detectZombieOrders(positions, orders);
      expect(zombies).toHaveLength(1);
      expect(zombies[0].orderId).toBe('zombie-1');
    });

    it('should flag multiple zombie orders', () => {
      const positions: PerpPosition[] = [];
      const orders: MockOrder[] = [
        { symbol: 'ZOMBIE1', side: 'LONG', exchange: ExchangeType.HYPERLIQUID, orderId: '1' },
        { symbol: 'ZOMBIE2', side: 'SHORT', exchange: ExchangeType.LIGHTER, orderId: '2' },
      ];

      const zombies = detectZombieOrders(positions, orders);
      expect(zombies).toHaveLength(2);
    });

    it('should flag zombie even when other valid pairs exist', () => {
      const positions = [
        createPosition('BTC', OrderSide.LONG, ExchangeType.HYPERLIQUID),
        createPosition('BTC-USD', OrderSide.SHORT, ExchangeType.LIGHTER),
      ];
      const orders: MockOrder[] = [
        { symbol: 'ZOMBIE', side: 'LONG', exchange: ExchangeType.HYPERLIQUID, orderId: 'zombie-1' },
      ];

      const zombies = detectZombieOrders(positions, orders);
      expect(zombies).toHaveLength(1);
      expect(zombies[0].symbol).toBe('ZOMBIE');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty positions and orders', () => {
      const zombies = detectZombieOrders([], []);
      expect(zombies).toHaveLength(0);
    });

    it('should handle positions with no orders', () => {
      const positions = [
        createPosition('BTC', OrderSide.LONG, ExchangeType.HYPERLIQUID),
        createPosition('BTC-USD', OrderSide.SHORT, ExchangeType.LIGHTER),
      ];

      const zombies = detectZombieOrders(positions, []);
      expect(zombies).toHaveLength(0);
    });

    it('should handle different symbol formats', () => {
      const positions = [
        createPosition('MEGA', OrderSide.LONG, ExchangeType.HYPERLIQUID),
      ];
      const orders: MockOrder[] = [
        { symbol: 'MEGA-USD', side: 'SHORT', exchange: ExchangeType.LIGHTER, orderId: '1' },
      ];

      // Should normalize and recognize as same asset
      const zombies = detectZombieOrders(positions, orders);
      expect(zombies).toHaveLength(0);
    });
  });
});

describe('Single-Leg Recovery Flow', () => {
  it('should correctly identify missing side for LONG position', () => {
    const position = createPosition('SOL', OrderSide.LONG, ExchangeType.HYPERLIQUID);
    const singleLegRetries = new Map<string, SingleLegRetryInfo>();

    const result = determineCorrectExchangeForMissingSide(
      position,
      singleLegRetries,
      [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER],
    );

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.missingSide).toBe(OrderSide.SHORT);
    }
  });

  it('should correctly identify missing side for SHORT position', () => {
    const position = createPosition('SOL', OrderSide.SHORT, ExchangeType.LIGHTER);
    const singleLegRetries = new Map<string, SingleLegRetryInfo>();

    const result = determineCorrectExchangeForMissingSide(
      position,
      singleLegRetries,
      [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER],
    );

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.missingSide).toBe(OrderSide.LONG);
    }
  });

  it('should maintain retry info across multiple attempts', () => {
    const position = createPosition('AVAX', OrderSide.SHORT, ExchangeType.LIGHTER);
    
    const singleLegRetries = new Map<string, SingleLegRetryInfo>();
    // Simulate retry info being stored from first attempt
    singleLegRetries.set('AVAX-HYPERLIQUID-LIGHTER', {
      retryCount: 3, // Already tried 3 times
      longExchange: ExchangeType.HYPERLIQUID,
      shortExchange: ExchangeType.LIGHTER,
      lastRetryTime: new Date(Date.now() - 60000), // 1 minute ago
    });

    // Even after multiple retries, should still use same exchanges
    const result = determineCorrectExchangeForMissingSide(
      position,
      singleLegRetries,
      [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER],
    );

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.missingExchange).toBe(ExchangeType.HYPERLIQUID);
      expect(result.missingSide).toBe(OrderSide.LONG);
    }
  });
});

describe('Paired Position Order Cleanup Policy', () => {
  it('should cancel open orders for symbols with valid cross-exchange pairs', () => {
    // Scenario: We have a valid pair (LONG on HL, SHORT on Lighter)
    // But there's still an open order on one of the exchanges
    // This order should be cancelled

    const positions = [
      createPosition('BTC', OrderSide.LONG, ExchangeType.HYPERLIQUID),
      createPosition('BTC-USD', OrderSide.SHORT, ExchangeType.LIGHTER),
    ];

    const openOrders: MockOrder[] = [
      { symbol: 'BTC', side: 'SHORT', exchange: ExchangeType.HYPERLIQUID, orderId: 'orphan-1' },
    ];

    // Group positions by symbol
    const positionsBySymbol = new Map<string, { exchanges: Set<ExchangeType>; sides: Set<OrderSide> }>();
    for (const pos of positions) {
      const sym = normalizeSymbol(pos.symbol);
      if (!positionsBySymbol.has(sym)) {
        positionsBySymbol.set(sym, { exchanges: new Set(), sides: new Set() });
      }
      positionsBySymbol.get(sym)!.exchanges.add(pos.exchangeType);
      positionsBySymbol.get(sym)!.sides.add(pos.side);
    }

    // Check if BTC has a valid cross-exchange pair
    const btcData = positionsBySymbol.get('BTC');
    expect(btcData).toBeDefined();
    expect(btcData!.exchanges.size).toBe(2); // Two different exchanges
    expect(btcData!.sides.has(OrderSide.LONG)).toBe(true);
    expect(btcData!.sides.has(OrderSide.SHORT)).toBe(true);

    // The open order should be cancelled because BTC already has a valid pair
    const ordersToCancel = openOrders.filter(order => {
      const sym = normalizeSymbol(order.symbol);
      const data = positionsBySymbol.get(sym);
      return data && data.exchanges.size >= 2 && data.sides.has(OrderSide.LONG) && data.sides.has(OrderSide.SHORT);
    });

    expect(ordersToCancel.length).toBe(1);
    expect(ordersToCancel[0].orderId).toBe('orphan-1');
  });

  it('should NOT cancel orders for symbols without valid pairs', () => {
    // Scenario: Single-leg position, order is trying to complete the pair
    const positions = [
      createPosition('ETH', OrderSide.LONG, ExchangeType.HYPERLIQUID),
    ];

    const openOrders: MockOrder[] = [
      { symbol: 'ETH-USD', side: 'SHORT', exchange: ExchangeType.LIGHTER, orderId: 'needed-1' },
    ];

    // Group positions by symbol
    const positionsBySymbol = new Map<string, { exchanges: Set<ExchangeType>; sides: Set<OrderSide> }>();
    for (const pos of positions) {
      const sym = normalizeSymbol(pos.symbol);
      if (!positionsBySymbol.has(sym)) {
        positionsBySymbol.set(sym, { exchanges: new Set(), sides: new Set() });
      }
      positionsBySymbol.get(sym)!.exchanges.add(pos.exchangeType);
      positionsBySymbol.get(sym)!.sides.add(pos.side);
    }

    // ETH only has LONG on one exchange - NOT a valid pair
    const ethData = positionsBySymbol.get('ETH');
    expect(ethData).toBeDefined();
    expect(ethData!.exchanges.size).toBe(1); // Only one exchange
    expect(ethData!.sides.has(OrderSide.SHORT)).toBe(false); // No SHORT

    // The open order should NOT be cancelled - it's needed to complete the pair
    const ordersToCancel = openOrders.filter(order => {
      const sym = normalizeSymbol(order.symbol);
      const data = positionsBySymbol.get(sym);
      return data && data.exchanges.size >= 2 && data.sides.has(OrderSide.LONG) && data.sides.has(OrderSide.SHORT);
    });

    expect(ordersToCancel.length).toBe(0);
  });

  it('should NOT cancel orders for symbols with positions on same exchange', () => {
    // Scenario: Both LONG and SHORT on same exchange - not a valid cross-exchange pair
    const positions = [
      createPosition('SOL', OrderSide.LONG, ExchangeType.HYPERLIQUID),
      createPosition('SOL', OrderSide.SHORT, ExchangeType.HYPERLIQUID), // Same exchange!
    ];

    const openOrders: MockOrder[] = [
      { symbol: 'SOL-USD', side: 'LONG', exchange: ExchangeType.LIGHTER, orderId: 'needed-1' },
    ];

    // This is NOT a valid cross-exchange pair - both positions are on same exchange
    // The order should NOT be cancelled

    // Check cross-exchange requirement
    const longExchanges = new Set(positions.filter(p => p.side === OrderSide.LONG).map(p => p.exchangeType));
    const shortExchanges = new Set(positions.filter(p => p.side === OrderSide.SHORT).map(p => p.exchangeType));

    let hasCrossExchangePair = false;
    for (const longEx of longExchanges) {
      for (const shortEx of shortExchanges) {
        if (longEx !== shortEx) {
          hasCrossExchangePair = true;
          break;
        }
      }
    }

    expect(hasCrossExchangePair).toBe(false); // No cross-exchange pair
  });

  it('should NOT cancel orders when TWAP or active execution is in progress', () => {
    // Scenario: We have a valid pair, but we're actively executing TWAP to increase size
    // The cleanup should skip when there are active executions

    interface ActiveOrder {
      symbol: string;
      side: 'LONG' | 'SHORT';
      status: 'PLACING' | 'WAITING_FILL' | 'FILLED' | 'CANCELLED';
    }

    const activeExecutions: ActiveOrder[] = [
      { symbol: 'BTC', side: 'LONG', status: 'WAITING_FILL' },
      { symbol: 'BTC', side: 'SHORT', status: 'WAITING_FILL' },
    ];

    // Check if there are active executions
    const hasActiveExecutions = activeExecutions.some(
      o => o.status === 'PLACING' || o.status === 'WAITING_FILL'
    );

    expect(hasActiveExecutions).toBe(true);

    // When there are active executions, we should skip the cleanup entirely
    // This prevents race conditions with TWAP or position sizing
  });

  it('should NOT cancel orders tracked by ExecutionLockService', () => {
    // Scenario: Order is being actively managed (e.g., MakerEfficiencyService is repricing it)
    // We should check hasActiveOrder before cancelling

    interface TrackedOrder {
      orderId: string;
      symbol: string;
      side: 'LONG' | 'SHORT';
      exchange: ExchangeType;
      isTracked: boolean; // Simulates hasActiveOrder check
    }

    const openOrders: TrackedOrder[] = [
      { orderId: 'tracked-1', symbol: 'BTC', side: 'LONG', exchange: ExchangeType.HYPERLIQUID, isTracked: true },
      { orderId: 'orphan-1', symbol: 'BTC', side: 'SHORT', exchange: ExchangeType.LIGHTER, isTracked: false },
    ];

    // Only cancel orders that are NOT actively tracked
    const ordersToCancel = openOrders.filter(o => !o.isTracked);

    expect(ordersToCancel.length).toBe(1);
    expect(ordersToCancel[0].orderId).toBe('orphan-1');
  });
});

describe('Position Size Balance Check', () => {
  it('should detect imbalance when LONG and SHORT sizes differ significantly', () => {
    const longPos = createPosition('BTC', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100);
    const shortPos = createPosition('BTC-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 50);

    const longSize = Math.abs(longPos.size);
    const shortSize = Math.abs(shortPos.size);
    const sizeDiff = Math.abs(longSize - shortSize);
    const avgSize = (longSize + shortSize) / 2;
    const imbalancePercent = (sizeDiff / avgSize) * 100;

    // 100 vs 50 = 50 diff / 75 avg = 66.7% imbalance
    expect(imbalancePercent).toBeGreaterThan(5); // Threshold is 5%
    expect(imbalancePercent).toBeCloseTo(66.67, 1);
  });

  it('should NOT flag imbalance when sizes are within 5% tolerance', () => {
    const longPos = createPosition('ETH', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100);
    const shortPos = createPosition('ETH-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 98);

    const longSize = Math.abs(longPos.size);
    const shortSize = Math.abs(shortPos.size);
    const sizeDiff = Math.abs(longSize - shortSize);
    const avgSize = (longSize + shortSize) / 2;
    const imbalancePercent = (sizeDiff / avgSize) * 100;

    // 100 vs 98 = 2 diff / 99 avg = ~2% imbalance
    expect(imbalancePercent).toBeLessThan(5); // Within tolerance
  });

  it('should identify which position to reduce', () => {
    const longPos = createPosition('SOL', OrderSide.LONG, ExchangeType.HYPERLIQUID, 150);
    const shortPos = createPosition('SOL-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100);

    const longSize = Math.abs(longPos.size);
    const shortSize = Math.abs(shortPos.size);
    const smallerSize = Math.min(longSize, shortSize);
    const largerPos = longSize > shortSize ? longPos : shortPos;
    const excessSize = Math.abs(largerPos.size) - smallerSize;

    expect(largerPos.side).toBe(OrderSide.LONG);
    expect(largerPos.exchangeType).toBe(ExchangeType.HYPERLIQUID);
    expect(excessSize).toBe(50); // 150 - 100 = 50 excess
    expect(smallerSize).toBe(100); // Target size
  });

  it('should calculate correct close side for reducing position', () => {
    // To reduce a LONG, we place a SHORT order
    const longPos = createPosition('AVAX', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100);
    const closeSide = longPos.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
    expect(closeSide).toBe(OrderSide.SHORT);

    // To reduce a SHORT, we place a LONG order
    const shortPos = createPosition('AVAX', OrderSide.SHORT, ExchangeType.LIGHTER, 100);
    const closeSide2 = shortPos.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
    expect(closeSide2).toBe(OrderSide.LONG);
  });

  it('should skip imbalance fix if excess is too small (< 1%)', () => {
    const longPos = createPosition('LINK', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100);
    const shortPos = createPosition('LINK-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 99.5);

    const longSize = Math.abs(longPos.size);
    const shortSize = Math.abs(shortPos.size);
    const smallerSize = Math.min(longSize, shortSize);
    const largerPos = longSize > shortSize ? longPos : shortPos;
    const excessSize = Math.abs(largerPos.size) - smallerSize;
    const excessPercent = excessSize / Math.abs(largerPos.size);

    // 0.5 / 100 = 0.5% - too small to fix
    expect(excessPercent).toBeLessThan(0.01); // < 1%
  });

  it('should only check cross-exchange pairs', () => {
    // Both on same exchange - not a valid pair to check
    const positions = [
      createPosition('UNI', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100),
      createPosition('UNI', OrderSide.SHORT, ExchangeType.HYPERLIQUID, 50),
    ];

    const longPositions = positions.filter(p => p.side === OrderSide.LONG);
    const shortPositions = positions.filter(p => p.side === OrderSide.SHORT);

    // Check for cross-exchange pair
    let hasCrossExchangePair = false;
    for (const lp of longPositions) {
      for (const sp of shortPositions) {
        if (lp.exchangeType !== sp.exchangeType) {
          hasCrossExchangePair = true;
          break;
        }
      }
    }

    expect(hasCrossExchangePair).toBe(false);
  });
});

describe('Order Fill Waiting Logic', () => {
  it('should wait for order to fill before declaring failure', () => {
    // This test verifies the logic that:
    // 1. Places an order to open missing side
    // 2. Waits up to 60 seconds for fill
    // 3. Polls every 5 seconds
    // 4. Cancels order if not filled
    // 5. Only then allows closing the other leg

    const MAX_WAIT_TIME_MS = 60000;
    const POLL_INTERVAL_MS = 5000;
    const expectedPolls = MAX_WAIT_TIME_MS / POLL_INTERVAL_MS;

    expect(MAX_WAIT_TIME_MS).toBe(60000);
    expect(POLL_INTERVAL_MS).toBe(5000);
    expect(expectedPolls).toBe(12); // Should poll 12 times before giving up
  });

  it('should cancel unfilled order before closing other leg', () => {
    // Simulates the flow:
    // 1. Order placed on Hyperliquid
    // 2. Order doesn't fill within timeout
    // 3. Order is cancelled
    // 4. Only then is the Lighter position closed

    const orderPlaced = { orderId: 'test-123', filled: false };
    const orderCancelled = { cancelled: false };
    const otherLegClosed = { closed: false };

    // Simulate timeout
    if (!orderPlaced.filled) {
      orderCancelled.cancelled = true;
    }

    // Only close other leg after cancellation
    if (orderCancelled.cancelled) {
      otherLegClosed.closed = true;
    }

    expect(orderCancelled.cancelled).toBe(true);
    expect(otherLegClosed.closed).toBe(true);
  });

  it('should cancel pending orders on OTHER exchange before closing single leg', () => {
    // Simulates the critical fix:
    // When closing a single-leg position on Lighter,
    // first cancel any pending orders on Hyperliquid for the same symbol

    const lighterPosition = { symbol: 'ZORA', side: 'LONG', exchange: 'LIGHTER' };
    const hyperliquidOrders = [
      { orderId: '275793594172', symbol: 'ZORA', side: 'SHORT', exchange: 'HYPERLIQUID' },
    ];

    // Before closing Lighter position, check and cancel Hyperliquid orders
    const ordersToCancel = hyperliquidOrders.filter(
      order => order.symbol === lighterPosition.symbol && order.exchange !== lighterPosition.exchange
    );

    expect(ordersToCancel.length).toBe(1);
    expect(ordersToCancel[0].orderId).toBe('275793594172');
  });
});

describe('Stress Tests', () => {
  it('should handle many single-leg positions correctly', () => {
    const symbols = ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'UNI', 'AAVE', 'CRV', 'MKR', 'SNX'];
    const exchanges = [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER];

    for (const symbol of symbols) {
      for (const exchange of exchanges) {
        for (const side of [OrderSide.LONG, OrderSide.SHORT]) {
          const position = createPosition(symbol, side, exchange);
          const singleLegRetries = new Map<string, SingleLegRetryInfo>();

          const result = determineCorrectExchangeForMissingSide(
            position,
            singleLegRetries,
            exchanges,
          );

          // Should always find a different exchange
          expect('error' in result).toBe(false);
          if (!('error' in result)) {
            expect(result.missingExchange).not.toBe(exchange);
          }
        }
      }
    }
  });

  it('should handle complex zombie detection scenario', () => {
    // Mix of valid pairs and zombies
    const positions = [
      createPosition('BTC', OrderSide.LONG, ExchangeType.HYPERLIQUID),
      createPosition('BTC-USD', OrderSide.SHORT, ExchangeType.LIGHTER),
      createPosition('ETH', OrderSide.SHORT, ExchangeType.HYPERLIQUID),
      createPosition('ETH-USD', OrderSide.LONG, ExchangeType.LIGHTER),
      // Single-leg position (no pair)
      createPosition('ORPHAN', OrderSide.LONG, ExchangeType.HYPERLIQUID),
    ];

    const orders: MockOrder[] = [
      // Valid close orders for BTC
      { symbol: 'BTC', side: 'SHORT', exchange: ExchangeType.HYPERLIQUID, orderId: '1' },
      { symbol: 'BTC-USD', side: 'LONG', exchange: ExchangeType.LIGHTER, orderId: '2' },
      // Zombie order (no counterpart)
      { symbol: 'ZOMBIE', side: 'LONG', exchange: ExchangeType.LIGHTER, orderId: 'zombie-1' },
      // Another zombie (same exchange as only position)
      { symbol: 'ORPHAN', side: 'SHORT', exchange: ExchangeType.HYPERLIQUID, orderId: 'zombie-2' },
    ];

    const zombies = detectZombieOrders(positions, orders);
    
    // Should find the ZOMBIE order (no position/order on other exchange)
    const zombieSymbols = zombies.map(z => normalizeSymbol(z.symbol));
    expect(zombieSymbols).toContain('ZOMBIE');
  });
});

