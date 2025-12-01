export interface IBlockchainAdapter {
  getStrategyState(strategyAddress: string): Promise<{ totalAssets: bigint; totalPrincipal: bigint }>;
  getGasPriceGwei(): Promise<number>;
  getStrategyPositionRange(strategyAddress: string): Promise<{ lower: number; upper: number } | null>;
}


