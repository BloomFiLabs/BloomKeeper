import { PerpOrderRequest, PerpOrderResponse, OrderSide, OrderType, OrderStatus, TimeInForce } from './PerpOrder';

describe('PerpOrderRequest', () => {
  it('should create a valid market order', () => {
    const request = new PerpOrderRequest(
      'ETHUSDT',
      OrderSide.LONG,
      OrderType.MARKET,
      1.0,
    );

    expect(request.symbol).toBe('ETHUSDT');
    expect(request.side).toBe(OrderSide.LONG);
    expect(request.type).toBe(OrderType.MARKET);
    expect(request.size).toBe(1.0);
    expect(request.isMarketOrder()).toBe(true);
    expect(request.isLimitOrder()).toBe(false);
    expect(request.isOpeningOrder()).toBe(true);
  });

  it('should create a valid limit order', () => {
    const request = new PerpOrderRequest(
      'BTCUSDT',
      OrderSide.SHORT,
      OrderType.LIMIT,
      0.5,
      50000,
      TimeInForce.GTC,
    );

    expect(request.price).toBe(50000);
    expect(request.timeInForce).toBe(TimeInForce.GTC);
    expect(request.isLimitOrder()).toBe(true);
  });

  it('should throw error for invalid size', () => {
    expect(() => {
      new PerpOrderRequest('ETHUSDT', OrderSide.LONG, OrderType.MARKET, 0);
    }).toThrow('Order size must be greater than 0');
  });

  it('should throw error for limit order without price', () => {
    expect(() => {
      new PerpOrderRequest('ETHUSDT', OrderSide.LONG, OrderType.LIMIT, 1.0);
    }).toThrow('Limit price is required for LIMIT orders');
  });

  it('should throw error for stop-loss without stop price', () => {
    expect(() => {
      new PerpOrderRequest('ETHUSDT', OrderSide.LONG, OrderType.STOP_LOSS, 1.0);
    }).toThrow('Stop price is required for STOP_LOSS and TAKE_PROFIT orders');
  });

  it('should identify closing orders', () => {
    const request = new PerpOrderRequest(
      'ETHUSDT',
      OrderSide.SHORT,
      OrderType.MARKET,
      1.0,
      undefined,
      undefined,
      true, // reduceOnly
    );

    expect(request.isClosingOrder()).toBe(true);
    expect(request.isOpeningOrder()).toBe(false);
  });
});

describe('PerpOrderResponse', () => {
  it('should create a successful response', () => {
    const response = new PerpOrderResponse(
      'order123',
      OrderStatus.FILLED,
      'ETHUSDT',
      OrderSide.LONG,
      undefined,
      1.0,
      3000.0,
      undefined,
      new Date(),
    );

    expect(response.isSuccess()).toBe(true);
    expect(response.isFilled()).toBe(true);
    expect(response.isActive()).toBe(false);
  });

  it('should identify rejected orders', () => {
    const response = new PerpOrderResponse(
      'order456',
      OrderStatus.REJECTED,
      'BTCUSDT',
      OrderSide.SHORT,
      undefined,
      undefined,
      undefined,
      'Insufficient balance',
      new Date(),
    );

    expect(response.isSuccess()).toBe(false);
    expect(response.error).toBe('Insufficient balance');
  });

  it('should identify active orders', () => {
    const response = new PerpOrderResponse(
      'order789',
      OrderStatus.PARTIALLY_FILLED,
      'ETHUSDT',
      OrderSide.LONG,
      undefined,
      0.5,
      3000.0,
      undefined,
      new Date(),
    );

    expect(response.isActive()).toBe(true);
    expect(response.filledSize).toBe(0.5);
  });
});


