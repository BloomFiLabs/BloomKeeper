/**
 * Gas Price Service
 * Fetches real-time gas prices from blockchain RPC endpoints
 * Supports multiple networks: Ethereum Mainnet, Base, Arbitrum, etc.
 */

export interface NetworkConfig {
  name: string;
  rpcUrl: string;
  chainId: number;
  nativeTokenSymbol: string;
  defaultGasPriceGwei?: number; // Fallback if RPC fails
}

export interface GasPriceResult {
  gasPriceGwei: number;
  network: string;
  timestamp: Date;
}

export class GasPriceService {
  private static readonly NETWORKS: Map<string, NetworkConfig> = new Map([
    ['mainnet', {
      name: 'Ethereum Mainnet',
      rpcUrl: 'https://eth.llamarpc.com',
      chainId: 1,
      nativeTokenSymbol: 'ETH',
      defaultGasPriceGwei: 30,
    }],
    ['base', {
      name: 'Base',
      rpcUrl: 'https://mainnet.base.org',
      chainId: 8453,
      nativeTokenSymbol: 'ETH',
      defaultGasPriceGwei: 0.1, // Base typically has very low gas prices (~0.01-0.1 Gwei)
    }],
    ['arbitrum', {
      name: 'Arbitrum One',
      rpcUrl: 'https://arb1.arbitrum.io/rpc',
      chainId: 42161,
      nativeTokenSymbol: 'ETH',
      defaultGasPriceGwei: 0.1,
    }],
    ['optimism', {
      name: 'Optimism',
      rpcUrl: 'https://mainnet.optimism.io',
      chainId: 10,
      nativeTokenSymbol: 'ETH',
      defaultGasPriceGwei: 0.1,
    }],
  ]);

  /**
   * Fetch current gas price from network RPC
   */
  static async fetchGasPrice(network: string = 'base'): Promise<GasPriceResult> {
    const networkConfig = this.NETWORKS.get(network.toLowerCase());
    
    if (!networkConfig) {
      throw new Error(`Unknown network: ${network}. Supported: ${Array.from(this.NETWORKS.keys()).join(', ')}`);
    }

    try {
      // Use eth_gasPrice RPC call
      const response = await fetch(networkConfig.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_gasPrice',
          params: [],
          id: 1,
        }),
      });

      const data = await response.json() as {
        result?: string;
        error?: { message: string };
      };
      
      if (data.error) {
        throw new Error(`RPC error: ${data.error.message}`);
      }

      if (!data.result) {
        throw new Error('No result from RPC');
      }

      // Convert hex to Gwei (1 Gwei = 1e9 Wei)
      const gasPriceWei = parseInt(data.result, 16);
      const gasPriceGwei = gasPriceWei / 1e9;

      return {
        gasPriceGwei,
        network: networkConfig.name,
        timestamp: new Date(),
      };
    } catch (error) {
      console.warn(`⚠️  Failed to fetch gas price from ${networkConfig.name}, using default:`, (error as Error).message);
      
      // Fallback to default
      return {
        gasPriceGwei: networkConfig.defaultGasPriceGwei || 0.1,
        network: networkConfig.name,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Get network configuration
   */
  static getNetworkConfig(network: string): NetworkConfig | undefined {
    return this.NETWORKS.get(network.toLowerCase());
  }

  /**
   * Get all supported networks
   */
  static getSupportedNetworks(): string[] {
    return Array.from(this.NETWORKS.keys());
  }

  /**
   * Estimate gas cost in USD for a given operation
   */
  static async estimateGasCostUSD(
    network: string,
    gasUnits: number,
    nativeTokenPriceUSD: number
  ): Promise<number> {
    const gasPrice = await this.fetchGasPrice(network);
    const gasCostETH = (gasUnits * gasPrice.gasPriceGwei) / 1e9;
    return gasCostETH * nativeTokenPriceUSD;
  }
}

