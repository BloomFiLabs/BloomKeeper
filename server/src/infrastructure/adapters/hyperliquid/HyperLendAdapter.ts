import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { ConfigService } from '@nestjs/config';

/**
 * HyperLend Adapter
 *
 * Integrates with HyperLend lending protocol on HyperEVM
 * https://app.hyperlend.finance/dashboard
 *
 * Used for delta-neutral funding strategy:
 * - Deposit USDC as collateral
 * - Borrow ETH (acts as spot long hedge)
 * - Combined with HyperLiquid perp short = delta neutral
 */

// Standard Aave-fork interface (HyperLend uses similar architecture)
const LENDING_POOL_ABI = [
  // Core functions
  'function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function withdraw(address asset, uint256 amount, address to) external returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256)',

  // View functions
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];

export interface HyperLendConfig {
  rpcUrl: string;
  lendingPoolAddress: string; // Main lending pool contract
  usdcAddress: string; // USDC on HyperEVM
  wethAddress: string; // WETH on HyperEVM
}

export interface AccountData {
  totalCollateralUSD: number;
  totalDebtUSD: number;
  availableBorrowsUSD: number;
  healthFactor: number;
  ltv: number;
}

@Injectable()
export class HyperLendAdapter {
  private readonly logger = new Logger(HyperLendAdapter.name);
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private lendingPool: ethers.Contract;
  private usdc: ethers.Contract;
  private weth: ethers.Contract;

  // Known HyperEVM addresses (to be confirmed)
  // These are placeholder - need to get actual addresses from HyperLend docs
  private config: HyperLendConfig = {
    rpcUrl: '',
    lendingPoolAddress: '', // TODO: Get from HyperLend docs
    usdcAddress: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', // HyperEVM USDC
    wethAddress: '', // TODO: Get WETH address on HyperEVM
  };

  constructor(private readonly configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('HYPERLIQUID_RPC_URL');
    const privateKey = this.configService.get<string>('PRIVATE_KEY');

    if (!rpcUrl) {
      this.logger.warn(
        'HYPERLIQUID_RPC_URL not set - HyperLend adapter will not function',
      );
      return;
    }

    this.config.rpcUrl = rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    if (privateKey) {
      this.wallet = new ethers.Wallet(privateKey, this.provider);
      this.logger.log(
        `HyperLend Adapter initialized for wallet: ${this.wallet.address}`,
      );
    }

    // Initialize contracts when addresses are available
    if (this.config.lendingPoolAddress) {
      this.initializeContracts();
    } else {
      this.logger.warn(
        '⚠️ HyperLend contract addresses not configured. Please set HYPERLEND_POOL_ADDRESS',
      );
    }
  }

  private initializeContracts() {
    this.lendingPool = new ethers.Contract(
      this.config.lendingPoolAddress,
      LENDING_POOL_ABI,
      this.wallet,
    );
    this.usdc = new ethers.Contract(
      this.config.usdcAddress,
      ERC20_ABI,
      this.wallet,
    );
    this.weth = new ethers.Contract(
      this.config.wethAddress,
      ERC20_ABI,
      this.wallet,
    );
  }

  /**
   * Deposit USDC as collateral
   */
  async depositCollateral(amountUSD: number): Promise<string> {
    if (!this.lendingPool) throw new Error('HyperLend not configured');

    const amount = ethers.parseUnits(amountUSD.toString(), 6); // USDC has 6 decimals

    // Approve USDC spend
    const approveTx = await this.usdc.approve(
      this.config.lendingPoolAddress,
      amount,
    );
    await approveTx.wait();
    this.logger.log(`Approved ${amountUSD} USDC for HyperLend`);

    // Deposit
    const depositTx = await this.lendingPool.deposit(
      this.config.usdcAddress,
      amount,
      this.wallet.address,
      0, // referral code
    );
    await depositTx.wait();

    this.logger.log(`Deposited ${amountUSD} USDC as collateral`);
    return depositTx.hash;
  }

  /**
   * Borrow ETH against collateral
   * This borrowed ETH acts as our SPOT LONG hedge
   */
  async borrowETH(amountETH: number): Promise<string> {
    if (!this.lendingPool) throw new Error('HyperLend not configured');

    const amount = ethers.parseEther(amountETH.toString());

    // Variable rate mode = 2
    const borrowTx = await this.lendingPool.borrow(
      this.config.wethAddress,
      amount,
      2, // variable rate
      0, // referral
      this.wallet.address,
    );
    await borrowTx.wait();

    this.logger.log(`Borrowed ${amountETH} ETH from HyperLend`);
    return borrowTx.hash;
  }

  /**
   * Repay borrowed ETH
   */
  async repayETH(amountETH: number): Promise<string> {
    if (!this.lendingPool) throw new Error('HyperLend not configured');

    const amount = ethers.parseEther(amountETH.toString());

    // Approve WETH spend
    const approveTx = await this.weth.approve(
      this.config.lendingPoolAddress,
      amount,
    );
    await approveTx.wait();

    // Repay
    const repayTx = await this.lendingPool.repay(
      this.config.wethAddress,
      amount,
      2, // variable rate
      this.wallet.address,
    );
    await repayTx.wait();

    this.logger.log(`Repaid ${amountETH} ETH to HyperLend`);
    return repayTx.hash;
  }

  /**
   * Withdraw collateral
   */
  async withdrawCollateral(amountUSD: number): Promise<string> {
    if (!this.lendingPool) throw new Error('HyperLend not configured');

    const amount = ethers.parseUnits(amountUSD.toString(), 6);

    const withdrawTx = await this.lendingPool.withdraw(
      this.config.usdcAddress,
      amount,
      this.wallet.address,
    );
    await withdrawTx.wait();

    this.logger.log(`Withdrew ${amountUSD} USDC from HyperLend`);
    return withdrawTx.hash;
  }

  /**
   * Get account health data
   * CRITICAL for liquidation prevention!
   */
  async getAccountData(): Promise<AccountData> {
    if (!this.lendingPool) throw new Error('HyperLend not configured');

    const data = await this.lendingPool.getUserAccountData(this.wallet.address);

    // Health factor is returned as 1e18 scaled
    const healthFactor = Number(data.healthFactor) / 1e18;

    return {
      totalCollateralUSD: Number(data.totalCollateralETH) / 1e18, // Actually in USD
      totalDebtUSD: Number(data.totalDebtETH) / 1e18,
      availableBorrowsUSD: Number(data.availableBorrowsETH) / 1e18,
      healthFactor: healthFactor,
      ltv: Number(data.ltv) / 100, // Basis points to percentage
    };
  }

  /**
   * Get current borrow rate for ETH
   */
  async getETHBorrowRate(): Promise<number> {
    if (!this.lendingPool) throw new Error('HyperLend not configured');

    const reserveData = await this.lendingPool.getReserveData(
      this.config.wethAddress,
    );

    // Rate is in RAY (1e27), convert to APR percentage
    const rateRay = Number(reserveData.currentVariableBorrowRate);
    const apr = (rateRay / 1e27) * 100;

    return apr;
  }

  /**
   * Check if position is safe (HF >= 1.5 per Bloom doc)
   */
  async isPositionSafe(minHealthFactor: number = 1.5): Promise<boolean> {
    const data = await this.getAccountData();
    return data.healthFactor >= minHealthFactor;
  }

  /**
   * Get borrowed ETH balance (our spot long position)
   */
  async getBorrowedETH(): Promise<number> {
    if (!this.weth) return 0;

    const balance = await this.weth.balanceOf(this.wallet.address);
    return Number(ethers.formatEther(balance));
  }
}
