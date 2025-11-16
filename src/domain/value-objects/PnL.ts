export class PnL {
  private constructor(private readonly _value: number) {}

  static create(value: number): PnL {
    return new PnL(value);
  }

  static zero(): PnL {
    return new PnL(0);
  }

  get value(): number {
    return this._value;
  }

  isPositive(): boolean {
    return this._value > 0;
  }

  isNegative(): boolean {
    return this._value < 0;
  }

  isZero(): boolean {
    return this._value === 0;
  }

  add(other: PnL): PnL {
    return PnL.create(this._value + other._value);
  }

  subtract(other: PnL): PnL {
    return PnL.create(this._value - other._value);
  }

  equals(other: PnL): boolean {
    return this._value === other._value;
  }
}

