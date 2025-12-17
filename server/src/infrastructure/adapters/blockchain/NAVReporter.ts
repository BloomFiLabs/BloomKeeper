import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  Contract,
  Wallet,
  JsonRpcProvider,
  formatUnits,
  parseUnits,
} from 'ethers';
import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';

/**
 * NAV calculation result
 */
interface NAVCalculation {
  totalEquity: bigint;
  byExchange: Map<ExchangeType, bigint>;
  timestamp: Date;
  positionCount: number;
}

/**
 * NAVReporter - Reports Net Asset Value to KeeperStrategyManager contract
 *
 * Responsibilities:
 * 1. Calculate total equity across all exchanges (Hyperliquid, Lighter, Aster)
 * 2. Report NAV to contract periodically (every hour)
 * 3. Track NAV history for analytics
 */
@Injectable()
export class NAVReporter implements OnModuleInit {
  private readonly logger = new Logger(NAVReporter.name);

  private wallet: Wallet | null = null;
  private provider: JsonRpcProvider | null = null;
  private contract: Contract | null = null;

  // Last reported NAV
  private lastReportedNAV: bigint = 0n;
  private lastReportTimestamp: Date | null = null;

  // NAV history for analytics (last 24 reports)
  private readonly navHistory: Array<{
    nav: bigint;
    timestamp: Date;
    pnl: bigint;
  }> = [];
  private readonly MAX_HISTORY = 24;

  // Contract ABI for NAV reporting
  private readonly CONTRACT_ABI = [
    'function reportNAV(uint256 nav) external',
    'function lastReportedNAV() external view returns (uint256)',
    'function lastNAVTimestamp() external view returns (uint256)',
    'function deployedCapital() external view returns (uint256)',
    'function getCurrentPnL() external view returns (int256)',
  ];

  private readonly strategyAddress: string;
  private readonly rpcUrl: string;
  private readonly reportIntervalMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly keeperService: PerpKeeperService,
  ) {
    this.strategyAddress = this.configService.get<string>(
      'KEEPER_STRATEGY_ADDRESS',
      '',
    );
    this.rpcUrl = this.configService.get<string>(
      'ARBITRUM_RPC_URL',
      'https://arb1.arbitrum.io/rpc',
    );
    // Default: report every hour (3600000 ms)
    this.reportIntervalMs = this.configService.get<number>(
      'NAV_REPORT_INTERVAL_MS',
      3600000,
    );
  }

  async onModuleInit() {
    if (!this.strategyAddress) {
      this.logger.warn(
        'KEEPER_STRATEGY_ADDRESS not configured, NAV reporter disabled',
      );
      return;
    }

    await this.initialize();
  }

  /**
   * Initialize wallet and contract connections
   */
  private async initialize(): Promise<void> {
    const privateKey = this.configService.get<string>('KEEPER_PRIVATE_KEY');

    if (!privateKey) {
      this.logger.warn('KEEPER_PRIVATE_KEY not configured, cannot report NAV');
      return;
    }

    try {
      this.provider = new JsonRpcProvider(this.rpcUrl);
      this.wallet = new Wallet(privateKey, this.provider);
      this.contract = new Contract(
        this.strategyAddress,
        this.CONTRACT_ABI,
        this.wallet,
      );

      // Load current NAV from contract
      await this.loadCurrentNAV();

      this.logger.log(`NAVReporter initialized for ${this.strategyAddress}`);
    } catch (error: any) {
      this.logger.error(`Failed to initialize: ${error.message}`);
    }
  }

  /**
   * Load current NAV from contract
   */
  private async loadCurrentNAV(): Promise<void> {
    if (!this.contract) return;

    try {
      const [nav, timestamp] = await Promise.all([
        this.contract.lastReportedNAV(),
        this.contract.lastNAVTimestamp(),
      ]);

      this.lastReportedNAV = nav;
      this.lastReportTimestamp = new Date(Number(timestamp) * 1000);

      this.logger.log(
        `Loaded current NAV: ${formatUnits(nav, 6)} USDC (reported at ${this.lastReportTimestamp?.toISOString()})`,
      );
    } catch (error: any) {
      this.logger.warn(`Failed to load current NAV: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NAV CALCULATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calculate total NAV across all exchanges
   */
  async calculateNAV(): Promise<NAVCalculation> {
    const byExchange = new Map<ExchangeType, bigint>();
    let totalEquity = 0n;
    let positionCount = 0;

    const exchanges = [
      ExchangeType.HYPERLIQUID,
      ExchangeType.LIGHTER,
      ExchangeType.ASTER,
    ];

    for (const exchangeType of exchanges) {
      try {
        // Get balance from exchange
        const balance = await this.keeperService.getBalance(exchangeType);
        const balanceInUsdc = parseUnits(balance.toFixed(6), 6);

        byExchange.set(exchangeType, balanceInUsdc);
        totalEquity += balanceInUsdc;

        // Get position count
        const adapter = this.keeperService.getExchangeAdapter(exchangeType);
        if (adapter) {
          const positions = await adapter.getPositions();
          positionCount += positions.length;
        }

        this.logger.debug(
          `${exchangeType}: ${formatUnits(balanceInUsdc, 6)} USDC`,
        );
      } catch (error: any) {
        this.logger.warn(
          `Failed to get balance from ${exchangeType}: ${error.message}`,
        );
        // Continue with other exchanges
      }
    }

    // Also add any USDC held on the keeper wallet on Arbitrum
    try {
      const keeperArbitrumBalance = await this.getKeeperArbitrumBalance();
      totalEquity += keeperArbitrumBalance;

      this.logger.debug(
        `Keeper Arbitrum wallet: ${formatUnits(keeperArbitrumBalance, 6)} USDC`,
      );
    } catch (error: any) {
      this.logger.warn(
        `Failed to get keeper Arbitrum balance: ${error.message}`,
      );
    }

    return {
      totalEquity,
      byExchange,
      timestamp: new Date(),
      positionCount,
    };
  }

  /**
   * Get USDC balance on keeper wallet (on Arbitrum)
   */
  private async getKeeperArbitrumBalance(): Promise<bigint> {
    if (!this.wallet || !this.provider) {
      return 0n;
    }

    const usdcAddress = this.configService.get<string>(
      'USDC_ADDRESS',
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum native USDC
    );

    const usdc = new Contract(
      usdcAddress,
      ['function balanceOf(address) view returns (uint256)'],
      this.provider,
    );

    return await usdc.balanceOf(this.wallet.address);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NAV REPORTING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Report NAV to the contract
   * Called periodically by the scheduler (every hour by default)
   */
  @Interval(3600000) // 1 hour - can be overridden by config
  async reportNAV(): Promise<boolean> {
    if (!this.contract || !this.wallet) {
      this.logger.debug('NAV reporter not initialized, skipping report');
      return false;
    }

    try {
      // Calculate current NAV
      const navCalc = await this.calculateNAV();

      this.logger.log(
        `Calculated NAV: ${formatUnits(navCalc.totalEquity, 6)} USDC (${navCalc.positionCount} positions)`,
      );

      // Get deployed capital for PnL calculation
      const deployedCapital = await this.contract.deployedCapital();
      const pnl = navCalc.totalEquity - deployedCapital;

      this.logger.log(
        `PnL: ${formatUnits(pnl, 6)} USDC (${((Number(pnl) / Number(deployedCapital)) * 100).toFixed(2)}%)`,
      );

      // Report to contract
      const tx = await this.contract.reportNAV(navCalc.totalEquity);
      this.logger.debug(`ReportNAV tx: ${tx.hash}`);

      const receipt = await tx.wait();
      this.logger.log(
        `NAV reported successfully in block ${receipt.blockNumber}`,
      );

      // Update local state
      this.lastReportedNAV = navCalc.totalEquity;
      this.lastReportTimestamp = navCalc.timestamp;

      // Add to history
      this.navHistory.push({
        nav: navCalc.totalEquity,
        timestamp: navCalc.timestamp,
        pnl,
      });
      if (this.navHistory.length > this.MAX_HISTORY) {
        this.navHistory.shift();
      }

      return true;
    } catch (error: any) {
      this.logger.error(`Failed to report NAV: ${error.message}`);
      return false;
    }
  }

  /**
   * Force an immediate NAV report (bypasses interval)
   */
  async forceReportNAV(): Promise<boolean> {
    this.logger.log('Force reporting NAV...');
    return this.reportNAV();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC GETTERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get last reported NAV
   */
  getLastReportedNAV(): { nav: bigint; timestamp: Date | null } {
    return {
      nav: this.lastReportedNAV,
      timestamp: this.lastReportTimestamp,
    };
  }

  /**
   * Get NAV history
   */
  getNAVHistory(): Array<{ nav: bigint; timestamp: Date; pnl: bigint }> {
    return [...this.navHistory];
  }

  /**
   * Get time until next scheduled report
   */
  getTimeUntilNextReport(): number {
    if (!this.lastReportTimestamp) {
      return 0;
    }

    const nextReportTime =
      this.lastReportTimestamp.getTime() + this.reportIntervalMs;
    return Math.max(0, nextReportTime - Date.now());
  }

  /**
   * Check if NAV is stale (older than 4 hours)
   */
  isNAVStale(): boolean {
    if (!this.lastReportTimestamp) {
      return true;
    }

    const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
    return this.lastReportTimestamp.getTime() < fourHoursAgo;
  }

  /**
   * Get current NAV without reporting (for display purposes)
   */
  async getCurrentNAV(): Promise<NAVCalculation> {
    return this.calculateNAV();
  }

  /**
   * Get current PnL from contract
   */
  async getCurrentPnL(): Promise<bigint | null> {
    if (!this.contract) return null;

    try {
      return await this.contract.getCurrentPnL();
    } catch (error: any) {
      this.logger.warn(`Failed to get current PnL: ${error.message}`);
      return null;
    }
  }
}
