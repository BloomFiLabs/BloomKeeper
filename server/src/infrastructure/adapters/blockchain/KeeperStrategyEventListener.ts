import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Contract,
  JsonRpcProvider,
  WebSocketProvider,
  formatUnits,
} from 'ethers';
import { EventEmitter } from 'events';

/**
 * Events emitted by the KeeperStrategyManager contract
 */
export interface CapitalDeployedEvent {
  deploymentId: bigint;
  amount: bigint;
  timestamp: bigint;
  blockNumber: number;
  transactionHash: string;
}

export interface WithdrawalRequestedEvent {
  requestId: bigint; // Strategy's request ID
  vaultRequestId?: bigint; // Vault's request ID (for marking fulfilled)
  amount: bigint;
  deadline: bigint;
  timestamp: bigint;
  blockNumber: number;
  transactionHash: string;
}

export interface EmergencyRecallEvent {
  totalDeployed: bigint;
  deadline: bigint;
  timestamp: bigint;
  blockNumber: number;
  transactionHash: string;
}

export interface ImmediateWithdrawalEvent {
  amount: bigint;
  timestamp: bigint;
  blockNumber: number;
  transactionHash: string;
}

export interface VaultWithdrawalRequestedEvent {
  vaultRequestId: bigint;
  user: string;
  assets: bigint;
  shares: bigint;
  timestamp: bigint;
  blockNumber: number;
  transactionHash: string;
}

/**
 * Internal event names for EventEmitter2
 */
export const KEEPER_STRATEGY_EVENTS = {
  CAPITAL_DEPLOYED: 'keeper-strategy.capital-deployed',
  WITHDRAWAL_REQUESTED: 'keeper-strategy.withdrawal-requested',
  VAULT_WITHDRAWAL_REQUESTED: 'keeper-strategy.vault-withdrawal-requested',
  IMMEDIATE_WITHDRAWAL: 'keeper-strategy.immediate-withdrawal',
  EMERGENCY_RECALL: 'keeper-strategy.emergency-recall',
} as const;

/**
 * KeeperStrategyEventListener - Listens to on-chain events from KeeperStrategyManager
 *
 * Monitors:
 * - CapitalDeployed: New funds deposited, keeper should bridge to exchanges
 * - WithdrawalRequested: User wants to withdraw, keeper should unwind positions
 * - EmergencyRecall: Emergency mode, keeper should return ALL funds ASAP
 */
@Injectable()
export class KeeperStrategyEventListener
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(KeeperStrategyEventListener.name);

  private provider: JsonRpcProvider | WebSocketProvider | null = null;
  private contract: Contract | null = null;
  private vaultContract: Contract | null = null;
  private isListening = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_DELAY = 5000;

  // Internal event emitter for notifying other services
  public readonly events = new EventEmitter();

  // Map transaction hash -> vault request ID for correlating strategy and vault events
  private txToVaultRequestId = new Map<string, bigint>();

  // Strategy Contract ABI (events and functions)
  private readonly CONTRACT_ABI = [
    'event CapitalDeployed(uint256 indexed deploymentId, uint256 amount, uint256 timestamp)',
    'event WithdrawalRequested(uint256 indexed requestId, uint256 amount, uint256 deadline, uint256 timestamp)',
    'event WithdrawalFulfilled(uint256 indexed requestId, uint256 amount, uint256 timestamp)',
    'event ImmediateWithdrawal(uint256 amount, uint256 timestamp)',
    'event NAVReported(uint256 nav, int256 pnl, uint256 timestamp)',
    'event EmergencyRecall(uint256 totalDeployed, uint256 deadline, uint256 timestamp)',
    'event CapitalWithdrawnToKeeper(uint256 amount, uint256 timestamp)',
    // View functions for querying state
    'function getWithdrawalRequest(uint256 requestId) external view returns (tuple(uint256 id, uint256 amount, uint256 requestedAt, uint256 deadline, bool fulfilled, bool cancelled))',
    'function getPendingWithdrawals() external view returns (tuple(uint256 id, uint256 amount, uint256 requestedAt, uint256 deadline, bool fulfilled, bool cancelled)[])',
    'function getStrategySummary() external view returns (uint256 deployedCapital, uint256 lastReportedNAV, uint256 pendingWithdrawals, uint256 idleBalance, int256 pnl)',
    'function getIdleBalance() external view returns (uint256)',
    // Write functions for keeper
    'function withdrawToKeeper(uint256 amount) external',
  ];

  // Vault Contract ABI (for withdrawal events)
  private readonly VAULT_ABI = [
    'event WithdrawalRequested(uint256 indexed requestId, address indexed user, uint256 assets, uint256 shares, uint256 timestamp)',
    'event WithdrawalFulfilled(uint256 indexed requestId, uint256 assets)',
    'event WithdrawalClaimed(uint256 indexed requestId, address indexed user, uint256 assets)',
  ];

  private readonly strategyAddress: string;
  private readonly vaultAddress: string;
  private readonly rpcUrl: string;
  private readonly wsUrl: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.strategyAddress = this.configService.get<string>(
      'KEEPER_STRATEGY_ADDRESS',
      '',
    );
    this.vaultAddress = this.configService.get<string>(
      'BLOOM_VAULT_ADDRESS',
      '',
    );
    this.rpcUrl = this.configService.get<string>(
      'ARBITRUM_RPC_URL',
      'https://arb1.arbitrum.io/rpc',
    );
    this.wsUrl = this.configService.get<string>('ARBITRUM_WS_URL');
  }

  async onModuleInit() {
    if (!this.strategyAddress) {
      this.logger.warn(
        'KEEPER_STRATEGY_ADDRESS not configured, event listener disabled',
      );
      return;
    }

    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  /**
   * Connect to the blockchain and start listening for events
   */
  private async connect(): Promise<void> {
    try {
      // Prefer WebSocket for real-time events, fallback to HTTP polling
      if (this.wsUrl) {
        this.logger.log(`Connecting via WebSocket: ${this.wsUrl}`);
        this.provider = new WebSocketProvider(this.wsUrl);
      } else {
        this.logger.log(`Connecting via HTTP RPC: ${this.rpcUrl}`);
        this.provider = new JsonRpcProvider(this.rpcUrl);
      }

      this.contract = new Contract(
        this.strategyAddress,
        this.CONTRACT_ABI,
        this.provider,
      );

      // Set up vault contract if address is configured
      if (this.vaultAddress) {
        this.vaultContract = new Contract(
          this.vaultAddress,
          this.VAULT_ABI,
          this.provider,
        );
        this.logger.log(`Vault contract connected at ${this.vaultAddress}`);
      }

      // Set up event listeners
      await this.setupEventListeners();

      this.isListening = true;
      this.reconnectAttempts = 0;
      this.logger.log(
        `Event listener started for KeeperStrategyManager at ${this.strategyAddress}`,
      );
    } catch (error: any) {
      this.logger.error(`Failed to connect: ${error.message}`);
      await this.handleReconnect();
    }
  }

  /**
   * Disconnect from the blockchain
   */
  private async disconnect(): Promise<void> {
    this.isListening = false;

    if (this.contract) {
      await this.contract.removeAllListeners();
      this.contract = null;
    }

    if (this.vaultContract) {
      await this.vaultContract.removeAllListeners();
      this.vaultContract = null;
    }

    if (this.provider) {
      if (this.provider instanceof WebSocketProvider) {
        await this.provider.destroy();
      }
      this.provider = null;
    }

    this.txToVaultRequestId.clear();
    this.logger.log('Event listener disconnected');
  }

  /**
   * Set up event listeners for contract events
   */
  private async setupEventListeners(): Promise<void> {
    if (!this.contract) return;

    // CapitalDeployed event
    this.contract.on(
      'CapitalDeployed',
      async (deploymentId, amount, timestamp, event) => {
        try {
          const eventData: CapitalDeployedEvent = {
            deploymentId,
            amount,
            timestamp,
            blockNumber: event.log.blockNumber,
            transactionHash: event.log.transactionHash,
          };

          this.logger.log(
            `📥 CapitalDeployed: ${formatUnits(amount, 6)} USDC (ID: ${deploymentId})`,
          );

          // Emit internal event for other services to handle
          this.events.emit(KEEPER_STRATEGY_EVENTS.CAPITAL_DEPLOYED, eventData);
        } catch (error: any) {
          this.logger.error(
            `Error processing CapitalDeployed event: ${error.message}`,
          );
        }
      },
    );

    // WithdrawalRequested event (from strategy)
    this.contract.on(
      'WithdrawalRequested',
      async (requestId, amount, deadline, timestamp, event) => {
        try {
          const txHash = event.log.transactionHash;

          // Look up the correlated vault request ID from the same transaction
          const vaultRequestId = this.txToVaultRequestId.get(txHash);

          const eventData: WithdrawalRequestedEvent = {
            requestId,
            vaultRequestId, // Will be undefined if vault event wasn't received first
            amount,
            deadline,
            timestamp,
            blockNumber: event.log.blockNumber,
            transactionHash: txHash,
          };

          const deadlineDate = new Date(Number(deadline) * 1000);
          this.logger.warn(
            `📤 WithdrawalRequested: ${formatUnits(amount, 6)} USDC (strategyID: ${requestId}, vaultID: ${vaultRequestId ?? 'unknown'}, deadline: ${deadlineDate.toISOString()})`,
          );

          // Clean up the mapping now that we've used it
          if (vaultRequestId !== undefined) {
            this.txToVaultRequestId.delete(txHash);
          }

          // Emit internal event for withdrawal fulfiller to handle
          this.events.emit(
            KEEPER_STRATEGY_EVENTS.WITHDRAWAL_REQUESTED,
            eventData,
          );
        } catch (error: any) {
          this.logger.error(
            `Error processing WithdrawalRequested event: ${error.message}`,
          );
        }
      },
    );

    // ImmediateWithdrawal event - Strategy had idle funds and fulfilled immediately
    this.contract.on(
      'ImmediateWithdrawal',
      async (amount, timestamp, event) => {
        try {
          const eventData: ImmediateWithdrawalEvent = {
            amount,
            timestamp,
            blockNumber: event.log.blockNumber,
            transactionHash: event.log.transactionHash,
          };

          this.logger.log(
            `⚡ ImmediateWithdrawal: ${formatUnits(amount, 6)} USDC fulfilled immediately`,
          );

          // Emit internal event for withdrawal fulfiller to mark vault requests as fulfilled
          this.events.emit(
            KEEPER_STRATEGY_EVENTS.IMMEDIATE_WITHDRAWAL,
            eventData,
          );
        } catch (error: any) {
          this.logger.error(
            `Error processing ImmediateWithdrawal event: ${error.message}`,
          );
        }
      },
    );

    // EmergencyRecall event
    this.contract.on(
      'EmergencyRecall',
      async (totalDeployed, deadline, timestamp, event) => {
        try {
          const eventData: EmergencyRecallEvent = {
            totalDeployed,
            deadline,
            timestamp,
            blockNumber: event.log.blockNumber,
            transactionHash: event.log.transactionHash,
          };

          const deadlineDate = new Date(Number(deadline) * 1000);
          this.logger.error(
            `🚨 EMERGENCY RECALL: Return ${formatUnits(totalDeployed, 6)} USDC by ${deadlineDate.toISOString()}`,
          );

          // Emit internal event for emergency handling
          this.events.emit(KEEPER_STRATEGY_EVENTS.EMERGENCY_RECALL, eventData);
        } catch (error: any) {
          this.logger.error(
            `Error processing EmergencyRecall event: ${error.message}`,
          );
        }
      },
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // VAULT CONTRACT EVENTS - for correlating vault request IDs
    // ═══════════════════════════════════════════════════════════════════════════

    if (this.vaultContract) {
      // Vault WithdrawalRequested event - happens BEFORE strategy's event in same tx
      this.vaultContract.on(
        'WithdrawalRequested',
        async (requestId, user, assets, shares, timestamp, event) => {
          try {
            const txHash = event.log.transactionHash;

            // Store mapping for correlation with strategy event
            this.txToVaultRequestId.set(txHash, requestId);

            this.logger.log(
              `🏦 Vault WithdrawalRequested: ID=${requestId}, user=${user}, assets=${formatUnits(assets, 6)} USDC`,
            );

            const eventData: VaultWithdrawalRequestedEvent = {
              vaultRequestId: requestId,
              user,
              assets,
              shares,
              timestamp,
              blockNumber: event.log.blockNumber,
              transactionHash: txHash,
            };

            // Emit vault event for tracking
            this.events.emit(
              KEEPER_STRATEGY_EVENTS.VAULT_WITHDRAWAL_REQUESTED,
              eventData,
            );

            // Clean up old mappings after 1 minute (in case strategy event never comes)
            setTimeout(() => {
              this.txToVaultRequestId.delete(txHash);
            }, 60000);
          } catch (error: any) {
            this.logger.error(
              `Error processing Vault WithdrawalRequested event: ${error.message}`,
            );
          }
        },
      );
    }

    // Handle provider errors for reconnection
    if (this.provider instanceof WebSocketProvider) {
      // Note: ethers v6 WebSocketProvider has different event handling
      // We use the provider's error event instead
      this.provider.on('error', async (error: any) => {
        this.logger.error(`Provider error: ${error.message}`);
        await this.handleReconnect();
      });
    }
  }

  /**
   * Handle reconnection with exponential backoff
   */
  private async handleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        `Max reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached`,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay =
      this.RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1);

    this.logger.log(
      `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`,
    );

    await this.disconnect();
    await new Promise((resolve) => setTimeout(resolve, delay));
    await this.connect();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC QUERY METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get pending withdrawal requests from contract
   */
  async getPendingWithdrawals(): Promise<
    Array<{
      id: bigint;
      amount: bigint;
      requestedAt: bigint;
      deadline: bigint;
      fulfilled: boolean;
      cancelled: boolean;
    }>
  > {
    if (!this.contract) {
      throw new Error('Contract not connected');
    }

    try {
      const requests = await this.contract.getPendingWithdrawals();
      return requests.map((r: any) => ({
        id: r.id,
        amount: r.amount,
        requestedAt: r.requestedAt,
        deadline: r.deadline,
        fulfilled: r.fulfilled,
        cancelled: r.cancelled,
      }));
    } catch (error: any) {
      this.logger.error(`Failed to get pending withdrawals: ${error.message}`);
      return [];
    }
  }

  /**
   * Get strategy summary from contract
   */
  async getStrategySummary(): Promise<{
    deployedCapital: bigint;
    lastReportedNAV: bigint;
    pendingWithdrawals: bigint;
    idleBalance: bigint;
    pnl: bigint;
  } | null> {
    if (!this.contract) {
      throw new Error('Contract not connected');
    }

    try {
      const [
        deployedCapital,
        lastReportedNAV,
        pendingWithdrawals,
        idleBalance,
        pnl,
      ] = await this.contract.getStrategySummary();

      return {
        deployedCapital,
        lastReportedNAV,
        pendingWithdrawals,
        idleBalance,
        pnl,
      };
    } catch (error: any) {
      this.logger.error(`Failed to get strategy summary: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if the listener is connected and listening
   */
  isConnected(): boolean {
    return this.isListening && this.contract !== null;
  }

  /**
   * Get the strategy contract address
   */
  getStrategyAddress(): string {
    return this.strategyAddress;
  }
}
