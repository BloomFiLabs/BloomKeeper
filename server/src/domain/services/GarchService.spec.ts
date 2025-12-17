import { GarchService } from './GarchService';
import { Volatility } from '../value-objects/Volatility';

describe('GarchService', () => {
  let service: GarchService;

  beforeEach(() => {
    service = new GarchService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw error for insufficient data', () => {
    const returns = Array(20).fill(0.01); // Less than 30
    expect(() => service.calculateVolatility(returns)).toThrow(
      'Insufficient data for GARCH analysis',
    );
  });

  it('should calculate volatility for sufficient data', () => {
    // Generate realistic returns (log returns)
    const returns: number[] = [];
    let price = 1000;
    for (let i = 0; i < 50; i++) {
      const change = (Math.random() - 0.5) * 0.02; // Random change up to 1%
      price = price * (1 + change);
      returns.push(Math.log(price / (price / (1 + change))));
    }

    const result = service.calculateVolatility(returns);
    expect(result).toBeInstanceOf(Volatility);
    expect(result.value).toBeGreaterThanOrEqual(0);
  });

  it('should handle high volatility periods', () => {
    // Simulate high volatility (large swings)
    const returns: number[] = [];
    for (let i = 0; i < 50; i++) {
      returns.push((Math.random() - 0.5) * 0.1); // Large swings
    }

    const result = service.calculateVolatility(returns);
    expect(result.value).toBeGreaterThan(0);
  });

  it('should handle low volatility periods', () => {
    // Simulate low volatility (small changes)
    const returns: number[] = [];
    for (let i = 0; i < 50; i++) {
      returns.push((Math.random() - 0.5) * 0.001); // Small changes
    }

    const result = service.calculateVolatility(returns);
    expect(result.value).toBeGreaterThanOrEqual(0);
  });
});
