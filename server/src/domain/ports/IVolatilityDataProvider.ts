export interface IVolatilityDataProvider {
  getImpliedVolatility(asset: string): Promise<number>;
}
