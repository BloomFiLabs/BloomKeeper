import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Contract, Wallet, JsonRpcProvider, formatUnits } from 'ethers';
import { IStrategyExecutor } from '../../../domain/ports/IStrategyExecutor';

@Injectable()
export class EthersStrategyExecutor implements IStrategyExecutor {
  private readonly logger = new Logger(EthersStrategyExecutor.name);
  private wallet: Wallet;
  private provider: JsonRpcProvider;

  private readonly STRATEGY_ABI = [
    'function rebalance(uint256 rangePct1e5) external',
    'function emergencyExit() external',
    'function harvest() external',
  ];

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>(
      'RPC_URL',
      'http://localhost:8545',
    );
    const privateKey = this.configService.get<string>('KEEPER_PRIVATE_KEY');

    this.provider = new JsonRpcProvider(rpcUrl);

    if (privateKey) {
      this.wallet = new Wallet(privateKey, this.provider);
    } else {
      this.logger.warn('No private key provided, execution will fail');
    }
  }

  async rebalance(
    strategyAddress: string,
    rangePct1e5?: bigint,
  ): Promise<string> {
    return this.executeWithRetry(
      () => this._rebalance(strategyAddress, rangePct1e5),
      'rebalance',
    );
  }

  async emergencyExit(strategyAddress: string): Promise<string> {
    return this.executeWithRetry(
      () => this._emergencyExit(strategyAddress),
      'emergencyExit',
    );
  }

  async harvest(strategyAddress: string): Promise<string> {
    return this.executeWithRetry(
      () => this._harvest(strategyAddress),
      'harvest',
    );
  }

  async getLastHarvestAmount(strategyAddress: string): Promise<number> {
    try {
      const EVENT_ABI = ['event ManagerFeeTaken(uint256 amount)'];

      const contract = new Contract(strategyAddress, EVENT_ABI, this.provider);
      const latestBlock = await this.provider.getBlockNumber();
      const fromBlock = Math.max(0, latestBlock - 100); // Last ~200 seconds on Base

      const filter = contract.filters.ManagerFeeTaken();
      const events = await contract.queryFilter(filter, fromBlock, latestBlock);

      if (events.length > 0) {
        const lastEvent = events[events.length - 1];
        // Cast to EventLog to access args
        if ('args' in lastEvent && lastEvent.args) {
          const managerFee = Number(formatUnits(lastEvent.args.amount, 6)); // USDC has 6 decimals
          const totalCollected = managerFee / 0.2; // Manager gets 20%, so total = managerFee / 0.2

          this.logger.log(
            `📊 Last harvest: Manager fee = $${managerFee.toFixed(4)}, Total = $${totalCollected.toFixed(4)}`,
          );
          return totalCollected;
        }
      }

      return 0;
    } catch (error) {
      this.logger.warn(`Could not query harvest events: ${error.message}`);
      return 0;
    }
  }

  private async _rebalance(
    strategyAddress: string,
    rangePct1e5?: bigint,
  ): Promise<string> {
    if (!this.wallet) throw new Error('Keeper wallet not initialized');

    // Use provided range or 0 (contract will use activeRange)
    const rangeParam = rangePct1e5 ?? 0n;
    this.logger.log(
      `Executing rebalance on ${strategyAddress} with range ${rangeParam.toString()}...`,
    );
    const contract = new Contract(
      strategyAddress,
      this.STRATEGY_ABI,
      this.wallet,
    );

    // Estimate gas
    let gasLimit;
    try {
      gasLimit = await contract.rebalance.estimateGas(rangeParam);
      // Add buffer
      gasLimit = (gasLimit * 120n) / 100n;
    } catch (e) {
      this.logger.warn(`Gas estimation failed, using default: ${e.message}`);
      gasLimit = 3000000n; // Fallback
    }

    const tx = await contract.rebalance(rangeParam, { gasLimit });
    this.logger.log(`Transaction sent: ${tx.hash}`);

    const receipt = await tx.wait();
    this.logger.log(`Transaction confirmed: ${receipt.hash}`);

    return receipt.hash;
  }

  private async _emergencyExit(strategyAddress: string): Promise<string> {
    if (!this.wallet) throw new Error('Keeper wallet not initialized');

    this.logger.log(`Executing emergency exit on ${strategyAddress}...`);
    const contract = new Contract(
      strategyAddress,
      this.STRATEGY_ABI,
      this.wallet,
    );

    const tx = await contract.emergencyExit();
    this.logger.log(`Transaction sent: ${tx.hash}`);

    const receipt = await tx.wait();
    return receipt.hash;
  }

  private async _harvest(strategyAddress: string): Promise<string> {
    if (!this.wallet) throw new Error('Keeper wallet not initialized');

    this.logger.log(`💰 Collecting trading fees from ${strategyAddress}...`);
    const contract = new Contract(
      strategyAddress,
      this.STRATEGY_ABI,
      this.wallet,
    );

    const tx = await contract.harvest();
    this.logger.log(`Transaction sent: ${tx.hash}`);

    const receipt = await tx.wait();
    this.logger.log(`✅ Fees collected and distributed to vault`);
    return receipt.hash;
  }

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: string,
    retries = 3,
  ): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await operation();
      } catch (error) {
        this.logger.warn(
          `Attempt ${i + 1}/${retries} failed for ${context}: ${error.message}`,
        );
        if (i === retries - 1) throw error;

        // Exponential backoff
        const delay = 1000 * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('Unreachable');
  }
}
