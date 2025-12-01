import { PerpPosition } from './PerpPosition';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { OrderSide } from '../value-objects/PerpOrder';

describe('PerpPosition', () => {
  it('should create a valid long position', () => {
    const position = new PerpPosition(
      ExchangeType.HYPERLIQUID,
      'ETHUSDT',
      OrderSide.LONG,
      1.0,
      3000,
      3100,
      100,
      5,
      2500,
      500,
    );

    expect(position.isLong()).toBe(true);
    expect(position.isShort()).toBe(false);
    expect(position.getPositionValue()).toBe(3100);
    expect(position.getUnrealizedPnlPercent()).toBeCloseTo(3.33, 1);
    expect(position.isProfitable()).toBe(true);
  });

  it('should create a valid short position', () => {
    const position = new PerpPosition(
      ExchangeType.ASTER,
      'BTCUSDT',
      OrderSide.SHORT,
      0.5,
      50000,
      49000,
      500,
    );

    expect(position.isShort()).toBe(true);
    expect(position.isLong()).toBe(false);
    expect(position.getPositionValue()).toBe(24500);
    expect(position.isProfitable()).toBe(true);
  });

  it('should calculate unrealized PnL percentage correctly', () => {
    const position = new PerpPosition(
      ExchangeType.LIGHTER,
      'ETHUSDT',
      OrderSide.LONG,
      1.0,
      3000,
      3000,
      0,
    );

    expect(position.getUnrealizedPnlPercent()).toBe(0);
    expect(position.isAtLoss()).toBe(false);
    expect(position.isProfitable()).toBe(false);
  });

  it('should update mark price and PnL', () => {
    const position = new PerpPosition(
      ExchangeType.HYPERLIQUID,
      'ETHUSDT',
      OrderSide.LONG,
      1.0,
      3000,
      3000,
      0,
    );

    const updated = position.updateMarkPrice(3200, 200);

    expect(updated.markPrice).toBe(3200);
    expect(updated.unrealizedPnl).toBe(200);
    expect(updated.lastUpdated).toBeDefined();
  });

  it('should throw error for invalid size', () => {
    expect(() => {
      new PerpPosition(
        ExchangeType.HYPERLIQUID,
        'ETHUSDT',
        OrderSide.LONG,
        0,
        3000,
        3000,
        0,
      );
    }).toThrow('Position size must be greater than 0');
  });

  it('should throw error for invalid entry price', () => {
    expect(() => {
      new PerpPosition(
        ExchangeType.HYPERLIQUID,
        'ETHUSDT',
        OrderSide.LONG,
        1.0,
        0,
        3000,
        0,
      );
    }).toThrow('Entry price must be greater than 0');
  });
});

