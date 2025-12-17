/**
 * Supported perpetual exchange types
 */
export enum ExchangeType {
  ASTER = 'ASTER',
  LIGHTER = 'LIGHTER',
  HYPERLIQUID = 'HYPERLIQUID',
  EXTENDED = 'EXTENDED',
}

/**
 * Exchange configuration value object
 */
export class ExchangeConfig {
  constructor(
    public readonly exchangeType: ExchangeType,
    public readonly baseUrl: string, // API base URL
    public readonly apiKey?: string, // API key (if required)
    public readonly apiSecret?: string, // API secret (if required)
    public readonly privateKey?: string, // Private key for signing (if required)
    public readonly userAddress?: string, // User/EOA address (for Aster)
    public readonly signerAddress?: string, // Signer address (for Aster)
    public readonly accountIndex?: number, // Account index (for Lighter)
    public readonly apiKeyIndex?: number, // API key index (for Lighter)
    public readonly recvWindow?: number, // Receive window in milliseconds (for Aster)
    public readonly starkKey?: string, // Stark private key for signing (for Extended)
    public readonly vaultNumber?: number, // Vault/account number (for Extended)
    public readonly starknetRpcUrl?: string, // Optional Starknet RPC URL (for Extended)
    public readonly rateLimitRps?: number, // Rate limit requests per second
    public readonly timeout?: number, // Request timeout in milliseconds
    public readonly testnet?: boolean, // Whether to use testnet
  ) {
    // Validation
    if (!baseUrl || baseUrl.trim().length === 0) {
      throw new Error('Base URL is required');
    }

    // Exchange-specific validation
    if (exchangeType === ExchangeType.ASTER) {
      if (!userAddress || !signerAddress || !privateKey) {
        throw new Error(
          'Aster exchange requires userAddress, signerAddress, and privateKey',
        );
      }
    }

    if (exchangeType === ExchangeType.LIGHTER) {
      if (!apiKey) {
        throw new Error('Lighter exchange requires apiKey');
      }
      if (accountIndex === undefined) {
        throw new Error('Lighter exchange requires accountIndex');
      }
    }

    if (exchangeType === ExchangeType.HYPERLIQUID) {
      if (!privateKey) {
        throw new Error('Hyperliquid exchange requires privateKey');
      }
    }

    if (exchangeType === ExchangeType.EXTENDED) {
      if (!apiKey) {
        throw new Error('Extended exchange requires apiKey');
      }
      if (!starkKey) {
        throw new Error('Extended exchange requires starkKey');
      }
      if (vaultNumber === undefined) {
        throw new Error('Extended exchange requires vaultNumber');
      }
    }

    if (rateLimitRps !== undefined && rateLimitRps <= 0) {
      throw new Error('Rate limit must be greater than 0');
    }

    if (timeout !== undefined && timeout <= 0) {
      throw new Error('Timeout must be greater than 0');
    }
  }

  /**
   * Returns true if this is an Aster exchange configuration
   */
  isAster(): boolean {
    return this.exchangeType === ExchangeType.ASTER;
  }

  /**
   * Returns true if this is a Lighter exchange configuration
   */
  isLighter(): boolean {
    return this.exchangeType === ExchangeType.LIGHTER;
  }

  /**
   * Returns true if this is a Hyperliquid exchange configuration
   */
  isHyperliquid(): boolean {
    return this.exchangeType === ExchangeType.HYPERLIQUID;
  }

  /**
   * Returns true if this is an Extended exchange configuration
   */
  isExtended(): boolean {
    return this.exchangeType === ExchangeType.EXTENDED;
  }

  /**
   * Returns true if this configuration is for testnet
   */
  isTestnet(): boolean {
    return this.testnet === true;
  }

  /**
   * Returns the default timeout if not specified
   */
  getTimeout(): number {
    return this.timeout ?? 30000; // Default 30 seconds
  }

  /**
   * Returns the default rate limit if not specified
   */
  getRateLimit(): number {
    return this.rateLimitRps ?? 10; // Default 10 requests per second
  }
}
