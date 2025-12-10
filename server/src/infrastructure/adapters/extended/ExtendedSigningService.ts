import { Injectable, Logger } from '@nestjs/common';
import { ec, hash, typedData } from 'starknet';

/**
 * ExtendedSigningService - Handles Starknet SNIP12/EIP712 signing for Extended exchange
 * 
 * Extended uses SNIP12 standard (EIP712 for Starknet) for signing orders and withdrawals
 * Domain: { name: "Perpetuals", version: "v0", chainId: "SN_MAIN" } (or "SN_SEPOLIA" for testnet)
 */
@Injectable()
export class ExtendedSigningService {
  private readonly logger = new Logger(ExtendedSigningService.name);
  private readonly starkPrivateKey: string;

  constructor(starkPrivateKey: string, private readonly isTestnet: boolean = false) {
    // Normalize private key (remove 0x if present)
    this.starkPrivateKey = starkPrivateKey.startsWith('0x') 
      ? starkPrivateKey.slice(2) 
      : starkPrivateKey;
    
    this.logger.debug(`ExtendedSigningService initialized (testnet: ${isTestnet})`);
  }

  /**
   * Get the EIP712 domain for Extended exchange
   */
  private getDomain(): any {
    return {
      name: 'Perpetuals',
      version: 'v0',
      chainId: this.isTestnet ? 'SN_SEPOLIA' : 'SN_MAIN',
      revision: '1',
    };
  }

  /**
   * Sign an order using SNIP12/EIP712
   * @param orderData Order data to sign
   * @returns Signature string
   */
  async signOrder(orderData: {
    symbol: string;
    side: 'buy' | 'sell';
    orderType: 'limit' | 'market';
    size: string;
    price?: string;
    timeInForce?: string;
    reduceOnly?: boolean;
    postOnly?: boolean;
    expiration?: number;
    clientOrderId?: string;
  }): Promise<string> {
    const domain = this.getDomain();
    
    // Extended order types (based on API docs)
    const types = {
      Order: [
        { name: 'symbol', type: 'felt252' },
        { name: 'side', type: 'felt252' },
        { name: 'orderType', type: 'felt252' },
        { name: 'size', type: 'u256' },
        { name: 'price', type: 'u256' },
        { name: 'timeInForce', type: 'felt252' },
        { name: 'reduceOnly', type: 'bool' },
        { name: 'postOnly', type: 'bool' },
        { name: 'expiration', type: 'u64' },
        { name: 'clientOrderId', type: 'felt252' },
      ],
    };

    const message = {
      symbol: orderData.symbol,
      side: orderData.side,
      orderType: orderData.orderType,
      size: orderData.size,
      price: orderData.price || '0',
      timeInForce: orderData.timeInForce || 'GTC',
      reduceOnly: orderData.reduceOnly || false,
      postOnly: orderData.postOnly || false,
      expiration: orderData.expiration || Math.floor(Date.now() / 1000) + 86400, // Default 24h expiry
      clientOrderId: orderData.clientOrderId || '',
    };

    try {
      // Sign using starknet typed data signing
      const typedDataObj = {
        domain,
        types,
        primaryType: 'Order',
        message,
      };
      // getMessageHash requires account address as second parameter
      // For Extended, we use the public key derived from private key
      const accountAddress = ec.starkCurve.getPublicKey(this.starkPrivateKey);
      const accountAddressHex = `0x${Array.from(accountAddress).map(b => b.toString(16).padStart(2, '0')).join('')}`;
      const typedDataHash = typedData.getMessageHash(typedDataObj, accountAddressHex);
      const signature = ec.starkCurve.sign(typedDataHash, this.starkPrivateKey);
      
      // Convert signature to hex string format expected by Extended API
      return `0x${signature.r.toString(16).padStart(64, '0')}${signature.s.toString(16).padStart(64, '0')}`;
    } catch (error: any) {
      this.logger.error(`Failed to sign order: ${error.message}`);
      throw new Error(`Order signing failed: ${error.message}`);
    }
  }

  /**
   * Sign a withdrawal request
   * @param withdrawalData Withdrawal data to sign
   * @returns Signature string
   */
  async signWithdrawal(withdrawalData: {
    asset: string;
    amount: string;
    destinationAddress: string;
    chainId: number; // Arbitrum = 42161
    expiration?: number;
  }): Promise<string> {
    const domain = this.getDomain();
    
    const types = {
      Withdrawal: [
        { name: 'asset', type: 'felt252' },
        { name: 'amount', type: 'u256' },
        { name: 'destinationAddress', type: 'felt252' },
        { name: 'chainId', type: 'u256' },
        { name: 'expiration', type: 'u64' },
      ],
    };

    const message = {
      asset: withdrawalData.asset,
      amount: withdrawalData.amount,
      destinationAddress: withdrawalData.destinationAddress,
      chainId: withdrawalData.chainId.toString(),
      expiration: withdrawalData.expiration || Math.floor(Date.now() / 1000) + 14 * 24 * 3600, // Default 14 days
    };

    try {
      const typedDataObj = {
        domain,
        types,
        primaryType: 'Withdrawal',
        message,
      };
      // getMessageHash requires account address as second parameter
      // For Extended, we use the public key derived from private key
      const accountAddress = ec.starkCurve.getPublicKey(this.starkPrivateKey);
      const accountAddressHex = `0x${Array.from(accountAddress).map(b => b.toString(16).padStart(2, '0')).join('')}`;
      const typedDataHash = typedData.getMessageHash(typedDataObj, accountAddressHex);
      const signature = ec.starkCurve.sign(typedDataHash, this.starkPrivateKey);
      return `0x${signature.r.toString(16).padStart(64, '0')}${signature.s.toString(16).padStart(64, '0')}`;
    } catch (error: any) {
      this.logger.error(`Failed to sign withdrawal: ${error.message}`);
      throw new Error(`Withdrawal signing failed: ${error.message}`);
    }
  }

  /**
   * Sign a transfer request
   * @param transferData Transfer data to sign
   * @returns Signature string
   */
  async signTransfer(transferData: {
    asset: string;
    amount: string;
    toVault: number;
  }): Promise<string> {
    const domain = this.getDomain();
    
    const types = {
      Transfer: [
        { name: 'asset', type: 'felt252' },
        { name: 'amount', type: 'u256' },
        { name: 'toVault', type: 'u256' },
      ],
    };

    const message = {
      asset: transferData.asset,
      amount: transferData.amount,
      toVault: transferData.toVault.toString(),
    };

    try {
      const typedDataObj = {
        domain,
        types,
        primaryType: 'Transfer',
        message,
      };
      // getMessageHash requires account address as second parameter
      // For Extended, we use the public key derived from private key
      const accountAddress = ec.starkCurve.getPublicKey(this.starkPrivateKey);
      const accountAddressHex = `0x${Array.from(accountAddress).map(b => b.toString(16).padStart(2, '0')).join('')}`;
      const typedDataHash = typedData.getMessageHash(typedDataObj, accountAddressHex);
      const signature = ec.starkCurve.sign(typedDataHash, this.starkPrivateKey);
      return `0x${signature.r.toString(16).padStart(64, '0')}${signature.s.toString(16).padStart(64, '0')}`;
    } catch (error: any) {
      this.logger.error(`Failed to sign transfer: ${error.message}`);
      throw new Error(`Transfer signing failed: ${error.message}`);
    }
  }

  /**
   * Get the public key (Stark key) from the private key
   */
  getPublicKey(): string {
    const publicKey = ec.starkCurve.getPublicKey(this.starkPrivateKey);
    // Convert Uint8Array to hex string
    return `0x${Array.from(publicKey).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  }
}

