import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, JsonRpcProvider, Wallet, Contract } from 'ethers';
import { IHyperLiquidExecutor } from '../../../domain/strategies/FundingRateStrategy';
import { HyperLiquidDataProvider } from './HyperLiquidDataProvider';

// HyperEVM Funding Strategy ABI (minimal)
const FUNDING_STRATEGY_ABI = [
  'function rebalance(bool isLong, uint64 priceLimit, uint64 size, bool reduceOnly) external',
  'function emergencyExit() external',
  'function totalAssets() external view returns (uint256)',
  'function totalPrincipal() external view returns (uint256)',
  'function keepers(address) external view returns (bool)',
  'event Rebalanced(int256 targetDelta, uint256 timestamp)',
];

// L1Read precompile for reading HyperCore state
const L1_READ_ADDRESS = '0x0000000000000000000000000000000000000800';
const L1_READ_ABI = [
  'function readPerpPositions(address user) external view returns (tuple(uint256 coin, int256 szi, int256 entryPx, int256 positionValue, int256 unrealizedPnl, int256 liquidationPx, int256 marginUsed, int256 maxLeverage, int256 cumFunding)[])',
  'function readVaultEquity(address user) external view returns (uint256)',
];

interface Position {
  size: number;
  side: 'long' | 'short' | 'none';
  entryPrice: number;
}

/**
 * HyperLiquidExecutor - Executes trades on HyperLiquid via HyperEVM
 * 
 * This adapter interacts with the deployed HyperEVMFundingStrategy contract
 * which in turn communicates with HyperCore via the CoreWriter precompile.
 */
@Injectable()
export class HyperLiquidExecutor implements IHyperLiquidExecutor {
  private readonly logger = new Logger(HyperLiquidExecutor.name);
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly SCALE_1E8 = 1e8;

  constructor(
    private readonly configService: ConfigService,
    private readonly dataProvider: HyperLiquidDataProvider,
  ) {
    const rpcUrl = this.configService.get<string>('HYPERLIQUID_RPC_URL');
    const privateKey = this.configService.get<string>('PRIVATE_KEY');

    if (!rpcUrl || !privateKey) {
      this.logger.warn('HyperLiquid not configured - funding strategies will be disabled');
      // Create dummy provider/wallet for type safety
      this.provider = null as any;
      this.wallet = null as any;
      return;
    }

    this.provider = new JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(privateKey, this.provider);
    
    this.logger.log(`HyperLiquid Executor initialized for wallet: ${this.wallet.address}`);
  }

  isConfigured(): boolean {
    return this.provider !== null && this.wallet !== null;
  }

  /**
   * Get current position for a strategy
   */
  async getPosition(strategyAddress: string): Promise<Position> {
    if (!this.isConfigured()) {
      return { size: 0, side: 'none', entryPrice: 0 };
    }

    try {
      const l1Read = new Contract(L1_READ_ADDRESS, L1_READ_ABI, this.provider);
      const positions = await l1Read.readPerpPositions(strategyAddress);

      if (!positions || positions.length === 0) {
        return { size: 0, side: 'none', entryPrice: 0 };
      }

      // Find the first non-zero position (assuming single asset strategy)
      for (const pos of positions) {
        const size = Number(pos.szi) / this.SCALE_1E8;
        if (size !== 0) {
          return {
            size: Math.abs(size),
            side: size > 0 ? 'long' : 'short',
            entryPrice: Number(pos.entryPx) / this.SCALE_1E8,
          };
        }
      }

      return { size: 0, side: 'none', entryPrice: 0 };
    } catch (error: any) {
      // Silently return empty position if contract doesn't exist or RPC is unavailable
      // This is expected when strategy contracts aren't deployed
      if (error.code === 'CALL_EXCEPTION' || error.message?.includes('missing revert data')) {
        return { size: 0, side: 'none', entryPrice: 0 };
      }
      // Only log unexpected errors
      this.logger.debug(`Failed to get position for ${strategyAddress}: ${error.message}`);
      return { size: 0, side: 'none', entryPrice: 0 };
    }
  }

  /**
   * Place an order via the strategy contract
   */
  async placeOrder(
    strategyAddress: string,
    isLong: boolean,
    size: number,
    price: number,
  ): Promise<string> {
    try {
      const strategy = new Contract(strategyAddress, FUNDING_STRATEGY_ABI, this.wallet);

      // Convert to 1e8 scale as expected by HyperLiquid
      const sizeScaled = BigInt(Math.round(size * this.SCALE_1E8));
      const priceScaled = BigInt(Math.round(price * this.SCALE_1E8));

      this.logger.log(
        `Placing ${isLong ? 'LONG' : 'SHORT'} order: ` +
        `Size=${size.toFixed(4)}, Price=${price.toFixed(2)}, ` +
        `Strategy=${strategyAddress}`
      );

      const tx = await strategy.rebalance(
        isLong,
        priceScaled,
        sizeScaled,
        false, // Not reduce-only for new positions
      );

      const receipt = await tx.wait();
      this.logger.log(`Order placed: ${receipt.hash}`);
      
      return receipt.hash;
    } catch (error) {
      this.logger.error(`Failed to place order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close all positions for a strategy
   */
  async closePosition(strategyAddress: string): Promise<string> {
    try {
      const strategy = new Contract(strategyAddress, FUNDING_STRATEGY_ABI, this.wallet);

      this.logger.log(`Closing position for strategy: ${strategyAddress}`);

      const tx = await strategy.emergencyExit();
      const receipt = await tx.wait();
      
      this.logger.log(`Position closed: ${receipt.hash}`);
      return receipt.hash;
    } catch (error) {
      this.logger.error(`Failed to close position: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get equity (margin + PnL) for a strategy
   */
  async getEquity(strategyAddress: string): Promise<number> {
    if (!this.isConfigured()) {
      return 0;
    }

    try {
      const l1Read = new Contract(L1_READ_ADDRESS, L1_READ_ABI, this.provider);
      const equity = await l1Read.readVaultEquity(strategyAddress);
      
      // Equity is in 6 decimals (USDC)
      return Number(equity) / 1e6;
    } catch (error: any) {
      // Silently return 0 if contract doesn't exist or RPC is unavailable
      // This is expected when strategy contracts aren't deployed
      if (error.code === 'CALL_EXCEPTION' || error.message?.includes('missing revert data')) {
        return 0;
      }
      
      // Fallback: try reading from strategy contract
      try {
        const strategy = new Contract(strategyAddress, FUNDING_STRATEGY_ABI, this.provider);
        const totalAssets = await strategy.totalAssets();
        return Number(totalAssets) / 1e6;
      } catch (fallbackError: any) {
        // Silently return 0 if fallback also fails (contract doesn't exist)
        if (fallbackError.code === 'CALL_EXCEPTION' || fallbackError.message?.includes('missing revert data')) {
          return 0;
        }
        // Only log unexpected errors
        this.logger.debug(`Fallback equity fetch failed: ${fallbackError.message}`);
        return 0;
      }
    }
  }

  /**
   * Get mark price for an asset (delegates to data provider)
   */
  async getMarkPrice(asset: string): Promise<number> {
    return this.dataProvider.getMarkPrice(asset);
  }

  /**
   * Check if an address is authorized as a keeper
   */
  async isKeeper(strategyAddress: string, keeperAddress: string): Promise<boolean> {
    try {
      const strategy = new Contract(strategyAddress, FUNDING_STRATEGY_ABI, this.provider);
      return await strategy.keepers(keeperAddress);
    } catch (error) {
      this.logger.error(`Failed to check keeper status: ${error.message}`);
      return false;
    }
  }

  /**
   * Get the wallet address used by this executor
   */
  getWalletAddress(): string {
    return this.wallet.address;
  }
}

