export class Price {
  private constructor(private readonly _value: number) {
    if (_value <= 0) {
      throw new Error('Price must be positive');
    }
  }

  static create(value: number): Price {
    return new Price(value);
  }

  get value(): number {
    return this._value;
  }

  equals(other: Price): boolean {
    return this._value === other._value;
  }

  percentageChange(other: Price): number {
    return ((other._value - this._value) / this._value) * 100;
  }

  multiply(factor: number): Price {
    return Price.create(this._value * factor);
  }

  divide(divisor: number): Price {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return Price.create(this._value / divisor);
  }
}

