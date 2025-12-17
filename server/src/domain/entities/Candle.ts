export class Candle {
  constructor(
    public readonly timestamp: Date,
    public readonly open: number,
    public readonly high: number,
    public readonly low: number,
    public readonly close: number,
    public readonly volume: number,
  ) {}
}
