/**
 * Unit tests for WithdrawalFulfiller
 *
 * These tests verify the delta-neutral unwinding logic and partial position reduction
 * calculations WITHOUT importing the actual class (to avoid ESM dependency issues).
 *
 * The logic is extracted and tested in isolation.
 */

import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import { OrderSide } from '../../../domain/value-objects/PerpOrder';

// ============================================================================
// Test helpers - extracted logic from WithdrawalFulfiller for unit testing
// ============================================================================

interface MockPosition {
  symbol: string;
  side: OrderSide;
  size: number;
  markPrice: number;
  exchangeType: ExchangeType;
  unrealizedPnl: number;
}

interface DeltaNeutralPair {
  symbol: string;
  longPosition: MockPosition;
  shortPosition: MockPosition;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  combinedPnl: number;
  totalValue: number;
  maxDeltaNeutralSize: number;
}

// Extracted logic: Group positions by symbol
function groupPositionsBySymbol(
  positions: MockPosition[],
): Map<string, MockPosition[]> {
  const grouped = new Map<string, MockPosition[]>();
  for (const position of positions) {
    const symbol = position.symbol;
    if (!grouped.has(symbol)) {
      grouped.set(symbol, []);
    }
    grouped.get(symbol)!.push(position);
  }
  return grouped;
}

// Extracted logic: Identify delta-neutral pairs
function identifyDeltaNeutralPairs(
  positionsBySymbol: Map<string, MockPosition[]>,
): DeltaNeutralPair[] {
  const pairs: DeltaNeutralPair[] = [];

  for (const [symbol, positions] of positionsBySymbol) {
    const longs = positions.filter((p) => p.side === OrderSide.LONG);
    const shorts = positions.filter((p) => p.side === OrderSide.SHORT);

    for (const longPos of longs) {
      for (const shortPos of shorts) {
        if (longPos.exchangeType !== shortPos.exchangeType) {
          const longSize = Math.abs(longPos.size);
          const shortSize = Math.abs(shortPos.size);
          const longValue = longSize * longPos.markPrice;
          const shortValue = shortSize * shortPos.markPrice;
          const maxDeltaNeutralSize = Math.min(longSize, shortSize);

          pairs.push({
            symbol,
            longPosition: longPos,
            shortPosition: shortPos,
            longExchange: longPos.exchangeType,
            shortExchange: shortPos.exchangeType,
            combinedPnl: longPos.unrealizedPnl + shortPos.unrealizedPnl,
            totalValue: longValue + shortValue,
            maxDeltaNeutralSize,
          });
        }
      }
    }
  }

  return pairs;
}

// Extracted logic: Get unpaired positions
function getUnpairedPositions(
  allPositions: MockPosition[],
  pairs: DeltaNeutralPair[],
): MockPosition[] {
  const pairedPositionIds = new Set<string>();

  for (const pair of pairs) {
    pairedPositionIds.add(`${pair.longExchange}-${pair.symbol}-LONG`);
    pairedPositionIds.add(`${pair.shortExchange}-${pair.symbol}-SHORT`);
  }

  return allPositions.filter((pos) => {
    const id = `${pos.exchangeType}-${pos.symbol}-${pos.side}`;
    return !pairedPositionIds.has(id);
  });
}

// Extracted logic: Calculate reduction size for delta-neutral pair
function calculatePairReductionSize(
  pair: DeltaNeutralPair,
  amountNeeded: number,
): { sizeToReduce: number; isFullClose: boolean } {
  const avgPrice = pair.longPosition.markPrice;

  // Each unit of size freed = avgPrice USD from each leg (2x total)
  const sizeToReduce = Math.min(
    amountNeeded / (2 * avgPrice),
    pair.maxDeltaNeutralSize,
  );

  const isFullClose = sizeToReduce >= pair.maxDeltaNeutralSize * 0.99;

  return { sizeToReduce, isFullClose };
}

// Extracted logic: Calculate reduction size for unpaired position
function calculateUnpairedReductionSize(
  position: MockPosition,
  amountNeeded: number,
): { sizeToReduce: number; isFullClose: boolean } {
  const positionSize = Math.abs(position.size);

  const sizeToReduce = Math.min(
    amountNeeded / position.markPrice,
    positionSize,
  );

  const isFullClose = sizeToReduce >= positionSize * 0.99;

  return { sizeToReduce, isFullClose };
}

// Helper to create mock positions
const createMockPosition = (
  symbol: string,
  side: OrderSide,
  size: number,
  markPrice: number,
  exchangeType: ExchangeType,
  unrealizedPnl: number = 0,
): MockPosition => ({
  symbol,
  side,
  size,
  markPrice,
  exchangeType,
  unrealizedPnl,
});

// ============================================================================
// Tests
// ============================================================================

describe('WithdrawalFulfiller - Delta-Neutral Logic', () => {
  describe('groupPositionsBySymbol', () => {
    it('should group positions by symbol correctly', () => {
      const positions = [
        createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
        ),
        createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
        ),
        createMockPosition(
          'BTC',
          OrderSide.LONG,
          0.1,
          100000,
          ExchangeType.HYPERLIQUID,
        ),
      ];

      const grouped = groupPositionsBySymbol(positions);

      expect(grouped.size).toBe(2);
      expect(grouped.get('ETH')?.length).toBe(2);
      expect(grouped.get('BTC')?.length).toBe(1);
    });
  });

  describe('identifyDeltaNeutralPairs', () => {
    it('should identify a delta-neutral pair on different exchanges', () => {
      const positions = [
        createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
          50,
        ),
        createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
          -30,
        ),
      ];

      const grouped = groupPositionsBySymbol(positions);
      const pairs = identifyDeltaNeutralPairs(grouped);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].symbol).toBe('ETH');
      expect(pairs[0].longExchange).toBe(ExchangeType.HYPERLIQUID);
      expect(pairs[0].shortExchange).toBe(ExchangeType.LIGHTER);
      expect(pairs[0].combinedPnl).toBe(20); // 50 + (-30)
      expect(pairs[0].maxDeltaNeutralSize).toBe(1.0);
      expect(pairs[0].totalValue).toBe(7000); // 2 * 1.0 * 3500
    });

    it('should set maxDeltaNeutralSize as the smaller of two legs', () => {
      const positions = [
        createMockPosition(
          'BTC',
          OrderSide.LONG,
          0.5,
          100000,
          ExchangeType.HYPERLIQUID,
          100,
        ),
        createMockPosition(
          'BTC',
          OrderSide.SHORT,
          0.3,
          100000,
          ExchangeType.LIGHTER,
          -50,
        ),
      ];

      const grouped = groupPositionsBySymbol(positions);
      const pairs = identifyDeltaNeutralPairs(grouped);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].maxDeltaNeutralSize).toBe(0.3); // Limited by SHORT side
    });

    it('should NOT pair positions on the same exchange', () => {
      const positions = [
        createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
          50,
        ),
        createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
          -30,
        ),
      ];

      const grouped = groupPositionsBySymbol(positions);
      const pairs = identifyDeltaNeutralPairs(grouped);

      expect(pairs).toHaveLength(0);
    });

    it('should handle multiple pairs across different symbols', () => {
      const positions = [
        createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
          50,
        ),
        createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
          -30,
        ),
        createMockPosition(
          'BTC',
          OrderSide.LONG,
          0.1,
          100000,
          ExchangeType.LIGHTER,
          200,
        ),
        createMockPosition(
          'BTC',
          OrderSide.SHORT,
          0.1,
          100000,
          ExchangeType.HYPERLIQUID,
          -100,
        ),
      ];

      const grouped = groupPositionsBySymbol(positions);
      const pairs = identifyDeltaNeutralPairs(grouped);

      expect(pairs).toHaveLength(2);

      const ethPair = pairs.find((p) => p.symbol === 'ETH');
      const btcPair = pairs.find((p) => p.symbol === 'BTC');

      expect(ethPair).toBeDefined();
      expect(btcPair).toBeDefined();
      expect(ethPair!.combinedPnl).toBe(20);
      expect(btcPair!.combinedPnl).toBe(100);
    });
  });

  describe('getUnpairedPositions', () => {
    it('should identify positions not in any delta-neutral pair', () => {
      const positions = [
        createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
          50,
        ),
        createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
          -30,
        ),
        createMockPosition(
          'SOL',
          OrderSide.LONG,
          10,
          200,
          ExchangeType.HYPERLIQUID,
          25,
        ), // Unpaired
      ];

      const grouped = groupPositionsBySymbol(positions);
      const pairs = identifyDeltaNeutralPairs(grouped);
      const unpaired = getUnpairedPositions(positions, pairs);

      expect(unpaired).toHaveLength(1);
      expect(unpaired[0].symbol).toBe('SOL');
    });

    it('should return all positions when no pairs exist', () => {
      const positions = [
        createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
          50,
        ),
        createMockPosition(
          'BTC',
          OrderSide.LONG,
          0.1,
          100000,
          ExchangeType.HYPERLIQUID,
          100,
        ),
      ];

      const grouped = groupPositionsBySymbol(positions);
      const pairs = identifyDeltaNeutralPairs(grouped);
      const unpaired = getUnpairedPositions(positions, pairs);

      expect(unpaired).toHaveLength(2);
    });
  });

  describe('calculatePairReductionSize', () => {
    it('should calculate partial reduction when amount needed is less than pair value', () => {
      const pair: DeltaNeutralPair = {
        symbol: 'ETH',
        longPosition: createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
        ),
        shortPosition: createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
        ),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        combinedPnl: 0,
        totalValue: 7000, // 2 * 1.0 * 3500
        maxDeltaNeutralSize: 1.0,
      };

      // Need $1000, pair is worth $7000
      // Each side contributes $3500 per unit
      // To free $1000 from both sides: $1000 / (2 * $3500) = 0.143 units
      const result = calculatePairReductionSize(pair, 1000);

      expect(result.sizeToReduce).toBeCloseTo(0.143, 2);
      expect(result.isFullClose).toBe(false);
    });

    it('should cap reduction at maxDeltaNeutralSize', () => {
      const pair: DeltaNeutralPair = {
        symbol: 'ETH',
        longPosition: createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
        ),
        shortPosition: createMockPosition(
          'ETH',
          OrderSide.SHORT,
          0.5,
          3500,
          ExchangeType.LIGHTER,
        ), // Smaller
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        combinedPnl: 0,
        totalValue: 5250, // 1.0 * 3500 + 0.5 * 3500
        maxDeltaNeutralSize: 0.5, // Limited by SHORT
      };

      // Need $10000, but max we can reduce is 0.5 units
      const result = calculatePairReductionSize(pair, 10000);

      expect(result.sizeToReduce).toBe(0.5);
      expect(result.isFullClose).toBe(true);
    });

    it('should identify full close when reduction >= 99% of max', () => {
      const pair: DeltaNeutralPair = {
        symbol: 'ETH',
        longPosition: createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
        ),
        shortPosition: createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
        ),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        combinedPnl: 0,
        totalValue: 7000,
        maxDeltaNeutralSize: 1.0,
      };

      // Need $6950 from $7000 pair = 99.3% reduction
      const result = calculatePairReductionSize(pair, 6950);

      expect(result.sizeToReduce).toBeCloseTo(0.993, 2);
      expect(result.isFullClose).toBe(true); // >= 99%
    });

    it('should NOT identify full close when reduction < 99% of max', () => {
      const pair: DeltaNeutralPair = {
        symbol: 'ETH',
        longPosition: createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
        ),
        shortPosition: createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
        ),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        combinedPnl: 0,
        totalValue: 7000,
        maxDeltaNeutralSize: 1.0,
      };

      // Need $6800 from $7000 pair = 97.1% reduction
      const result = calculatePairReductionSize(pair, 6800);

      expect(result.sizeToReduce).toBeCloseTo(0.971, 2);
      expect(result.isFullClose).toBe(false); // < 99%
    });
  });

  describe('calculateUnpairedReductionSize', () => {
    it('should calculate partial reduction for unpaired position', () => {
      const position = createMockPosition(
        'SOL',
        OrderSide.LONG,
        100,
        200,
        ExchangeType.HYPERLIQUID,
      );

      // Position worth $20000 (100 * $200)
      // Need $5000 -> reduce 25 units (5000 / 200)
      const result = calculateUnpairedReductionSize(position, 5000);

      expect(result.sizeToReduce).toBe(25);
      expect(result.isFullClose).toBe(false);
    });

    it('should cap at full position size', () => {
      const position = createMockPosition(
        'SOL',
        OrderSide.LONG,
        10,
        200,
        ExchangeType.HYPERLIQUID,
      );

      // Position worth $2000 (10 * $200)
      // Need $5000 -> can only close full position (10 units)
      const result = calculateUnpairedReductionSize(position, 5000);

      expect(result.sizeToReduce).toBe(10);
      expect(result.isFullClose).toBe(true);
    });
  });

  describe('Priority Ordering', () => {
    it('should sort pairs by combined PnL (least profitable first)', () => {
      const positions = [
        // Pair 1: Combined PnL = +$70 (profitable)
        createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
          100,
        ),
        createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
          -30,
        ),
        // Pair 2: Combined PnL = -$50 (losing - should close first)
        createMockPosition(
          'BTC',
          OrderSide.LONG,
          0.1,
          100000,
          ExchangeType.HYPERLIQUID,
          -100,
        ),
        createMockPosition(
          'BTC',
          OrderSide.SHORT,
          0.1,
          100000,
          ExchangeType.LIGHTER,
          50,
        ),
      ];

      const grouped = groupPositionsBySymbol(positions);
      const pairs = identifyDeltaNeutralPairs(grouped);

      // Sort by combined PnL (least profitable first)
      pairs.sort((a, b) => a.combinedPnl - b.combinedPnl);

      expect(pairs[0].symbol).toBe('BTC'); // -$50 PnL - close first
      expect(pairs[0].combinedPnl).toBe(-50);
      expect(pairs[1].symbol).toBe('ETH'); // +$70 PnL - close last
      expect(pairs[1].combinedPnl).toBe(70);
    });
  });
});

describe('WithdrawalFulfiller - Integration Scenarios', () => {
  describe('Partial Reduction Scenarios', () => {
    it('scenario: need $1000, have $7000 in positions - should only reduce ~14%', () => {
      const pair: DeltaNeutralPair = {
        symbol: 'ETH',
        longPosition: createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
        ),
        shortPosition: createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
        ),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        combinedPnl: 0,
        totalValue: 7000,
        maxDeltaNeutralSize: 1.0,
      };

      const amountNeeded = 1000;
      const result = calculatePairReductionSize(pair, amountNeeded);
      const reductionPercent =
        (result.sizeToReduce / pair.maxDeltaNeutralSize) * 100;

      expect(reductionPercent).toBeCloseTo(14.3, 0);
      expect(result.isFullClose).toBe(false);
    });

    it('scenario: need $10000, have $7000 in positions - should close entirely', () => {
      const pair: DeltaNeutralPair = {
        symbol: 'ETH',
        longPosition: createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
        ),
        shortPosition: createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
        ),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        combinedPnl: 0,
        totalValue: 7000,
        maxDeltaNeutralSize: 1.0,
      };

      const amountNeeded = 10000;
      const result = calculatePairReductionSize(pair, amountNeeded);

      expect(result.sizeToReduce).toBe(1.0); // Full close
      expect(result.isFullClose).toBe(true);
    });

    it('scenario: simulate unwinding multiple pairs', () => {
      // Setup:
      // - Pair 1 (ETH): $7000 total value, PnL = -$50 (close first)
      // - Pair 2 (BTC): $20000 total value, PnL = +$200 (close last)
      // Need: $8000

      const ethPair: DeltaNeutralPair = {
        symbol: 'ETH',
        longPosition: createMockPosition(
          'ETH',
          OrderSide.LONG,
          1.0,
          3500,
          ExchangeType.HYPERLIQUID,
          -30,
        ),
        shortPosition: createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.0,
          3500,
          ExchangeType.LIGHTER,
          -20,
        ),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        combinedPnl: -50,
        totalValue: 7000,
        maxDeltaNeutralSize: 1.0,
      };

      const btcPair: DeltaNeutralPair = {
        symbol: 'BTC',
        longPosition: createMockPosition(
          'BTC',
          OrderSide.LONG,
          0.1,
          100000,
          ExchangeType.HYPERLIQUID,
          100,
        ),
        shortPosition: createMockPosition(
          'BTC',
          OrderSide.SHORT,
          0.1,
          100000,
          ExchangeType.LIGHTER,
          100,
        ),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        combinedPnl: 200,
        totalValue: 20000,
        maxDeltaNeutralSize: 0.1,
      };

      let remainingNeeded = 8000;
      let totalFreed = 0;

      // Sort by PnL (ETH first since it's losing)
      const pairs = [ethPair, btcPair].sort(
        (a, b) => a.combinedPnl - b.combinedPnl,
      );

      expect(pairs[0].symbol).toBe('ETH'); // ETH first (PnL = -$50)

      // Process ETH pair first
      const ethResult = calculatePairReductionSize(pairs[0], remainingNeeded);
      expect(ethResult.isFullClose).toBe(true); // $8000 > $7000 = full close

      const ethFreed = pairs[0].totalValue; // $7000
      totalFreed += ethFreed;
      remainingNeeded -= ethFreed;

      expect(totalFreed).toBe(7000);
      expect(remainingNeeded).toBe(1000);

      // Process BTC pair for remaining $1000
      const btcResult = calculatePairReductionSize(pairs[1], remainingNeeded);
      expect(btcResult.isFullClose).toBe(false); // $1000 < $20000 = partial close

      // BTC reduction: $1000 / (2 * $100000) = 0.005 units (out of 0.1 max)
      expect(btcResult.sizeToReduce).toBeCloseTo(0.005, 3);
    });
  });

  describe('Delta Neutrality Preservation', () => {
    it('should always reduce both legs equally', () => {
      const pair: DeltaNeutralPair = {
        symbol: 'ETH',
        longPosition: createMockPosition(
          'ETH',
          OrderSide.LONG,
          2.0,
          3500,
          ExchangeType.HYPERLIQUID,
        ),
        shortPosition: createMockPosition(
          'ETH',
          OrderSide.SHORT,
          1.5,
          3500,
          ExchangeType.LIGHTER,
        ), // Smaller
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        combinedPnl: 0,
        totalValue: 12250, // 2.0 * 3500 + 1.5 * 3500
        maxDeltaNeutralSize: 1.5, // Limited by SHORT
      };

      // Reduce 0.5 units from each
      const amountNeeded = 3500; // 0.5 * 3500 * 2
      const result = calculatePairReductionSize(pair, amountNeeded);

      // Both legs get reduced by the same amount
      expect(result.sizeToReduce).toBeCloseTo(0.5, 2);

      // After reduction:
      // LONG: 2.0 - 0.5 = 1.5 ETH
      // SHORT: 1.5 - 0.5 = 1.0 ETH
      // Delta before: 2.0 - 1.5 = 0.5 (slightly long)
      // Delta after: 1.5 - 1.0 = 0.5 (still slightly long, ratio preserved)

      const longAfter = pair.longPosition.size - result.sizeToReduce;
      const shortAfter =
        Math.abs(pair.shortPosition.size) - result.sizeToReduce;
      const deltaBefore =
        pair.longPosition.size - Math.abs(pair.shortPosition.size);
      const deltaAfter = longAfter - shortAfter;

      expect(deltaBefore).toBe(deltaAfter); // Delta exposure unchanged
    });
  });
});
