export class HealthFactor {
  private constructor(private readonly _value: number) {
    if (_value <= 0) {
      throw new Error('Health factor must be positive');
    }
  }

  static create(value: number): HealthFactor {
    return new HealthFactor(value);
  }

  get value(): number {
    return this._value;
  }

  isHealthy(threshold: number = 1.0): boolean {
    return this._value >= threshold;
  }

  isAtRisk(threshold: number): boolean {
    return this._value < threshold;
  }

  equals(other: HealthFactor): boolean {
    return this._value === other._value;
  }
}

