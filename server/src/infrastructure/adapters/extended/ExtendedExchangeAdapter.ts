import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { ExchangeConfig, ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../../domain/entities/PerpPosition';
import { IPerpExchangeAdapter, ExchangeError, FundingPayment } from '../../../domain/ports/IPerpExchangeAdapter';
import { ExtendedSigningService } from './ExtendedSigningService';

/**
 * ExtendedExchangeAdapter - Implements IPerpExchangeAdapter for Extended exchange
 * 
 * Extended is a Starknet-based perpetual exchange that uses:
 * - SNIP12/EIP712 signing for orders
 * - Vault-based account system
 * - Arbitrum for deposits/withdrawals
 * - REST API at https://api.extended.exchange
 */
@Injectable()
export class ExtendedExchangeAdapter implements IPerpExchangeAdapter {
  private readonly logger = new Logger(ExtendedExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private readonly client: AxiosInstance;
  private readonly signingService: ExtendedSigningService;
  private readonly apiKey: string;
  private readonly vaultNumber: number;
  private readonly isTestnet: boolean;
  
  // Arbitrum configuration for deposits/withdrawals
  private readonly ARBITRUM_CHAIN_ID = 42161;
  private readonly ARBITRUM_RPC_URL: string;
  private readonly arbitrumWallet: ethers.Wallet | null;

  // Cache for symbol -> market ID mapping
  private symbolToMarketIdCache: Map<string, string> = new Map();
  private marketIdCacheTimestamp: number = 0;
  private readonly MARKET_ID_CACHE_TTL = 3600000; // 1 hour

  constructor(private readonly configService: ConfigService) {
    const baseUrl = this.configService.get<string>('EXTENDED_API_BASE_URL') || 'https://api.extended.exchange';
    const apiKey = this.configService.get<string>('EXTENDED_API_KEY');
    const starkKey = this.configService.get<string>('EXTENDED_STARK_KEY');
    const vaultNumber = parseInt(this.configService.get<string>('EXTENDED_VAULT_NUMBER') || '0');
    const isTestnet = this.configService.get<string>('EXTENDED_TESTNET') === 'true';
    const starknetRpcUrl = this.configService.get<string>('EXTENDED_STARKNET_RPC_URL');

    if (!apiKey) {
      throw new Error('Extended exchange requires EXTENDED_API_KEY');
    }
    if (!starkKey) {
      throw new Error('Extended exchange requires EXTENDED_STARK_KEY');
    }
    if (vaultNumber === 0) {
      throw new Error('Extended exchange requires EXTENDED_VAULT_NUMBER');
    }

    this.apiKey = apiKey;
    this.vaultNumber = vaultNumber;
    this.isTestnet = isTestnet;

    // Initialize signing service
    this.signingService = new ExtendedSigningService(starkKey, isTestnet);

    // Initialize Arbitrum wallet for deposits/withdrawals
    const privateKey = this.configService.get<string>('PRIVATE_KEY') || 
                      this.configService.get<string>('EXTENDED_PRIVATE_KEY');
    this.ARBITRUM_RPC_URL = this.configService.get<string>('ARBITRUM_RPC_URL') ||
                            this.configService.get<string>('ARB_RPC_URL') ||
                            'https://arb1.arbitrum.io/rpc';

    if (privateKey) {
      const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const provider = new ethers.JsonRpcProvider(this.ARBITRUM_RPC_URL);
      this.arbitrumWallet = new ethers.Wallet(normalizedPrivateKey, provider);
    } else {
      this.arbitrumWallet = null;
    }

    this.config = new ExchangeConfig(
      ExchangeType.EXTENDED,
      baseUrl,
      apiKey,
      undefined,
      privateKey,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      starkKey,
      vaultNumber,
      starknetRpcUrl,
    );

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: this.config.getTimeout(),
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    this.logger.log(`Extended adapter initialized for vault: ${vaultNumber} (testnet: ${isTestnet})`);
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): string {
    return ExchangeType.EXTENDED;
  }

  /**
   * Refresh symbol to market ID cache from Extended API
   */
  private async refreshSymbolCache(): Promise<void> {
    const now = Date.now();
    if (this.symbolToMarketIdCache.size > 0 && (now - this.marketIdCacheTimestamp) < this.MARKET_ID_CACHE_TTL) {
      return;
    }

    try {
      const response = await this.client.get('/v1/public/markets');
      if (response.data && Array.isArray(response.data)) {
        this.symbolToMarketIdCache.clear();
        for (const market of response.data) {
          if (market.symbol && market.marketId) {
            this.symbolToMarketIdCache.set(market.symbol.toUpperCase(), market.marketId);
          }
        }
        this.marketIdCacheTimestamp = now;
        this.logger.debug(`Cached ${this.symbolToMarketIdCache.size} market IDs from Extended API`);
      }
    } catch (error: any) {
      this.logger.warn(`Failed to refresh symbol cache: ${error.message}`);
    }
  }

  /**
   * Get market ID for a symbol
   */
  private async getMarketId(symbol: string): Promise<string> {
    await this.refreshSymbolCache();
    const normalizedSymbol = symbol.toUpperCase().replace('USDC', '').replace('USDT', '').replace('-PERP', '');
    const marketId = this.symbolToMarketIdCache.get(normalizedSymbol);
    if (!marketId) {
      throw new ExchangeError(
        `Market not found for symbol: ${symbol}`,
        ExchangeType.EXTENDED,
        'MARKET_NOT_FOUND',
      );
    }
    return marketId;
  }

  /**
   * Create authentication headers for API requests
   */
  private getAuthHeaders(): Record<string, string> {
    return {
      'X-API-Key': this.apiKey,
      'X-Vault-Number': this.vaultNumber.toString(),
    };
  }

  async placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse> {
    try {
      const marketId = await this.getMarketId(request.symbol);
      const side = request.side === OrderSide.LONG ? 'buy' : 'sell';
      const orderType = request.type === OrderType.MARKET ? 'market' : 'limit';
      
      // Get current timestamp for expiration (default 24h)
      const expiration = Math.floor(Date.now() / 1000) + 86400;

      // Build order data for signing
      const orderData = {
        symbol: request.symbol,
        side: side as 'buy' | 'sell',
        orderType: orderType as 'limit' | 'market',
        size: request.size.toString(),
        price: request.price?.toString() || '0',
        timeInForce: request.timeInForce === TimeInForce.IOC ? 'IOC' : 'GTC',
        reduceOnly: request.reduceOnly || false,
        postOnly: false, // Extended doesn't support postOnly in PerpOrderRequest
        expiration,
        clientOrderId: request.clientOrderId || '',
      };

      // Sign the order
      const signature = await this.signingService.signOrder(orderData);

      // Build API request payload
      const payload: any = {
        marketId,
        side,
        orderType,
        size: request.size.toString(),
        vaultNumber: this.vaultNumber,
        signature,
      };

      if (request.price) {
        payload.price = request.price.toString();
      }
      if (request.timeInForce === TimeInForce.IOC) {
        payload.timeInForce = 'IOC';
      }
      if (request.reduceOnly) {
        payload.reduceOnly = true;
      }
      if (request.clientOrderId) {
        payload.clientOrderId = request.clientOrderId;
      }
      payload.expiration = expiration;

      // Submit order to Extended API
      const response = await this.client.post('/v1/orders', payload, {
        headers: this.getAuthHeaders(),
      });

      if (response.data && response.data.orderId) {
        const orderId = response.data.orderId.toString();
        const status = response.data.status === 'filled' ? OrderStatus.FILLED : OrderStatus.SUBMITTED;
        
        this.logger.log(
          `✅ Order placed on Extended: ${orderId} - ${side} ${request.size} ${request.symbol} @ ${request.price || 'market'}`
        );

        return new PerpOrderResponse(
          orderId,
          status,
          request.symbol,
          request.side,
          request.clientOrderId,
          response.data.filledSize ? parseFloat(response.data.filledSize) : undefined,
          response.data.averageFillPrice ? parseFloat(response.data.averageFillPrice) : undefined,
          undefined,
          new Date(),
        );
      } else {
        throw new Error(`Unexpected order response: ${JSON.stringify(response.data)}`);
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      this.logger.error(`Failed to place order on Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to place order: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async getPosition(symbol: string): Promise<PerpPosition | null> {
    try {
      const positions = await this.getPositions();
      return positions.find(p => p.symbol === symbol) || null;
    } catch (error: any) {
      throw new ExchangeError(
        `Failed to get position: ${error.message}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  async getPositions(): Promise<PerpPosition[]> {
    try {
      const response = await this.client.get('/v1/positions', {
        headers: this.getAuthHeaders(),
      });

      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      const positions: PerpPosition[] = [];
      for (const pos of response.data) {
        if (parseFloat(pos.size || '0') !== 0) {
          positions.push(new PerpPosition(
            ExchangeType.EXTENDED,
            pos.symbol,
            parseFloat(pos.size) > 0 ? OrderSide.LONG : OrderSide.SHORT,
            Math.abs(parseFloat(pos.size)),
            parseFloat(pos.entryPrice || '0'),
            parseFloat(pos.markPrice || '0'),
            parseFloat(pos.unrealizedPnl || '0'),
            parseFloat(pos.leverage || '1'),
            parseFloat(pos.liquidationPrice || '0'),
            undefined,
            new Date(),
          ));
        }
      }

      return positions;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      this.logger.error(`Failed to get positions from Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to get positions: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      await this.client.delete(`/v1/orders/${orderId}`, {
        headers: this.getAuthHeaders(),
      });
      this.logger.log(`✅ Order cancelled on Extended: ${orderId}`);
      return true;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      this.logger.error(`Failed to cancel order on Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to cancel order: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    try {
      const marketId = await this.getMarketId(symbol);
      const response = await this.client.delete('/v1/orders', {
        headers: this.getAuthHeaders(),
        params: { marketId },
      });
      
      const cancelledCount = response.data?.cancelledCount || 0;
      this.logger.log(`✅ Cancelled ${cancelledCount} orders on Extended for ${symbol}`);
      return cancelledCount;
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      this.logger.error(`Failed to cancel all orders on Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to cancel all orders: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    try {
      const response = await this.client.get(`/v1/orders/${orderId}`, {
        headers: this.getAuthHeaders(),
      });

      if (!response.data) {
        throw new Error(`Order not found: ${orderId}`);
      }

      const order = response.data;
      const statusMap: Record<string, OrderStatus> = {
        'open': OrderStatus.SUBMITTED,
        'filled': OrderStatus.FILLED,
        'cancelled': OrderStatus.CANCELLED,
        'rejected': OrderStatus.REJECTED,
        'expired': OrderStatus.EXPIRED,
      };

      return new PerpOrderResponse(
        order.orderId.toString(),
        statusMap[order.status] || OrderStatus.SUBMITTED,
        order.symbol,
        order.side === 'buy' ? OrderSide.LONG : OrderSide.SHORT,
        order.clientOrderId,
        parseFloat(order.filledSize || '0') || undefined,
        order.averageFillPrice ? parseFloat(order.averageFillPrice) : undefined,
        undefined,
        order.timestamp ? new Date(order.timestamp) : new Date(),
      );
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to get order status: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async getMarkPrice(symbol: string): Promise<number> {
    try {
      const marketId = await this.getMarketId(symbol);
      const response = await this.client.get(`/v1/public/markets/${marketId}/mark-price`);
      
      if (response.data && response.data.markPrice) {
        return parseFloat(response.data.markPrice);
      }
      throw new Error(`Mark price not found for ${symbol}`);
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to get mark price: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async getBalance(): Promise<number> {
    try {
      const response = await this.client.get('/v1/account/balance', {
        headers: this.getAuthHeaders(),
      });

      if (response.data && response.data.availableBalance !== undefined) {
        return parseFloat(response.data.availableBalance);
      }
      throw new Error('Balance not found in response');
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to get balance: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async getEquity(): Promise<number> {
    try {
      const response = await this.client.get('/v1/account/equity', {
        headers: this.getAuthHeaders(),
      });

      if (response.data && response.data.totalEquity !== undefined) {
        return parseFloat(response.data.totalEquity);
      }
      throw new Error('Equity not found in response');
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to get equity: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.testConnection();
      return true;
    } catch {
      return false;
    }
  }

  async testConnection(): Promise<void> {
    try {
      await this.client.get('/v1/public/ping', { timeout: 5000 });
    } catch (error: any) {
      throw new ExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  async transferInternal(amount: number, toPerp: boolean): Promise<string> {
    // Extended uses vault-based system, internal transfers are between vaults
    // This is a simplified implementation - adjust based on actual API
    try {
      const transferData = {
        asset: 'USDC',
        amount: amount.toString(),
        toVault: toPerp ? this.vaultNumber : 0, // Simplified - adjust based on actual API
      };

      const signature = await this.signingService.signTransfer(transferData);

      const response = await this.client.post('/v1/transfers', {
        ...transferData,
        signature,
      }, {
        headers: this.getAuthHeaders(),
      });

      if (response.data && response.data.transferId) {
        return response.data.transferId.toString();
      }
      throw new Error(`Transfer failed: ${JSON.stringify(response.data)}`);
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      throw new ExchangeError(
        `Failed to transfer: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  async depositExternal(amount: number, asset: string, destination?: string): Promise<string> {
    // Extended deposits from Arbitrum
    if (!this.arbitrumWallet) {
      throw new ExchangeError(
        'PRIVATE_KEY required for Arbitrum deposits',
        ExchangeType.EXTENDED,
        'MISSING_PRIVATE_KEY',
      );
    }

    try {
      // Get bridge quote from Extended API
      const quoteResponse = await this.client.get('/v1/bridge/quote', {
        params: {
          fromChain: 'arbitrum',
          toChain: 'starknet',
          asset: asset.toUpperCase(),
          amount: amount.toString(),
        },
      });

      if (!quoteResponse.data || !quoteResponse.data.depositAddress) {
        throw new Error('Failed to get deposit address from Extended');
      }

      const depositAddress = quoteResponse.data.depositAddress;
      const usdcContractAddress = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // USDC on Arbitrum

      // ERC20 ABI for approve and transfer
      const erc20Abi = [
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)',
      ];

      const usdcContract = new ethers.Contract(usdcContractAddress, erc20Abi, this.arbitrumWallet);
      const decimals = await usdcContract.decimals();
      const amountWei = ethers.parseUnits(amount.toString(), decimals);

      // Approve Extended bridge contract
      this.logger.log(`Approving Extended bridge contract: ${depositAddress}`);
      const approveTx = await usdcContract.approve(depositAddress, amountWei);
      await approveTx.wait();

      // Transfer USDC to Extended bridge
      this.logger.log(`Depositing ${amount} ${asset} to Extended via Arbitrum bridge...`);
      const transferTx = await usdcContract.transfer(depositAddress, amountWei);
      const receipt = await transferTx.wait();

      if (receipt.status === 1) {
        this.logger.log(`✅ Deposit successful! Transaction: ${receipt.hash}`);
        return receipt.hash;
      } else {
        throw new Error(`Deposit transaction failed: ${receipt.hash}`);
      }
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      this.logger.error(`Failed to deposit to Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to deposit: ${errorMsg}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  async withdrawExternal(amount: number, asset: string, destination: string): Promise<string> {
    // Extended withdrawals to Arbitrum
    if (!this.arbitrumWallet) {
      throw new ExchangeError(
        'PRIVATE_KEY required for Arbitrum withdrawals',
        ExchangeType.EXTENDED,
        'MISSING_PRIVATE_KEY',
      );
    }

    try {
      // Get bridge quote
      const quoteResponse = await this.client.get('/v1/bridge/quote', {
        params: {
          fromChain: 'starknet',
          toChain: 'arbitrum',
          asset: asset.toUpperCase(),
          amount: amount.toString(),
        },
      });

      if (!quoteResponse.data) {
        throw new Error('Failed to get withdrawal quote from Extended');
      }

      // Sign withdrawal request
      const withdrawalData = {
        asset: asset.toUpperCase(),
        amount: amount.toString(),
        destinationAddress: destination,
        chainId: this.ARBITRUM_CHAIN_ID,
        expiration: Math.floor(Date.now() / 1000) + 14 * 24 * 3600, // 14 days
      };

      const signature = await this.signingService.signWithdrawal(withdrawalData);

      // Submit withdrawal request
      const response = await this.client.post('/v1/withdrawals', {
        ...withdrawalData,
        signature,
        vaultNumber: this.vaultNumber,
      }, {
        headers: this.getAuthHeaders(),
      });

      if (response.data && response.data.withdrawalId) {
        const withdrawalId = response.data.withdrawalId.toString();
        this.logger.log(
          `✅ Withdrawal initiated on Extended: ${withdrawalId} - ${amount} ${asset} to ${destination} (Arbitrum)`
        );
        return withdrawalId;
      } else {
        throw new Error(`Withdrawal failed: ${JSON.stringify(response.data)}`);
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || String(error);
      this.logger.error(`Failed to withdraw from Extended: ${errorMsg}`);
      throw new ExchangeError(
        `Failed to withdraw: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
        error,
      );
    }
  }

  /**
   * Get historical funding payments for the account
   * Extended funding is paid continuously, so this may need different handling
   * @param startTime Optional start time in milliseconds (default: 7 days ago)
   * @param endTime Optional end time in milliseconds (default: now)
   * @returns Array of funding payments
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPayment[]> {
    // Extended funding API endpoint (if available)
    // For now, return empty array as we don't have confirmed API endpoint
    try {
      const now = Date.now();
      const start = startTime || now - (7 * 24 * 60 * 60 * 1000);
      const end = endTime || now;

      // Try to get funding history from Extended API
      const response = await this.client.get('/v1/user/funding-history', {
        params: {
          startTime: start,
          endTime: end,
        },
        headers: this.getAuthHeaders(),
        timeout: 30000,
      });

      if (Array.isArray(response.data)) {
        return response.data.map((entry: any) => ({
          exchange: ExchangeType.EXTENDED,
          symbol: entry.symbol || entry.market || 'UNKNOWN',
          amount: parseFloat(entry.amount || entry.funding || '0'),
          fundingRate: parseFloat(entry.rate || entry.fundingRate || '0'),
          positionSize: parseFloat(entry.size || entry.positionSize || '0'),
          timestamp: new Date(entry.timestamp || entry.time || Date.now()),
        }));
      }

      return [];
    } catch (error: any) {
      // Don't throw - just return empty if endpoint doesn't exist
      this.logger.debug(`Extended funding history not available: ${error.message}`);
      return [];
    }
  }
}

