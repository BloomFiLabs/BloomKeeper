import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import * as crypto from 'crypto';
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
import { IPerpExchangeAdapter, ExchangeError } from '../../../domain/ports/IPerpExchangeAdapter';

/**
 * AsterExchangeAdapter - Implements IPerpExchangeAdapter for Aster DEX
 * 
 * Based on the existing open-perp-position.ts script logic
 */
@Injectable()
export class AsterExchangeAdapter implements IPerpExchangeAdapter {
  private readonly logger = new Logger(AsterExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private readonly client: AxiosInstance;
  private readonly wallet: ethers.Wallet | null;
  private readonly apiKey: string | undefined;
  private readonly apiSecret: string | undefined;

  constructor(private readonly configService: ConfigService) {
    // Load configuration from environment
    // Remove trailing slash if present (causes 403 errors)
    let baseUrl = this.configService.get<string>('ASTER_BASE_URL') || 'https://fapi.asterdex.com';
    baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    const user = this.configService.get<string>('ASTER_USER');
    const signer = this.configService.get<string>('ASTER_SIGNER');
    const privateKey = this.configService.get<string>('ASTER_PRIVATE_KEY');
    const apiKey = this.configService.get<string>('ASTER_API_KEY');
    const apiSecret = this.configService.get<string>('ASTER_API_SECRET');
    const recvWindow = this.configService.get<number>('ASTER_RECV_WINDOW');

    // For trading: need user, signer, privateKey (signature-based)
    // For read-only: can use API key/secret if provided
    if (!user || !signer || !privateKey) {
      if (!apiKey || !apiSecret) {
        throw new Error('Aster exchange requires either (ASTER_USER, ASTER_SIGNER, ASTER_PRIVATE_KEY) for trading OR (ASTER_API_KEY, ASTER_API_SECRET) for read-only access');
      }
      // Read-only mode with API keys
      this.logger.warn('Aster adapter in read-only mode (API keys only - trading disabled)');
    }

    // Store API keys for read-only endpoints
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    // Normalize private key (if provided)
    let normalizedPrivateKey: string | undefined;
    if (privateKey) {
      normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      this.wallet = new ethers.Wallet(normalizedPrivateKey);
    } else {
      this.wallet = null;
      normalizedPrivateKey = undefined;
    }

    this.config = new ExchangeConfig(
      ExchangeType.ASTER,
      baseUrl,
      apiKey,
      apiSecret,
      normalizedPrivateKey,
      user,
      signer,
      undefined,
      undefined,
      recvWindow,
    );

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: this.config.getTimeout(),
    });

    if (user) {
      this.logger.log(`Aster adapter initialized for user: ${user} (trading enabled)`);
    } else if (apiKey) {
      this.logger.log(`Aster adapter initialized with API key (read-only mode)`);
    }
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): string {
    return ExchangeType.ASTER;
  }

  /**
   * Trim and convert all values in dictionary to strings (matching Python _trim_dict)
   */
  private trimDict(myDict: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(myDict)) {
      if (value === null || value === undefined) {
        continue;
      }

      if (Array.isArray(value)) {
        const newValue = value.map((item) => {
          if (typeof item === 'object' && item !== null) {
            return JSON.stringify(this.trimDict(item));
          }
          return String(item);
        });
        result[key] = JSON.stringify(newValue);
      } else if (typeof value === 'object') {
        result[key] = JSON.stringify(this.trimDict(value));
      } else {
        result[key] = String(value);
      }
    }

    return result;
  }

  /**
   * Create HMAC signature for API key/secret authentication (read-only endpoints)
   * Based on Aster API docs: HMAC SHA256 of query string + request body
   * For GET requests, only query string is used
   */
  private signParamsWithApiKey(params: Record<string, any>): Record<string, any> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API key and secret required for HMAC authentication');
    }

    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== null && value !== undefined),
    );

    // Aster API requires timestamp in milliseconds
    cleanParams.timestamp = Date.now(); // Milliseconds
    cleanParams.recvWindow = cleanParams.recvWindow ?? this.config.recvWindow ?? 50000;

    // Create query string for HMAC signing
    // IMPORTANT: 
    // 1. Signature must be calculated WITHOUT the signature parameter itself
    // 2. Parameters must be sorted alphabetically
    // 3. For GET requests, only query string is signed (no request body)
    // 4. Values should NOT be URL encoded in the signature string
    // 5. After calculating signature, it must be added as the LAST parameter
    const queryString = Object.keys(cleanParams)
      .sort()
      .map((key) => `${key}=${cleanParams[key]}`) // No URL encoding
      .join('&');

    // Create HMAC SHA256 signature
    // Aster docs: "Use your secretKey to create an HMAC SHA256 signature of this query string"
    // "Include the signature in your request, either in the query string or request body."
    // "Ensure the signature is the last parameter in your query string or request body."
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');

    // Return params with signature added (signature will be appended as last param in query string)
    return {
      ...cleanParams,
      signature, // This will be added as the last parameter when building the query string
    };
  }

  /**
   * Create Ethereum signature for Aster DEX API (trading endpoints)
   */
  private signParams(
    params: Record<string, any>,
    nonce: number,
  ): Record<string, any> {
    if (!this.wallet) {
      throw new Error('Wallet required for Ethereum signature authentication. Provide ASTER_USER, ASTER_SIGNER, and ASTER_PRIVATE_KEY for trading.');
    }

    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== null && value !== undefined),
    );

    cleanParams.recvWindow = cleanParams.recvWindow ?? this.config.recvWindow ?? 50000;
    cleanParams.timestamp = Math.floor(Date.now());

    const trimmedParams = this.trimDict(cleanParams);
    const jsonStr = JSON.stringify(trimmedParams, Object.keys(trimmedParams).sort());

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ['string', 'address', 'address', 'uint256'],
      [jsonStr, this.config.userAddress!, this.config.signerAddress!, nonce],
    );

    const keccakHash = ethers.keccak256(encoded);
    const hashBytes = ethers.getBytes(keccakHash);

    const prefix = '\x19Ethereum Signed Message:\n';
    const lengthStr = hashBytes.length.toString();
    const message = ethers.concat([
      ethers.toUtf8Bytes(prefix),
      ethers.toUtf8Bytes(lengthStr),
      hashBytes,
    ]);

    const messageHash = ethers.keccak256(message);
    const signature = this.wallet.signingKey.sign(ethers.getBytes(messageHash));

    const signatureHex = ethers.Signature.from({
      r: signature.r,
      s: signature.s,
      v: signature.v,
    }).serialized;

    return {
      ...cleanParams,
      nonce,
      user: this.config.userAddress,
      signer: this.config.signerAddress,
      signature: signatureHex,
    };
  }

  async placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse> {
    try {
      // Aster uses BUY/SELL instead of LONG/SHORT
      const asterSide = request.side === OrderSide.LONG ? 'BUY' : 'SELL';

      // Format quantity (size in base asset units)
      const quantity = request.size.toFixed(8);

      const nonce = Math.floor(Date.now() * 1000);
      const orderParams: Record<string, any> = {
        symbol: request.symbol,
        positionSide: 'BOTH', // Required parameter (from working script)
        side: asterSide,
        type: request.type === OrderType.MARKET ? 'MARKET' : 'LIMIT',
        quantity,
        recvWindow: 50000, // Required for market orders (from working script)
      };

      // For LIMIT orders, add price and timeInForce
      // For MARKET orders, do NOT include price (Aster rejects it)
      if (request.type === OrderType.LIMIT && request.price) {
        orderParams.price = request.price.toFixed(8);
        orderParams.timeInForce = request.timeInForce || TimeInForce.GTC;
      }

      const signedParams = this.signParams(orderParams, nonce);

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(signedParams)) {
        if (value !== null && value !== undefined) {
          formData.append(key, String(value));
        }
      }

      const response = await this.client.post('/fapi/v3/order', formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const orderId = response.data.orderId?.toString() || response.data.orderId;
      const status = this.mapAsterOrderStatus(response.data.status);

      return new PerpOrderResponse(
        orderId,
        status,
        request.symbol,
        request.side,
        request.clientOrderId,
        response.data.executedQty ? parseFloat(response.data.executedQty) : undefined,
        response.data.avgPrice ? parseFloat(response.data.avgPrice) : undefined,
        response.data.msg,
        new Date(),
      );
    } catch (error: any) {
      // Enhanced error logging for debugging
      if (error.response) {
        this.logger.error(
          `Failed to place order: ${error.message}. ` +
          `Status: ${error.response.status}, ` +
          `Response: ${JSON.stringify(error.response.data)}`
        );
        // Log request parameters for debugging (without sensitive data)
        this.logger.debug(
          `Order request params: symbol=${request.symbol}, ` +
          `side=${request.side}, type=${request.type}, size=${request.size}`
        );
      } else {
        this.logger.error(`Failed to place order: ${error.message}`);
      }
      throw new ExchangeError(
        `Failed to place order: ${error.message}`,
        ExchangeType.ASTER,
        error.response?.data?.code,
        error,
      );
    }
  }

  private mapAsterOrderStatus(asterStatus: string): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      NEW: OrderStatus.SUBMITTED,
      PARTIALLY_FILLED: OrderStatus.PARTIALLY_FILLED,
      FILLED: OrderStatus.FILLED,
      CANCELED: OrderStatus.CANCELLED,
      REJECTED: OrderStatus.REJECTED,
      EXPIRED: OrderStatus.EXPIRED,
    };
    return statusMap[asterStatus] || OrderStatus.PENDING;
  }

  async getPosition(symbol: string): Promise<PerpPosition | null> {
    try {
      const positions = await this.getPositions();
      return positions.find((p) => p.symbol === symbol) || null;
    } catch (error: any) {
      this.logger.error(`Failed to get position: ${error.message}`);
      throw new ExchangeError(
        `Failed to get position: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async getPositions(): Promise<PerpPosition[]> {
    try {
      // Use API key authentication if available, otherwise use Ethereum signature
      let params: Record<string, any>;
      let headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        // Use HMAC-based API key authentication
        params = this.signParamsWithApiKey({});
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        // Fallback to Ethereum signature
        const nonce = Math.floor(Date.now() * 1000);
        params = this.signParams({}, nonce);
      } else {
        throw new Error('No authentication method available');
      }

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        formData.append(key, String(value));
      }

      const response = await this.client.get('/fapi/v2/positionRisk', {
        params: Object.fromEntries(formData),
        headers,
      });

      const positions: PerpPosition[] = [];
      if (Array.isArray(response.data)) {
        for (const pos of response.data) {
          const positionAmt = parseFloat(pos.positionAmt || '0');
          if (positionAmt !== 0) {
            const side = positionAmt > 0 ? OrderSide.LONG : OrderSide.SHORT;
            const markPrice = parseFloat(pos.markPrice || '0');
            const entryPrice = parseFloat(pos.entryPrice || '0');
            const unrealizedPnl = parseFloat(pos.unRealizedProfit || '0');

            positions.push(
              new PerpPosition(
                ExchangeType.ASTER,
                pos.symbol,
                side,
                Math.abs(positionAmt),
                entryPrice,
                markPrice,
                unrealizedPnl,
                parseFloat(pos.leverage || '1'),
                parseFloat(pos.liquidationPrice || '0') || undefined,
                parseFloat(pos.initialMargin || '0') || undefined,
                undefined,
                new Date(),
              ),
            );
          }
        }
      }

      return positions;
    } catch (error: any) {
      // Handle authentication errors gracefully (401 = invalid/expired credentials)
      if (error.response?.status === 401) {
        this.logger.warn('Aster API authentication failed - positions query requires valid API credentials');
        return []; // Return empty array instead of throwing to allow system to continue
      }
      this.logger.error(`Failed to get positions: ${error.message}`);
      // Return empty array instead of throwing to allow system to continue
      this.logger.warn('Returning empty positions due to error - Aster positions query may need valid API keys');
      return [];
    }
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      if (!symbol) {
        throw new Error('Symbol is required for canceling orders on Aster');
      }

      const nonce = Math.floor(Date.now() * 1000);
      const orderParams = {
        symbol,
        orderId,
      };

      const signedParams = this.signParams(orderParams, nonce);

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(signedParams)) {
        formData.append(key, String(value));
      }

      await this.client.delete('/fapi/v3/order', {
        params: Object.fromEntries(formData),
      });

      return true;
    } catch (error: any) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel order: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    try {
      const nonce = Math.floor(Date.now() * 1000);
      const orderParams = { symbol };
      const signedParams = this.signParams(orderParams, nonce);

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(signedParams)) {
        formData.append(key, String(value));
      }

      const response = await this.client.delete('/fapi/v3/allOpenOrders', {
        params: Object.fromEntries(formData),
      });

      // Aster returns the number of cancelled orders
      return response.data?.count || 0;
    } catch (error: any) {
      this.logger.error(`Failed to cancel all orders: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel all orders: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    try {
      if (!symbol) {
        throw new Error('Symbol is required for getting order status on Aster');
      }

      const nonce = Math.floor(Date.now() * 1000);
      const orderParams = { symbol, orderId };
      const signedParams = this.signParams(orderParams, nonce);

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(signedParams)) {
        formData.append(key, String(value));
      }

      const response = await this.client.get('/fapi/v3/order', {
        params: Object.fromEntries(formData),
      });

      const data = response.data;
      const side = data.side === 'BUY' ? OrderSide.LONG : OrderSide.SHORT;

      return new PerpOrderResponse(
        data.orderId.toString(),
        this.mapAsterOrderStatus(data.status),
        data.symbol,
        side,
        undefined,
        data.executedQty ? parseFloat(data.executedQty) : undefined,
        data.avgPrice ? parseFloat(data.avgPrice) : undefined,
        data.msg,
        new Date(data.updateTime),
      );
    } catch (error: any) {
      this.logger.error(`Failed to get order status: ${error.message}`);
      throw new ExchangeError(
        `Failed to get order status: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  // Price cache: key = symbol, value = { price: number, timestamp: number }
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly PRICE_CACHE_TTL = 10000; // 10 seconds cache

  async getMarkPrice(symbol: string): Promise<number> {
    // Check cache first
    const cached = this.priceCache.get(symbol);
    if (cached && (Date.now() - cached.timestamp) < this.PRICE_CACHE_TTL) {
      return cached.price;
    }

    // Retry logic: up to 3 attempts with exponential backoff
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s delays
          await new Promise(resolve => setTimeout(resolve, delay));
          this.logger.debug(`Retrying mark price fetch for ${symbol} (attempt ${attempt + 1}/3)`);
        }

        const response = await this.client.get('/fapi/v1/ticker/price', {
          params: { symbol },
          timeout: 10000,
        });

        const price = parseFloat(response.data.price);
        if (price > 0) {
          // Cache the result
          this.priceCache.set(symbol, { price, timestamp: Date.now() });
          return price;
        } else {
          throw new Error(`Invalid price returned: ${price}`);
        }
      } catch (error: any) {
        lastError = error;
        if (attempt === 2) {
          // Last attempt failed
          this.logger.error(
            `Failed to get mark price for ${symbol} after 3 attempts: ${error.message}. ` +
            `Status: ${error.response?.status}, Response: ${JSON.stringify(error.response?.data)}`
          );
        }
      }
    }

    // All attempts failed
    throw new ExchangeError(
      `Failed to get mark price for ${symbol} after 3 retries: ${lastError?.message || 'unknown error'}`,
      ExchangeType.ASTER,
      undefined,
      lastError || undefined,
    );
  }

  async getBalance(): Promise<number> {
    try {
      // Aster API requires Ethereum signature authentication (not HMAC API keys)
      // Based on official docs: https://github.com/asterdex/api-docs
      // Balance endpoint: GET /fapi/v3/balance (USER_DATA authentication type)
      // Authentication requires: user, signer, nonce, signature (Ethereum signature)
      if (!this.wallet) {
        this.logger.warn('Aster balance query requires Ethereum signature authentication. Provide ASTER_USER, ASTER_SIGNER, and ASTER_PRIVATE_KEY.');
        return 0;
      }

      // Generate nonce (microseconds timestamp as per docs)
      const nonce = Math.floor(Date.now() * 1000);
      // Sign empty params (balance endpoint doesn't require additional parameters)
      const params = this.signParams({}, nonce);

      // Use v3 endpoint as per official documentation
      const response = await this.client.get('/fapi/v3/balance', {
        params,
      });

      // Aster v3 returns balance in array format
      // Response structure: [{ accountAlias, asset, balance, availableBalance, ... }]
      if (Array.isArray(response.data) && response.data.length > 0) {
        const usdtBalance = response.data.find((b: any) => b.asset === 'USDT');
        if (usdtBalance) {
          const balance = parseFloat(usdtBalance.availableBalance || usdtBalance.balance || '0');
          this.logger.debug(`Aster balance retrieved: $${balance.toFixed(2)}`);
          return balance;
        }
      }

      return 0;
    } catch (error: any) {
      // Log detailed error information for debugging
      if (error.response) {
        this.logger.error(
          `Aster balance request failed: ${error.response.status} ${error.response.statusText}. ` +
          `Response: ${JSON.stringify(error.response.data)}. ` +
          `Request params: ${JSON.stringify(error.config?.params || {})}`
        );
      } else {
        this.logger.error(`Failed to get balance: ${error.message}`);
      }
      
      // Handle authentication errors gracefully (401 = invalid/expired credentials, 400 = bad request format)
      if (error.response?.status === 401) {
        this.logger.warn('Aster API authentication failed - balance query requires valid API credentials');
        return 0;
      }
      if (error.response?.status === 400) {
        const errorMsg = error.response?.data?.msg || '';
        if (errorMsg.includes('Signature') || errorMsg.includes('signature')) {
          this.logger.warn(
            'Aster API signature validation failed. The signature format may be incorrect. ' +
            'Possible fixes: 1) Try timestamp in milliseconds instead of seconds, ' +
            '2) Remove URL encoding from query string values, ' +
            '3) Check Aster API docs for exact signature format. ' +
            `Current timestamp format: seconds (${Math.floor(Date.now() / 1000)})`
          );
        } else {
          this.logger.warn(`Aster API returned 400 Bad Request: ${errorMsg}`);
        }
        return 0;
      }
      
      // Return 0 instead of throwing to allow system to continue
      this.logger.warn('Returning 0 balance due to error - Aster balance query may need valid API keys');
      return 0;
    }
  }

  async getEquity(): Promise<number> {
    try {
      // Use API key authentication if available, otherwise use Ethereum signature
      let params: Record<string, any>;
      let headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        // Use HMAC-based API key authentication
        params = this.signParamsWithApiKey({});
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        // Fallback to Ethereum signature
        const nonce = Math.floor(Date.now() * 1000);
        params = this.signParams({}, nonce);
      } else {
        throw new Error('No authentication method available');
      }

      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        formData.append(key, String(value));
      }

      const response = await this.client.get('/fapi/v2/account', {
        params: Object.fromEntries(formData),
        headers,
      });

      return parseFloat(response.data.totalWalletBalance || '0');
    } catch (error: any) {
      // Handle authentication errors gracefully (401 = invalid/expired credentials)
      if (error.response?.status === 401) {
        this.logger.warn('Aster API authentication failed - equity query requires valid API credentials');
        return 0; // Return 0 instead of throwing to allow system to continue
      }
      this.logger.error(`Failed to get equity: ${error.message}`);
      // Return 0 instead of throwing to allow system to continue
      this.logger.warn('Returning 0 equity due to error - Aster equity query may need valid API keys');
      return 0;
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
      // Test connection by fetching exchange info
      await this.client.get('/fapi/v1/exchangeInfo');
    } catch (error: any) {
      throw new ExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }
}

