export class Volatility {
  constructor(public readonly value: number) {
    if (value < 0) {
      throw new Error('Volatility cannot be negative');
    }
  }

  toString(): string {
    return `${(this.value * 100).toFixed(2)}%`;
  }
}
