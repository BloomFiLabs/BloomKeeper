export class Pool {
  constructor(
    public readonly address: string,
    public readonly token0: string,
    public readonly token1: string,
    public readonly feeTier: number,
  ) {}
}
