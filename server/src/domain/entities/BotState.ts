import { Volatility } from '../value-objects/Volatility';
import { HurstExponent } from '../value-objects/HurstExponent';

export class BotState {
  constructor(
    public readonly id: string, // Could be pool address or UUID
    public readonly poolId: string,
    public priceLower: number,
    public priceUpper: number,
    public lastRebalancePrice: number,
    public lastRebalanceAt: Date,
    public currentVolatility?: Volatility,
    public currentHurst?: HurstExponent,
    public isActive: boolean = true,
  ) {}

  updateMetrics(volatility: Volatility, hurst: HurstExponent) {
    this.currentVolatility = volatility;
    this.currentHurst = hurst;
  }

  rebalance(newLower: number, newUpper: number, price: number) {
    this.priceLower = newLower;
    this.priceUpper = newUpper;
    this.lastRebalancePrice = price;
    this.lastRebalanceAt = new Date();
  }
}
