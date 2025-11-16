export class Delta {
  private constructor(private readonly _value: number) {}

  static create(value: number): Delta {
    return new Delta(value);
  }

  static zero(): Delta {
    return new Delta(0);
  }

  get value(): number {
    return this._value;
  }

  add(other: Delta): Delta {
    return Delta.create(this._value + other._value);
  }

  subtract(other: Delta): Delta {
    return Delta.create(this._value - other._value);
  }

  isNeutral(tolerance: number = 0.01): boolean {
    return Math.abs(this._value) <= tolerance;
  }

  equals(other: Delta): boolean {
    return Math.abs(this._value - other._value) < 0.0001;
  }
}

