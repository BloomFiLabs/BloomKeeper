import { Injectable, Logger, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Contract, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpKeeperService } from '../../application/services/PerpKeeperService';
import { RealFundingPaymentsService } from './RealFundingPaymentsService';

/**
 * Profit calculation mode
 * - 'contract': Use deployedCapital from KeeperStrategyManager contract (default)
 * - 'balance': Treat current balance as deployed capital (for direct deposits)
 * - 'realized': Use actual realized PnL from funding payments (most accurate)
 */
export type ProfitCalculationMode = 'contract' | 'balance' | 'realized';

/**
 * Profit tracking result for an exchange
 */
export interface ExchangeProfitInfo {
  exchange: ExchangeType;
  currentBalance: number;
  deployedCapital: number;
  accruedProfit: number;
  deployableCapital: number;
}

/**
 * Overall profit summary
 */
export interface ProfitSummary {
  totalBalance: number;
  totalDeployedCapital: number;
  totalAccruedProfit: number;
  byExchange: Map<ExchangeType, ExchangeProfitInfo>;
  lastSyncTimestamp: Date | null;
  lastHarvestTimestamp: Date | null;
  totalHarvestedAllTime: number;
}

/**
 * ProfitTracker - Tracks deployed capital and calculates per-exchange profits
 * 
 * Responsibilities:
 * 1. Sync deployedCapital from KeeperStrategyManager contract (or use realized PnL)
 * 2. Calculate per-exchange deployed capital proportionally
 * 3. Provide deployable capital (excluding accrued profits) for position sizing
 * 4. Track harvest history
 * 
 * Profit Calculation Modes:
 * - 'contract': Use deployedCapital from KeeperStrategyManager contract (default for vault deposits)
 * - 'balance': Treat current balance as deployed capital (for direct deposits)
 * - 'realized': Use actual realized PnL from funding payments (most accurate, recommended)
 * 
 * Set via PROFIT_CALCULATION_MODE env var (default: 'realized')
 */
@Injectable()
export class ProfitTracker implements OnModuleInit {
  private readonly logger = new Logger(ProfitTracker.name);
  
  private provider: JsonRpcProvider | null = null;
  private contract: Contract | null = null;
  
  // Deployed capital from contract (in USDC with 6 decimals)
  private deployedCapital: bigint = 0n;
  
  // Last sync timestamp
  private lastSyncTimestamp: Date | null = null;
  
  // Last harvest timestamp
  private lastHarvestTimestamp: Date | null = null;
  
  // Total harvested all time (for diagnostics)
  private totalHarvestedAllTime: number = 0;
  
  // Cache of exchange balances (refreshed on sync)
  private exchangeBalances: Map<ExchangeType, number> = new Map();
  
  // Profit calculation mode
  private readonly profitCalculationMode: ProfitCalculationMode;
  
  // Realized profits from funding payments (when using 'realized' mode)
  private realizedProfits: Map<ExchangeType, number> = new Map();
  private totalRealizedProfit: number = 0;

  // Contract ABI for reading deployed capital
  private readonly CONTRACT_ABI = [
    'function deployedCapital() external view returns (uint256)',
    'function lastReportedNAV() external view returns (uint256)',
    'function getStrategySummary() external view returns (uint256 deployedCapital, uint256 lastReportedNAV, uint256 pendingWithdrawals, uint256 idleBalance, int256 pnl)',
  ];

  private readonly strategyAddress: string;
  private readonly rpcUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject(forwardRef(() => PerpKeeperService))
    private readonly keeperService?: PerpKeeperService,
    @Optional() @Inject(forwardRef(() => RealFundingPaymentsService))
    private readonly realFundingService?: RealFundingPaymentsService,
  ) {
    this.strategyAddress = this.configService.get<string>('KEEPER_STRATEGY_ADDRESS', '');
    this.rpcUrl = this.configService.get<string>('ARBITRUM_RPC_URL', 'https://arb1.arbitrum.io/rpc');
    
    // Default to 'realized' mode for most accurate profit tracking
    const modeConfig = this.configService.get<string>('PROFIT_CALCULATION_MODE', 'realized');
    this.profitCalculationMode = ['contract', 'balance', 'realized'].includes(modeConfig) 
      ? modeConfig as ProfitCalculationMode 
      : 'realized';
    
    this.logger.log(`ProfitTracker using '${this.profitCalculationMode}' profit calculation mode`);
  }

  async onModuleInit() {
    // Check if we should use balance-based deployed capital (for direct deposits)
    const useBalanceAsDeployed = this.configService.get<string>('PROFIT_TRACKER_USE_BALANCE_AS_DEPLOYED', 'false') === 'true';
    
    if (!this.strategyAddress) {
      this.logger.warn('KEEPER_STRATEGY_ADDRESS not configured, ProfitTracker running in standalone mode');
      
      // If no contract but we want to use balances, sync from balances after a delay
      // (to allow adapters to initialize first)
      if (useBalanceAsDeployed) {
        this.logger.log('PROFIT_TRACKER_USE_BALANCE_AS_DEPLOYED=true, will sync deployed capital from exchange balances');
        setTimeout(() => this.syncDeployedCapitalFromBalances(), 5000);
      }
      return;
    }

    await this.initialize();
    await this.syncFromContract();
    
    // If contract returned 0 deployed capital but we have balances, use balance-based sync
    if (useBalanceAsDeployed && this.getDeployedCapitalAmount() === 0) {
      this.logger.log('Contract shows $0 deployed capital but PROFIT_TRACKER_USE_BALANCE_AS_DEPLOYED=true, syncing from balances...');
      setTimeout(() => this.syncDeployedCapitalFromBalances(), 5000);
    }
    
    // If using realized mode, sync realized profits after a delay (to allow funding service to initialize)
    if (this.profitCalculationMode === 'realized') {
      setTimeout(() => this.syncRealizedProfits(), 10000);
    }
  }
  
  /**
   * Get current profit calculation mode
   */
  getProfitCalculationMode(): ProfitCalculationMode {
    return this.profitCalculationMode;
  }

  /**
   * Initialize provider and contract
   */
  private async initialize(): Promise<void> {
    try {
      this.provider = new JsonRpcProvider(this.rpcUrl);
      this.contract = new Contract(this.strategyAddress, this.CONTRACT_ABI, this.provider);
      this.logger.log(`ProfitTracker initialized for ${this.strategyAddress}`);
    } catch (error: any) {
      this.logger.error(`Failed to initialize ProfitTracker: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC FROM CONTRACT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync deployedCapital from contract
   * Called on startup and every hour
   */
  @Interval(3600000) // Every hour
  async syncFromContract(): Promise<void> {
    if (!this.contract) {
      this.logger.debug('Contract not initialized, skipping sync');
      return;
    }

    try {
      // Get deployed capital from contract
      const [deployedCapital, lastReportedNAV, pendingWithdrawals, idleBalance, pnl] = 
        await this.contract.getStrategySummary();
      
      this.deployedCapital = deployedCapital;
      this.lastSyncTimestamp = new Date();

      this.logger.log(
        `Synced from contract: deployedCapital=${formatUnits(deployedCapital, 6)} USDC, ` +
        `NAV=${formatUnits(lastReportedNAV, 6)} USDC, PnL=${formatUnits(pnl, 6)} USDC`,
      );

      // Also refresh exchange balances
      await this.refreshExchangeBalances();
    } catch (error: any) {
      this.logger.warn(`Failed to sync from contract: ${error.message}`);
    }
  }

  /**
   * Refresh exchange balances
   */
  private async refreshExchangeBalances(): Promise<void> {
    if (!this.keeperService) {
      return;
    }

    const exchanges = [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER];
    
    for (const exchangeType of exchanges) {
      try {
        const balance = await this.keeperService.getBalance(exchangeType);
        this.exchangeBalances.set(exchangeType, balance);
      } catch (error: any) {
        this.logger.debug(`Failed to get balance for ${exchangeType}: ${error.message}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROFIT CALCULATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get total balance across all exchanges
   */
  async getTotalBalance(): Promise<number> {
    await this.refreshExchangeBalances();
    
    let total = 0;
    for (const balance of this.exchangeBalances.values()) {
      total += balance;
    }
    return total;
  }

  /**
   * Get deployed capital as number (USDC)
   */
  getDeployedCapitalAmount(): number {
    return Number(formatUnits(this.deployedCapital, 6));
  }

  /**
   * Sync realized profits from RealFundingPaymentsService
   * This calculates actual profits from funding payments minus trading costs
   */
  async syncRealizedProfits(): Promise<void> {
    if (!this.realFundingService) {
      this.logger.debug('RealFundingPaymentsService not available, skipping realized profit sync');
      return;
    }

    try {
      const summary = await this.realFundingService.getCombinedSummary(30, 0);
      const tradingCosts = this.realFundingService.getTotalTradingCosts();
      
      // Net realized profit = funding received - funding paid - trading costs
      this.totalRealizedProfit = Math.max(0, summary.netFunding - tradingCosts);
      
      // Distribute per exchange based on their net funding
      for (const [exchange, exchangeSummary] of summary.exchanges) {
        const exchangeProfit = Math.max(0, exchangeSummary.netFunding);
        this.realizedProfits.set(exchange, exchangeProfit);
      }
      
      this.logger.debug(
        `Synced realized profits: Net funding $${summary.netFunding.toFixed(4)}, ` +
        `Trading costs $${tradingCosts.toFixed(4)}, ` +
        `Realized profit $${this.totalRealizedProfit.toFixed(4)}`,
      );
    } catch (error: any) {
      this.logger.warn(`Failed to sync realized profits: ${error.message}`);
    }
  }

  /**
   * Calculate total accrued profits across all exchanges
   * Uses different calculation based on profitCalculationMode:
   * - 'contract': Profits = TotalBalance - DeployedCapital (from contract)
   * - 'balance': Profits = 0 (all balance is deployable)
   * - 'realized': Profits = Actual realized PnL from funding payments - costs
   */
  async getTotalProfits(): Promise<number> {
    switch (this.profitCalculationMode) {
      case 'realized':
        // Use actual realized PnL from funding payments
        await this.syncRealizedProfits();
        return this.totalRealizedProfit;
        
      case 'balance':
        // In balance mode, treat everything as deployable (no profits yet)
        return 0;
        
      case 'contract':
      default:
        // Original calculation: balance - deployedCapital
        const totalBalance = await this.getTotalBalance();
        const deployedCapital = this.getDeployedCapitalAmount();
        
        // Profits can't be negative (if balance < deployed, we have losses, not profits)
        return Math.max(0, totalBalance - deployedCapital);
    }
  }

  /**
   * Get accrued profits for a specific exchange
   * Uses different calculation based on profitCalculationMode
   */
  async getAccruedProfits(exchangeType: ExchangeType): Promise<number> {
    switch (this.profitCalculationMode) {
      case 'realized':
        // Use actual realized profits for this exchange
        await this.syncRealizedProfits();
        return this.realizedProfits.get(exchangeType) || 0;
        
      case 'balance':
        // In balance mode, treat everything as deployable (no profits)
        return 0;
        
      case 'contract':
      default:
        // Original calculation: distribute proportionally
        const totalProfits = await this.getTotalProfits();
        
        if (totalProfits <= 0) {
          return 0;
        }

        const totalBalance = await this.getTotalBalance();
        if (totalBalance <= 0) {
          return 0;
        }

        // Get this exchange's balance
        const exchangeBalance = this.exchangeBalances.get(exchangeType) || 0;
        if (exchangeBalance <= 0) {
          return 0;
        }

        // Distribute profits proportionally based on balance
        const proportion = exchangeBalance / totalBalance;
        return totalProfits * proportion;
    }
  }

  /**
   * Get deployable capital for a specific exchange
   * This is the amount that can be used for position sizing (excludes profits)
   * 
   * Uses profitCalculationMode to determine how profits are calculated:
   * - 'realized': Subtracts actual realized PnL (most accurate)
   * - 'balance': Returns full balance (for direct deposits with no profit tracking)
   * - 'contract': Subtracts balance - deployedCapital (original behavior)
   */
  async getDeployableCapital(exchangeType: ExchangeType): Promise<number> {
    // Refresh balance for this exchange
    if (this.keeperService) {
      try {
        const balance = await this.keeperService.getBalance(exchangeType);
        this.exchangeBalances.set(exchangeType, balance);
      } catch (error: any) {
        this.logger.debug(`Failed to refresh balance for ${exchangeType}: ${error.message}`);
      }
    }

    const exchangeBalance = this.exchangeBalances.get(exchangeType) || 0;
    
    // In 'balance' mode, return full balance (no profit tracking)
    if (this.profitCalculationMode === 'balance') {
      this.logger.debug(
        `${exchangeType}: Balance mode - full balance $${exchangeBalance.toFixed(2)} is deployable`,
      );
      return exchangeBalance;
    }
    
    // In 'realized' mode, subtract actual realized profits from funding
    if (this.profitCalculationMode === 'realized') {
      const accruedProfits = await this.getAccruedProfits(exchangeType);
      const deployable = Math.max(0, exchangeBalance - accruedProfits);
      this.logger.debug(
        `${exchangeType}: Realized mode - balance $${exchangeBalance.toFixed(2)}, ` +
        `realized profits $${accruedProfits.toFixed(4)}, deployable $${deployable.toFixed(2)}`,
      );
      return deployable;
    }
    
    // In 'contract' mode (default), use deployedCapital from contract
    // IMPORTANT: If deployedCapital is 0 (funds deposited directly, not through vault),
    // treat ALL balance as deployable capital (no profits yet)
    const deployedCapitalAmount = this.getDeployedCapitalAmount();
    if (deployedCapitalAmount === 0 && exchangeBalance > 0) {
      this.logger.debug(
        `${exchangeType}: Contract mode but no deployed capital tracked (direct deposit?), ` +
        `treating full balance $${exchangeBalance.toFixed(2)} as deployable`,
      );
      return exchangeBalance;
    }
    
    const accruedProfits = await this.getAccruedProfits(exchangeType);
    
    // Deployable = Balance - Accrued Profits
    const deployable = Math.max(0, exchangeBalance - accruedProfits);
    this.logger.debug(
      `${exchangeType}: Contract mode - balance $${exchangeBalance.toFixed(2)}, ` +
      `accrued profits $${accruedProfits.toFixed(4)}, deployable $${deployable.toFixed(2)}`,
    );
    return deployable;
  }

  /**
   * Manually set deployed capital (for funds deposited directly to exchanges, bypassing vault)
   * This is useful when capital was sent directly to exchange wallets without going through
   * the vault deposit flow (which would update the contract's deployedCapital).
   * 
   * @param amount The deployed capital amount in USDC
   */
  setManualDeployedCapital(amount: number): void {
    const previousAmount = this.getDeployedCapitalAmount();
    this.deployedCapital = BigInt(Math.round(amount * 1e6)); // Convert to 6 decimals
    this.logger.log(
      `📝 Manually set deployed capital: $${previousAmount.toFixed(2)} → $${amount.toFixed(2)} USDC`,
    );
  }

  /**
   * Sync deployed capital from actual exchange balances
   * Use this when funds were deposited directly to exchanges (bypassing vault)
   * This treats ALL current balance as deployed capital (no profits yet)
   */
  async syncDeployedCapitalFromBalances(): Promise<void> {
    await this.refreshExchangeBalances();
    const totalBalance = await this.getTotalBalance();
    
    if (totalBalance > 0) {
      const previousDeployed = this.getDeployedCapitalAmount();
      this.deployedCapital = BigInt(Math.round(totalBalance * 1e6));
      this.lastSyncTimestamp = new Date();
      
      this.logger.log(
        `🔄 Synced deployed capital from balances: $${previousDeployed.toFixed(2)} → $${totalBalance.toFixed(2)} USDC ` +
        `(treating current balance as deployed capital)`,
      );
    }
  }

  /**
   * Get profit info for a specific exchange
   */
  async getExchangeProfitInfo(exchangeType: ExchangeType): Promise<ExchangeProfitInfo> {
    const totalBalance = await this.getTotalBalance();
    const deployedCapitalTotal = this.getDeployedCapitalAmount();
    
    // Get this exchange's balance
    const currentBalance = this.exchangeBalances.get(exchangeType) || 0;
    
    // Calculate per-exchange deployed capital (proportional)
    const proportion = totalBalance > 0 ? currentBalance / totalBalance : 0;
    const deployedCapital = deployedCapitalTotal * proportion;
    
    // Calculate profits and deployable
    const accruedProfit = Math.max(0, currentBalance - deployedCapital);
    const deployableCapital = currentBalance - accruedProfit;

    return {
      exchange: exchangeType,
      currentBalance,
      deployedCapital,
      accruedProfit,
      deployableCapital,
    };
  }

  /**
   * Get full profit summary
   */
  async getProfitSummary(): Promise<ProfitSummary> {
    await this.refreshExchangeBalances();
    
    const totalBalance = await this.getTotalBalance();
    const totalDeployedCapital = this.getDeployedCapitalAmount();
    const totalAccruedProfit = await this.getTotalProfits();
    
    const byExchange = new Map<ExchangeType, ExchangeProfitInfo>();
    
    for (const exchangeType of [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER]) {
      const info = await this.getExchangeProfitInfo(exchangeType);
      byExchange.set(exchangeType, info);
    }

    return {
      totalBalance,
      totalDeployedCapital,
      totalAccruedProfit,
      byExchange,
      lastSyncTimestamp: this.lastSyncTimestamp,
      lastHarvestTimestamp: this.lastHarvestTimestamp,
      totalHarvestedAllTime: this.totalHarvestedAllTime,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HARVEST TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a successful harvest
   * Called by RewardHarvester after sending profits to vault
   */
  recordHarvest(amount: number): void {
    this.lastHarvestTimestamp = new Date();
    this.totalHarvestedAllTime += amount;
    
    this.logger.log(
      `Recorded harvest: $${amount.toFixed(2)} (total harvested: $${this.totalHarvestedAllTime.toFixed(2)})`,
    );
  }

  /**
   * Get last harvest timestamp
   */
  getLastHarvestTimestamp(): Date | null {
    return this.lastHarvestTimestamp;
  }

  /**
   * Get total harvested all time
   */
  getTotalHarvestedAllTime(): number {
    return this.totalHarvestedAllTime;
  }

  /**
   * Get time since last harvest in hours
   */
  getHoursSinceLastHarvest(): number | null {
    if (!this.lastHarvestTimestamp) {
      return null;
    }
    
    const now = Date.now();
    const lastHarvest = this.lastHarvestTimestamp.getTime();
    return (now - lastHarvest) / (1000 * 60 * 60);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC GETTERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if contract is configured and connected
   */
  isConfigured(): boolean {
    return this.contract !== null;
  }

  /**
   * Get last sync timestamp
   */
  getLastSyncTimestamp(): Date | null {
    return this.lastSyncTimestamp;
  }

  /**
   * Force a sync from contract
   */
  async forceSync(): Promise<void> {
    await this.syncFromContract();
  }
}

