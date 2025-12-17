export class DriftVelocity {
  constructor(public readonly value: number) {
    // Value is typically annualized log return
  }

  // FIXED: Clamp to reasonable maximum (20% annual, not 500%!)
  // The previous 5.0 (500%) was causing the optimizer to choose absurdly wide ranges
  // Most crypto assets have <20% annual drift in practice
  get clampedValue(): number {
    return Math.min(0.2, Math.abs(this.value)) * Math.sign(this.value); // Cap at 20% annual
  }
}
