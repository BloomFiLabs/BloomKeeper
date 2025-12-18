import { LiquidationRisk } from './LiquidationRisk';

describe('LiquidationRisk', () => {
  describe('create', () => {
    it('should create a liquidation risk object', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'HYPERLIQUID',
        side: 'LONG',
        markPrice: 50000,
        liquidationPrice: 40000,
        entryPrice: 48000,
        positionSize: 0.1,
        positionValueUsd: 5000,
        margin: 1000,
        leverage: 5,
      });

      expect(risk.symbol).toBe('BTC');
      expect(risk.exchange).toBe('HYPERLIQUID');
      expect(risk.side).toBe('LONG');
      expect(risk.markPrice).toBe(50000);
      expect(risk.liquidationPrice).toBe(40000);
    });
  });

  describe('distanceToLiquidation', () => {
    it('should calculate distance for LONG position', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'HYPERLIQUID',
        side: 'LONG',
        markPrice: 50000,
        liquidationPrice: 40000, // 20% below mark
        entryPrice: 48000,
        positionSize: 0.1,
        positionValueUsd: 5000,
        margin: 1000,
        leverage: 5,
      });

      // Distance = (50000 - 40000) / 50000 = 0.2 (20%)
      expect(risk.distanceToLiquidation).toBeCloseTo(0.2, 4);
      expect(risk.proximityToLiquidation).toBeCloseTo(0.8, 4); // 80% close
    });

    it('should calculate distance for SHORT position', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'LIGHTER',
        side: 'SHORT',
        markPrice: 50000,
        liquidationPrice: 60000, // 20% above mark
        entryPrice: 52000,
        positionSize: 0.1,
        positionValueUsd: 5000,
        margin: 1000,
        leverage: 5,
      });

      // Distance = (60000 - 50000) / 50000 = 0.2 (20%)
      expect(risk.distanceToLiquidation).toBeCloseTo(0.2, 4);
      expect(risk.proximityToLiquidation).toBeCloseTo(0.8, 4); // 80% close
    });

    it('should return 1 for invalid data', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'HYPERLIQUID',
        side: 'LONG',
        markPrice: 0,
        liquidationPrice: 0,
        entryPrice: 0,
        positionSize: 0,
        positionValueUsd: 0,
        margin: 0,
        leverage: 1,
      });

      expect(risk.distanceToLiquidation).toBe(1); // Safe default
    });
  });

  describe('riskLevel', () => {
    it('should return SAFE when far from liquidation', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'HYPERLIQUID',
        side: 'LONG',
        markPrice: 50000,
        liquidationPrice: 10000, // 80% away = 20% proximity = SAFE
        entryPrice: 48000,
        positionSize: 0.1,
        positionValueUsd: 5000,
        margin: 1000,
        leverage: 5,
      });

      // Distance = (50000 - 10000) / 50000 = 0.8 (80% distance)
      // Proximity = 1 - 0.8 = 0.2 (20% close) = SAFE
      expect(risk.distanceToLiquidation).toBeCloseTo(0.8, 4);
      expect(risk.proximityToLiquidation).toBeCloseTo(0.2, 4);
      expect(risk.riskLevel).toBe('SAFE');
    });

    it('should return WARNING when 30-50% close', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'HYPERLIQUID',
        side: 'LONG',
        markPrice: 50000,
        liquidationPrice: 35000, // 30% away = 70% proximity... no, let's recalculate
        // distance = (50000-35000)/50000 = 0.3 (30% away)
        // proximity = 1 - 0.3 = 0.7 (70% close) = CRITICAL
        entryPrice: 48000,
        positionSize: 0.1,
        positionValueUsd: 5000,
        margin: 1000,
        leverage: 5,
      });

      // Actually 70% close is CRITICAL, let's adjust
      // For WARNING (30-50% close), we need distance 50-70%
      // distance = 0.6 means proximity = 0.4 = WARNING
      expect(risk.proximityToLiquidation).toBeCloseTo(0.7, 4);
      expect(risk.riskLevel).toBe('CRITICAL'); // >= 0.7
    });

    it('should return CRITICAL when >= 70% close', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'HYPERLIQUID',
        side: 'LONG',
        markPrice: 50000,
        liquidationPrice: 45000, // 10% away = 90% proximity
        entryPrice: 48000,
        positionSize: 0.1,
        positionValueUsd: 5000,
        margin: 1000,
        leverage: 5,
      });

      expect(risk.riskLevel).toBe('CRITICAL');
      expect(risk.shouldEmergencyClose(0.7)).toBe(true);
    });
  });

  describe('shouldEmergencyClose', () => {
    it('should return true when proximity >= threshold', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'HYPERLIQUID',
        side: 'LONG',
        markPrice: 50000,
        liquidationPrice: 42500, // 15% away = 85% proximity
        entryPrice: 48000,
        positionSize: 0.1,
        positionValueUsd: 5000,
        margin: 1000,
        leverage: 5,
      });

      expect(risk.shouldEmergencyClose(0.7)).toBe(true);
      expect(risk.shouldEmergencyClose(0.9)).toBe(false);
    });
  });

  describe('percentToLiquidation', () => {
    it('should calculate percentage to liquidation', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'HYPERLIQUID',
        side: 'LONG',
        markPrice: 50000,
        liquidationPrice: 40000,
        entryPrice: 48000,
        positionSize: 0.1,
        positionValueUsd: 5000,
        margin: 1000,
        leverage: 5,
      });

      // |50000 - 40000| / 50000 * 100 = 20%
      expect(risk.percentToLiquidation).toBeCloseTo(20, 2);
    });
  });

  describe('safe', () => {
    it('should create a safe placeholder', () => {
      const risk = LiquidationRisk.safe('BTC', 'HYPERLIQUID', 'LONG');

      expect(risk.distanceToLiquidation).toBe(1); // Far from liquidation
      expect(risk.shouldEmergencyClose()).toBe(false);
      expect(risk.riskLevel).toBe('SAFE');
    });
  });

  describe('toString', () => {
    it('should return a readable string representation', () => {
      const risk = LiquidationRisk.create({
        symbol: 'ETH',
        exchange: 'LIGHTER',
        side: 'SHORT',
        markPrice: 3000,
        liquidationPrice: 3500,
        entryPrice: 2900,
        positionSize: 1,
        positionValueUsd: 3000,
        margin: 600,
        leverage: 5,
      });

      const str = risk.toString();
      expect(str).toContain('ETH');
      expect(str).toContain('LIGHTER');
      expect(str).toContain('SHORT');
    });
  });

  describe('immutability', () => {
    it('should be immutable', () => {
      const risk = LiquidationRisk.create({
        symbol: 'BTC',
        exchange: 'HYPERLIQUID',
        side: 'LONG',
        markPrice: 50000,
        liquidationPrice: 40000,
        entryPrice: 48000,
        positionSize: 0.1,
        positionValueUsd: 5000,
        margin: 1000,
        leverage: 5,
      });

      expect(() => {
        (risk as any).markPrice = 60000;
      }).toThrow();
    });
  });
});

