import { Injectable, Logger } from '@nestjs/common';
import { ec, typedData, StarknetDomain } from 'starknet';

/**
 * ExtendedSigningService - Handles Starknet SNIP12/EIP712 signing for Extended exchange
 *
 * Extended uses SNIP12 standard (EIP712 for Starknet) for signing orders and withdrawals
 * Domain: { name: "Perpetuals", version: "v0", chainId: "SN_MAIN", revision: "1" }
 *
 * API Docs: https://api.docs.extended.exchange/#order-management
 */
@Injectable()
export class ExtendedSigningService {
  private readonly logger = new Logger(ExtendedSigningService.name);
  private readonly starkPrivateKey: string;

  constructor(
    starkPrivateKey: string,
    private readonly isTestnet: boolean = false,
  ) {
    // Normalize private key (remove 0x if present)
    this.starkPrivateKey = starkPrivateKey.startsWith('0x')
      ? starkPrivateKey.slice(2)
      : starkPrivateKey;

    this.logger.debug(
      `ExtendedSigningService initialized (testnet: ${isTestnet})`,
    );
  }

  /**
   * Get the SNIP12 domain for Extended exchange
   * Per SDK config: StarknetDomain(name="Perpetuals", version="v0", chainId="SN_MAIN", revision="1")
   */
  private getDomain(): StarknetDomain {
    return {
      name: 'Perpetuals',
      version: 'v0',
      chainId: this.isTestnet ? 'SN_SEPOLIA' : 'SN_MAIN',
      revision: '1',
    };
  }

  /**
   * Sign an order using SNIP12/EIP712 and return r,s components
   * Extended API requires signature as { r: "0x...", s: "0x..." } format
   *
   * @param orderData Order data to sign
   * @returns Signature with r and s components
   */
  async signOrderWithComponents(orderData: {
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
  }): Promise<{ r: string; s: string }> {
    const domain = this.getDomain();

    // Extended order types based on SDK reference implementation
    const types = {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      Order: [
        { name: 'market', type: 'felt' },
        { name: 'side', type: 'felt' },
        { name: 'type', type: 'felt' },
        { name: 'size', type: 'felt' },
        { name: 'price', type: 'felt' },
        { name: 'timeInForce', type: 'felt' },
        { name: 'reduceOnly', type: 'bool' },
        { name: 'postOnly', type: 'bool' },
        { name: 'expiration', type: 'felt' },
        { name: 'clientOrderId', type: 'felt' },
      ],
    };

    const message = {
      market: orderData.symbol,
      side: orderData.side.toUpperCase(),
      type: orderData.orderType.toUpperCase(),
      size: orderData.size,
      price: orderData.price || '0',
      timeInForce: orderData.timeInForce || 'GTT',
      reduceOnly: orderData.reduceOnly || false,
      postOnly: orderData.postOnly || false,
      expiration: (
        orderData.expiration || Math.floor(Date.now() / 1000) + 86400
      ).toString(),
      clientOrderId: orderData.clientOrderId || '',
    };

    try {
      // Build typed data object
      const typedDataObj = {
        domain,
        types,
        primaryType: 'Order',
        message,
      };

      // Get account address (public key) from private key
      const publicKey = ec.starkCurve.getStarkKey(this.starkPrivateKey);

      // Get message hash
      const messageHash = typedData.getMessageHash(typedDataObj, publicKey);

      // Sign the hash
      const signature = ec.starkCurve.sign(messageHash, this.starkPrivateKey);

      // Return r,s as hex strings with 0x prefix
      return {
        r: `0x${signature.r.toString(16).padStart(64, '0')}`,
        s: `0x${signature.s.toString(16).padStart(64, '0')}`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to sign order: ${error.message}`);
      throw new Error(`Order signing failed: ${error.message}`);
    }
  }

  /**
   * Sign an order (legacy method returning concatenated signature)
   * @deprecated Use signOrderWithComponents instead
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
    const { r, s } = await this.signOrderWithComponents(orderData);
    return `${r}${s.slice(2)}`; // Concatenate r and s (removing duplicate 0x)
  }

  /**
   * Sign a withdrawal request
   * Per Extended API docs, withdrawal requires settlement object with signature
   * @param withdrawalData Withdrawal data to sign
   * @returns Signature with r and s components
   */
  async signWithdrawalWithComponents(withdrawalData: {
    asset: string;
    amount: string;
    recipient: string;
    positionId: number;
    collateralId: string;
    expiration: number;
    salt: number;
  }): Promise<{ r: string; s: string }> {
    const domain = this.getDomain();

    const types = {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      Withdrawal: [
        { name: 'recipient', type: 'felt' },
        { name: 'positionId', type: 'felt' },
        { name: 'collateralId', type: 'felt' },
        { name: 'amount', type: 'felt' },
        { name: 'expiration', type: 'felt' },
        { name: 'salt', type: 'felt' },
      ],
    };

    const message = {
      recipient: withdrawalData.recipient,
      positionId: withdrawalData.positionId.toString(),
      collateralId: withdrawalData.collateralId,
      amount: withdrawalData.amount,
      expiration: withdrawalData.expiration.toString(),
      salt: withdrawalData.salt.toString(),
    };

    try {
      const typedDataObj = {
        domain,
        types,
        primaryType: 'Withdrawal',
        message,
      };

      const publicKey = ec.starkCurve.getStarkKey(this.starkPrivateKey);
      const messageHash = typedData.getMessageHash(typedDataObj, publicKey);
      const signature = ec.starkCurve.sign(messageHash, this.starkPrivateKey);

      return {
        r: `0x${signature.r.toString(16).padStart(64, '0')}`,
        s: `0x${signature.s.toString(16).padStart(64, '0')}`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to sign withdrawal: ${error.message}`);
      throw new Error(`Withdrawal signing failed: ${error.message}`);
    }
  }

  /**
   * Sign a withdrawal (legacy method)
   * @deprecated Use signWithdrawalWithComponents instead
   */
  async signWithdrawal(withdrawalData: {
    asset: string;
    amount: string;
    destinationAddress: string;
    chainId: number;
    expiration?: number;
  }): Promise<string> {
    const { r, s } = await this.signWithdrawalWithComponents({
      asset: withdrawalData.asset,
      amount: withdrawalData.amount,
      recipient: withdrawalData.destinationAddress,
      positionId: 0,
      collateralId: '0x1',
      expiration:
        withdrawalData.expiration ||
        Math.floor(Date.now() / 1000) + 14 * 24 * 3600,
      salt: Math.floor(Math.random() * 100000000),
    });
    return `${r}${s.slice(2)}`;
  }

  /**
   * Sign a transfer request
   * Per Extended API docs, transfer is between sub-accounts of same wallet
   * @param transferData Transfer data to sign
   * @returns Signature with r and s components
   */
  async signTransferWithComponents(transferData: {
    amount: number;
    assetId: string;
    expirationTimestamp: number;
    nonce: number;
    receiverPositionId: number;
    receiverPublicKey: string;
    senderPositionId: number;
    senderPublicKey: string;
  }): Promise<{ r: string; s: string }> {
    const domain = this.getDomain();

    const types = {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      Transfer: [
        { name: 'amount', type: 'felt' },
        { name: 'assetId', type: 'felt' },
        { name: 'expirationTimestamp', type: 'felt' },
        { name: 'nonce', type: 'felt' },
        { name: 'receiverPositionId', type: 'felt' },
        { name: 'receiverPublicKey', type: 'felt' },
        { name: 'senderPositionId', type: 'felt' },
        { name: 'senderPublicKey', type: 'felt' },
      ],
    };

    const message = {
      amount: transferData.amount.toString(),
      assetId: transferData.assetId,
      expirationTimestamp: transferData.expirationTimestamp.toString(),
      nonce: transferData.nonce.toString(),
      receiverPositionId: transferData.receiverPositionId.toString(),
      receiverPublicKey: transferData.receiverPublicKey,
      senderPositionId: transferData.senderPositionId.toString(),
      senderPublicKey: transferData.senderPublicKey,
    };

    try {
      const typedDataObj = {
        domain,
        types,
        primaryType: 'Transfer',
        message,
      };

      const publicKey = ec.starkCurve.getStarkKey(this.starkPrivateKey);
      const messageHash = typedData.getMessageHash(typedDataObj, publicKey);
      const signature = ec.starkCurve.sign(messageHash, this.starkPrivateKey);

      return {
        r: `0x${signature.r.toString(16).padStart(64, '0')}`,
        s: `0x${signature.s.toString(16).padStart(64, '0')}`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to sign transfer: ${error.message}`);
      throw new Error(`Transfer signing failed: ${error.message}`);
    }
  }

  /**
   * Sign a transfer (legacy method)
   * @deprecated Use signTransferWithComponents instead
   */
  async signTransfer(transferData: {
    asset: string;
    amount: string;
    toVault: number;
  }): Promise<string> {
    const { r, s } = await this.signTransferWithComponents({
      amount: parseInt(transferData.amount),
      assetId: '0x1', // USD collateral asset
      expirationTimestamp: Math.floor(Date.now() / 1000) + 86400,
      nonce: Math.floor(Math.random() * 2147483646) + 1,
      receiverPositionId: transferData.toVault,
      receiverPublicKey: this.getPublicKey(),
      senderPositionId: 0,
      senderPublicKey: this.getPublicKey(),
    });
    return `${r}${s.slice(2)}`;
  }

  /**
   * Get the public key (Stark key) from the private key
   * Returns the l2Key used in Extended API
   */
  getPublicKey(): string {
    return ec.starkCurve.getStarkKey(this.starkPrivateKey);
  }
}
