/**
 * Type declarations for @reservoir0x/lighter-ts-sdk
 * This package doesn't have complete TypeScript definitions, so we provide minimal types here
 */
declare module '@reservoir0x/lighter-ts-sdk' {
  export class SignerClient {
    constructor(config: {
      url: string;
      privateKey: string;
      accountIndex: number;
      apiKeyIndex: number;
    });
    initialize(): Promise<void>;
    ensureWasmClient(): Promise<void>;
    createUnifiedOrder(params: any): Promise<any>;
    createMarketOrder(params: {
      marketIndex: number;
      clientOrderIndex: number;
      baseAmount: string;
      avgExecutionPrice: string;
      isAsk: boolean;
      reduceOnly: boolean;
    }): Promise<[any, string, any]>;
    waitForTransaction(
      txHash: string,
      timeout: number,
      interval: number,
    ): Promise<void>;
    cancelOrder(orderId: string): Promise<any>;
    cancelAllOrders(timeInForce: number, time: number): Promise<any>;
    createAuthTokenWithExpiry(expiry: number): Promise<string>;
    close(): Promise<void>;
  }

  export enum OrderType {
    LIMIT = 0,
    MARKET = 1,
    STOP_LOSS = 2,
    STOP_LOSS_LIMIT = 3,
    TAKE_PROFIT = 4,
    TAKE_PROFIT_LIMIT = 5,
    TWAP = 6,
  }

  export class ApiClient {
    constructor(config: { host: string });
  }

  export class OrderApi {
    constructor(client: ApiClient);
    getOrderBookDetails(params: any): Promise<any>;
  }

  export class AccountApi {
    constructor(client: ApiClient);
    getAccount(params: any): Promise<any>;
  }

  export class MarketHelper {
    constructor(marketIndex: number, orderApi: OrderApi);
    initialize(): Promise<void>;
    amountToUnits(amount: number): string;
    priceToUnits(price: number): string;
  }
}
