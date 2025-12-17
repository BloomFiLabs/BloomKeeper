export class HurstExponent {
  constructor(public readonly value: number) {
    if (value < 0 || value > 1) {
      throw new Error('Hurst Exponent must be between 0 and 1');
    }
  }

  isTrending(): boolean {
    return this.value > 0.55;
  }

  isMeanReverting(): boolean {
    return this.value < 0.45;
  }
}
