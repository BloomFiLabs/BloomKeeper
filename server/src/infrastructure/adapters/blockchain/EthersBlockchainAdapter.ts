import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { IBlockchainAdapter } from '../../../domain/ports/IBlockchainAdapter';

@Injectable()
export class EthersBlockchainAdapter implements IBlockchainAdapter {
  private provider: ethers.JsonRpcProvider;

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('RPC_URL') || 'https://mainnet.base.org';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  async getStrategyState(strategyAddress: string): Promise<{ totalAssets: bigint; totalPrincipal: bigint }> {
    const strategyAbi = [
      'function totalAssets() view returns (uint256)',
      'function totalPrincipal() view returns (uint256)',
    ];
    const strategy = new ethers.Contract(strategyAddress, strategyAbi, this.provider);
    const totalAssets = await strategy.totalAssets();
    const totalPrincipal = await strategy.totalPrincipal();
    return { totalAssets, totalPrincipal };
  }

  async getGasPriceGwei(): Promise<number> {
    const feeData = await this.provider.getFeeData();
    return feeData.gasPrice ? Number(ethers.formatUnits(feeData.gasPrice, "gwei")) : 0.1;
  }

  async getStrategyPositionRange(strategyAddress: string): Promise<{ lower: number; upper: number } | null> {
    try {
      const strategyAbi = ['function liquidityManager() view returns (address)'];
      const strategy = new ethers.Contract(strategyAddress, strategyAbi, this.provider);
      const lrmAddress = await strategy.liquidityManager();
      
      const nftManager = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
      const nftAbi = [
        'function balanceOf(address) view returns (uint256)',
        'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
        'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
      ];
      const nftContract = new ethers.Contract(nftManager, nftAbi, this.provider);
      
      const balance = await nftContract.balanceOf(lrmAddress);
      if (balance === 0n) return null;
      
      const tokenId = await nftContract.tokenOfOwnerByIndex(lrmAddress, 0);
      const position = await nftContract.positions(tokenId);
      const tickLower = Number(position[5]);
      const tickUpper = Number(position[6]);
      
      return {
        lower: this.tickToPrice(tickLower),
        upper: this.tickToPrice(tickUpper),
      };
    } catch (error) {
      return null;
    }
  }

  private tickToPrice(tick: number): number {
    return Math.pow(1.0001, tick) * 1e12;
  }
}


