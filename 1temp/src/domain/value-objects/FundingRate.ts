export class FundingRate {
  private constructor(private readonly _value: number) {}

  static create(value: number): FundingRate {
    return new FundingRate(value);
  }

  static fromBasisPoints(basisPoints: number): FundingRate {
    return new FundingRate(basisPoints / 10000);
  }

  get value(): number {
    return this._value;
  }

  toBasisPoints(): number {
    return this._value * 10000;
  }

  toAPR(): number {
    return this._value * 365 * 3; // Assuming 8-hour funding periods
  }

  isPositive(): boolean {
    return this._value > 0;
  }

  isNegative(): boolean {
    return this._value < 0;
  }

  equals(other: FundingRate): boolean {
    return Math.abs(this._value - other._value) < 0.0001;
  }
}

