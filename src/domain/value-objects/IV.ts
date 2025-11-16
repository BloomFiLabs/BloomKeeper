export class IV {
  private constructor(private readonly _value: number) {
    if (_value < 0 || _value > 1000) {
      throw new Error('IV must be between 0 and 1000');
    }
  }

  static create(value: number): IV {
    return new IV(value);
  }

  get value(): number {
    return this._value;
  }

  toDecimal(): number {
    return this._value / 100;
  }

  isLow(threshold: number = 30): boolean {
    return this._value < threshold;
  }

  isMid(lowThreshold: number = 30, highThreshold: number = 70): boolean {
    return this._value >= lowThreshold && this._value <= highThreshold;
  }

  isHigh(threshold: number = 70): boolean {
    return this._value > threshold;
  }

  equals(other: IV): boolean {
    return this._value === other._value;
  }
}

