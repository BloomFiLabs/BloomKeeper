import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import { ethers } from 'ethers';
import {
  loadConfig,
  signParams,
  placeMarketOrder,
  describeAxiosError,
} from './open-perp-position';

// Mock axios
vi.mock('axios');
const mockedAxios = vi.mocked(axios);

// Mock ethers
vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers');
  return {
    ...actual,
    ethers: {
      ...(actual as any).ethers,
      Wallet: vi.fn(),
      AbiCoder: {
        defaultAbiCoder: vi.fn(() => ({
          encode: vi.fn(() => '0xencoded'),
        })),
      },
      keccak256: vi.fn(() => '0xkeccakhash'),
      hashMessage: vi.fn(() => '0xmessagehash'),
      getBytes: vi.fn((x: string) => new Uint8Array()),
      toUtf8Bytes: vi.fn((x: string) => new Uint8Array()),
      concat: vi.fn(() => new Uint8Array()),
      Signature: {
        from: vi.fn(() => ({
          serialized: '0x1234567890abcdef',
        })),
      },
    },
  };
});

// Mock axios.isAxiosError to properly detect AxiosError instances
vi.spyOn(axios, 'isAxiosError').mockImplementation((error: any) => {
  return error && error.isAxiosError === true;
});

// Mock dotenv to avoid loading actual .env files
vi.mock('dotenv/config', () => ({}));

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load all required configuration from environment variables', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '500';

    const config = loadConfig();

    expect(config.user).toBe('0x1234567890123456789012345678901234567890');
    expect(config.signer).toBe('0x0987654321098765432109876543210987654321');
    expect(config.privateKey).toBe('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    expect(config.usdSize).toBe(500);
    expect(config.baseUrl).toBe('https://fapi.asterdex.com');
    expect(config.symbol).toBe('BNBUSDT');
  });

  it('should use custom base URL when provided', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '100';
    process.env.ASTER_BASE_URL = 'https://custom-api.example.com';

    const config = loadConfig();

    expect(config.baseUrl).toBe('https://custom-api.example.com');
  });

  it('should use custom symbol when provided', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '100';
    process.env.ASTER_SYMBOL = 'ETHUSDT';

    const config = loadConfig();

    expect(config.symbol).toBe('ETHUSDT');
  });

  it('should parse recvWindow when provided', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '100';
    process.env.ASTER_RECV_WINDOW = '10000';

    const config = loadConfig();

    expect(config.recvWindow).toBe(10000);
  });

  it('should add 0x prefix to private key if missing', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '100';

    const config = loadConfig();

    expect(config.privateKey).toBe('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  });

  it('should throw error when ASTER_USER is missing', () => {
    process.env.ASTER_USER = '';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '100';

    expect(() => loadConfig()).toThrow('Missing ASTER_USER environment variable');
  });

  it('should throw error when ASTER_SIGNER is missing', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '100';

    expect(() => loadConfig()).toThrow('Missing ASTER_SIGNER environment variable');
  });

  it('should throw error when ASTER_PRIVATE_KEY is missing', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '';
    process.env.ASTER_POSITION_SIZE_USD = '100';

    expect(() => loadConfig()).toThrow('Missing ASTER_PRIVATE_KEY environment variable');
  });

  it('should throw error when ASTER_POSITION_SIZE_USD is missing', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    delete process.env.ASTER_POSITION_SIZE_USD;

    expect(() => loadConfig()).toThrow('Missing ASTER_POSITION_SIZE_USD environment variable');
  });

  it('should throw error when ASTER_POSITION_SIZE_USD is not a number', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = 'not-a-number';

    expect(() => loadConfig()).toThrow('ASTER_POSITION_SIZE_USD must be a positive number');
  });

  it('should throw error when ASTER_POSITION_SIZE_USD is zero', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '0';

    expect(() => loadConfig()).toThrow('ASTER_POSITION_SIZE_USD must be a positive number');
  });

  it('should throw error when ASTER_POSITION_SIZE_USD is negative', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '-100';

    expect(() => loadConfig()).toThrow('ASTER_POSITION_SIZE_USD must be a positive number');
  });

  it('should throw error when ASTER_RECV_WINDOW is not an integer', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '100';
    process.env.ASTER_RECV_WINDOW = '5000.5';

    expect(() => loadConfig()).toThrow('ASTER_RECV_WINDOW must be a positive integer when provided');
  });

  it('should throw error when ASTER_RECV_WINDOW is zero', () => {
    process.env.ASTER_USER = '0x1234567890123456789012345678901234567890';
    process.env.ASTER_SIGNER = '0x0987654321098765432109876543210987654321';
    process.env.ASTER_PRIVATE_KEY = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    process.env.ASTER_POSITION_SIZE_USD = '100';
    process.env.ASTER_RECV_WINDOW = '0';

    expect(() => loadConfig()).toThrow('ASTER_RECV_WINDOW must be a positive integer when provided');
  });
});

describe('signParams', () => {
  const mockWallet = {
    signingKey: {
      sign: vi.fn(() => ({
        r: '0xr',
        s: '0xs',
        v: 27,
      })),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (ethers.Wallet as any).mockImplementation(() => mockWallet);
  });

  it('should sign parameters and add authentication fields', () => {
    const params = {
      symbol: 'BNBUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
    };

    const user = '0x1234567890123456789012345678901234567890';
    const signer = '0x0987654321098765432109876543210987654321';
    const privateKey = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const nonce = 1234567890000;

    const result = signParams(params, user, signer, privateKey, nonce);

    expect(result).toHaveProperty('symbol', 'BNBUSDT');
    expect(result).toHaveProperty('side', 'BUY');
    expect(result).toHaveProperty('type', 'MARKET');
    expect(result).toHaveProperty('quantity', '1');
    expect(result).toHaveProperty('user', user);
    expect(result).toHaveProperty('signer', signer);
    expect(result).toHaveProperty('nonce', nonce);
    expect(result).toHaveProperty('signature');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('recvWindow');
  });

  it('should add default recvWindow if not provided', () => {
    const params = {
      symbol: 'BNBUSDT',
      side: 'BUY',
    };

    const result = signParams(
      params,
      '0x1234567890123456789012345678901234567890',
      '0x0987654321098765432109876543210987654321',
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      1234567890000,
    );

    expect(result.recvWindow).toBe(50000);
  });
});

describe('placeMarketOrder', () => {
  const mockConfig = {
    user: '0x1234567890123456789012345678901234567890',
    signer: '0x0987654321098765432109876543210987654321',
    privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    baseUrl: 'https://fapi.asterdex.com',
    symbol: 'BNBUSDT',
    usdSize: 500,
    recvWindow: 5000,
  };

  const mockWallet = {
    signingKey: {
      sign: vi.fn(() => ({
        r: '0xr',
        s: '0xs',
        v: 27,
      })),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (ethers.Wallet as any).mockImplementation(() => mockWallet);
    
    mockedAxios.create.mockReturnValue({
      get: vi.fn(),
      post: vi.fn(),
    } as any);
  });

  it('should place market order with correct parameters', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({
        data: {
          symbols: [{
            symbol: 'BNBUSDT',
            filters: [{
              filterType: 'LOT_SIZE',
              stepSize: '0.01',
            }],
          }],
        },
      })
      .mockResolvedValueOnce({
        data: { price: '500' },
      });

    const mockPost = vi.fn().mockResolvedValue({
      data: { orderId: '12345', status: 'FILLED' },
    });

    mockedAxios.create.mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as any);

    await placeMarketOrder(mockConfig);

    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: 'https://fapi.asterdex.com',
      timeout: 30000,
    });

    expect(mockGet).toHaveBeenCalledWith('/fapi/v1/exchangeInfo');
    expect(mockGet).toHaveBeenCalledWith('/fapi/v1/ticker/price?symbol=BNBUSDT');
    expect(mockPost).toHaveBeenCalled();
    
    const callArgs = mockPost.mock.calls[0];
    expect(callArgs[0]).toBe('/fapi/v3/order');
    expect(callArgs[1]).toContain('symbol=BNBUSDT');
    expect(callArgs[1]).toContain('side=BUY');
    expect(callArgs[1]).toContain('type=MARKET');
    expect(callArgs[1]).toContain('positionSide=BOTH');
    expect(callArgs[1]).toContain('user=');
    expect(callArgs[1]).toContain('signer=');
    expect(callArgs[1]).toContain('signature=');
    expect(callArgs[2].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('should include recvWindow when provided', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({
        data: {
          symbols: [{
            symbol: 'BNBUSDT',
            filters: [{ filterType: 'LOT_SIZE', stepSize: '0.01' }],
          }],
        },
      })
      .mockResolvedValueOnce({
        data: { price: '500' },
      });

    const mockPost = vi.fn().mockResolvedValue({
      data: { orderId: '12345' },
    });

    mockedAxios.create.mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as any);

    await placeMarketOrder(mockConfig);

    const callArgs = mockPost.mock.calls[0];
    expect(callArgs[1]).toContain('recvWindow=5000');
  });

  it('should use default recvWindow when not provided', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({
        data: {
          symbols: [{
            symbol: 'BNBUSDT',
            filters: [{ filterType: 'LOT_SIZE', stepSize: '0.01' }],
          }],
        },
      })
      .mockResolvedValueOnce({
        data: { price: '500' },
      });

    const mockPost = vi.fn().mockResolvedValue({
      data: { orderId: '12345' },
    });

    mockedAxios.create.mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as any);

    const configWithoutRecvWindow = { ...mockConfig };
    delete configWithoutRecvWindow.recvWindow;

    await placeMarketOrder(configWithoutRecvWindow);

    const callArgs = mockPost.mock.calls[0];
    expect(callArgs[1]).toContain('recvWindow=50000');
  });

  it('should calculate quantity from USD value and current price', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({
        data: {
          symbols: [{
            symbol: 'BNBUSDT',
            filters: [{ filterType: 'LOT_SIZE', stepSize: '0.01' }],
          }],
        },
      })
      .mockResolvedValueOnce({
        data: { price: '1000' }, // $1000 per BNB
      });

    const mockPost = vi.fn().mockResolvedValue({
      data: { orderId: '12345' },
    });

    mockedAxios.create.mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as any);

    await placeMarketOrder({ ...mockConfig, usdSize: 10 }); // $10 order

    const callArgs = mockPost.mock.calls[0];
    // $10 / $1000 = 0.01 BNB (minimum step size)
    expect(callArgs[1]).toContain('quantity=0.01');
  });

  it('should throw error when order size is too small', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({
        data: {
          symbols: [{
            symbol: 'BNBUSDT',
            filters: [{ filterType: 'LOT_SIZE', stepSize: '0.01' }],
          }],
        },
      })
      .mockResolvedValueOnce({
        data: { price: '1000' },
      });

    mockedAxios.create.mockReturnValue({
      get: mockGet,
      post: vi.fn(),
    } as any);

    await expect(placeMarketOrder({ ...mockConfig, usdSize: 0.5 })).rejects.toThrow(
      'Order size too small',
    );
  });

  it('should throw error when API call fails', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({
        data: {
          symbols: [{
            symbol: 'BNBUSDT',
            filters: [{ filterType: 'LOT_SIZE', stepSize: '0.01' }],
          }],
        },
      })
      .mockResolvedValueOnce({
        data: { price: '500' },
      });

    const mockPost = vi.fn().mockRejectedValue(new Error('Network error'));

    mockedAxios.create.mockReturnValue({
      get: mockGet,
      post: mockPost,
    } as any);

    await expect(placeMarketOrder(mockConfig)).rejects.toThrow('Network error');
  });
});

describe('describeAxiosError', () => {
  it('should return error message for non-Axios errors', () => {
    const error = new Error('Simple error');
    const result = describeAxiosError(error);

    expect(result).toBe('Simple error');
  });

  it('should return string representation for non-Error objects', () => {
    const error = 'String error';
    const result = describeAxiosError(error);

    expect(result).toBe('String error');
  });

  it('should format Axios error with string response data', () => {
    const error = new Error('Request failed') as AxiosError<string>;
    error.isAxiosError = true;
    error.response = {
      status: 400,
      statusText: 'Bad Request',
      data: 'Invalid symbol',
      headers: {},
      config: {} as any,
    };

    const result = describeAxiosError(error);

    expect(result).toBe('HTTP 400 Bad Request: Invalid symbol');
  });

  it('should format Axios error with object response data', () => {
    const error = new Error('Request failed') as AxiosError<{ code: string; msg: string }>;
    error.isAxiosError = true;
    error.response = {
      status: 401,
      statusText: 'Unauthorized',
      data: {
        code: 'INVALID_API_KEY',
        msg: 'API key is invalid',
      },
      headers: {},
      config: {} as any,
    };

    const result = describeAxiosError(error);

    expect(result).toBe('HTTP 401 Unauthorized: INVALID_API_KEY - API key is invalid');
  });

  it('should handle Axios error with object data but missing code', () => {
    const error = new Error('Request failed') as AxiosError<{ msg: string }>;
    error.isAxiosError = true;
    error.response = {
      status: 500,
      statusText: 'Internal Server Error',
      data: {
        msg: 'Server error occurred',
      },
      headers: {},
      config: {} as any,
    };

    const result = describeAxiosError(error);

    expect(result).toBe('HTTP 500 Internal Server Error: UNKNOWN_CODE - Server error occurred');
  });

  it('should handle Axios error with object data but missing message', () => {
    const error = new Error('Request failed') as AxiosError<{ code: string }>;
    error.isAxiosError = true;
    error.response = {
      status: 403,
      statusText: 'Forbidden',
      data: {
        code: 'PERMISSION_DENIED',
      },
      headers: {},
      config: {} as any,
    };

    const result = describeAxiosError(error);

    expect(result).toBe('HTTP 403 Forbidden: PERMISSION_DENIED - No message');
  });

  it('should handle Axios error with no response (network error)', () => {
    const error = new Error('Network Error') as AxiosError;
    error.isAxiosError = true;
    error.request = {};
    error.response = undefined;

    const result = describeAxiosError(error);

    expect(result).toBe('No response received from Aster DEX (network or timeout issue)');
  });

  it('should return Axios error message as fallback', () => {
    const error = new Error('Request failed') as AxiosError;
    error.isAxiosError = true;

    const result = describeAxiosError(error);

    expect(result).toBe('Request failed');
  });
});
