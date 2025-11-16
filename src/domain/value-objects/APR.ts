export class APR {
  private constructor(private readonly _value: number) {}

  static create(value: number): APR {
    return new APR(value);
  }

  static fromDecimal(decimal: number): APR {
    return new APR(decimal * 100);
  }

  static zero(): APR {
    return new APR(0);
  }

  get value(): number {
    return this._value;
  }

  toDecimal(): number {
    return this._value / 100;
  }

  periodReturn(periodsPerYear: number): number {
    return this.toDecimal() / periodsPerYear;
  }

  add(other: APR): APR {
    return APR.create(this._value + other._value);
  }

  subtract(other: APR): APR {
    return APR.create(this._value - other._value);
  }

  equals(other: APR): boolean {
    return this._value === other._value;
  }
}

