import { BigNumber } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { Uniswap } from '../../../../src/connectors/uniswap/uniswap';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';

jest.mock('../../../../src/chains/ethereum/ethereum');
jest.mock('../../../../src/connectors/uniswap/uniswap');
jest.mock('uuid');

const buildApp = async () => {
  const server = fastifyWithTypeProvider();
  await server.register(require('@fastify/sensible'));
  const { quoteSwapRoute } = await import('../../../../src/connectors/uniswap/router-routes/quoteSwap');
  await server.register(quoteSwapRoute);
  return server;
};

const mockWETH = {
  symbol: 'WETH',
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  decimals: 18,
  name: 'Wrapped Ether',
};

const mockUSDC = {
  symbol: 'USDC',
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  decimals: 6,
  name: 'USD Coin',
};

describe('GET /quote-swap', () => {
  let server: any;
  let mockEthereum: any;
  let mockUniswap: any;
  let mockProvider: any;

  beforeAll(async () => {
    server = await buildApp();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock provider
    mockProvider = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
      getGasPrice: jest.fn().mockResolvedValue(BigNumber.from('20000000000')),
      estimateGas: jest.fn().mockResolvedValue(BigNumber.from('300000')),
      getCode: jest.fn().mockResolvedValue('0x123456'),
      call: jest.fn(),
    };

    // Mock Ethereum instance
    mockEthereum = {
      provider: mockProvider,
      chainId: 1,
      getToken: jest.fn().mockImplementation((symbol: string) => {
        const tokens: any = {
          WETH: mockWETH,
          USDC: mockUSDC,
        };
        return tokens[symbol];
      }),
      getWalletAddressExample: jest.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    };

    // Mock Uniswap instance
    mockUniswap = {
      router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    };

    (Ethereum.getInstance as jest.Mock).mockReturnValue(mockEthereum);
    (Ethereum.getWalletAddressExample as jest.Mock).mockResolvedValue('0x1234567890123456789012345678901234567890');
    (Uniswap.getInstance as jest.Mock).mockReturnValue(mockUniswap);

    // Mock UUID
    (uuidv4 as jest.Mock).mockReturnValue('test-quote-id');

    // Mock Contract to return pool/pair data
    jest.doMock('ethers', () => {
      const actual = jest.requireActual('ethers');
      return {
        ...actual,
        Contract: jest.fn().mockImplementation(() => ({
          // V2 Pair methods
          getReserves: jest.fn().mockResolvedValue([
            BigNumber.from('1000000000000000000000'), // 1000 WETH
            BigNumber.from('3000000000000'), // 3M USDC
            BigNumber.from('1234567890'),
          ]),
          token0: jest.fn().mockResolvedValue(mockWETH.address),
          token1: jest.fn().mockResolvedValue(mockUSDC.address),
          // V3 Pool methods
          liquidity: jest.fn().mockResolvedValue(BigNumber.from('1000000000000000000')),
          slot0: jest
            .fn()
            .mockResolvedValue([BigNumber.from('1771595571142789777276510917681'), 200000, 0, 1, 1, 0, true]),
          fee: jest.fn().mockResolvedValue(3000),
          tickSpacing: jest.fn().mockResolvedValue(60),
        })),
      };
    });
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('should return a valid quote for SELL side', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/quote-swap',
      query: {
        network: 'mainnet',
        walletAddress: '0x0000000000000000000000000000000000000001',
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: '1',
        side: 'SELL',
        slippagePct: '1',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty('quoteId', 'test-quote-id');
    expect(body).toHaveProperty('tokenIn', mockWETH.address);
    expect(body).toHaveProperty('tokenOut', mockUSDC.address);
    expect(body).toHaveProperty('amountIn', 1);
    expect(body).toHaveProperty('amountOut');
    expect(body.amountOut).toBeGreaterThan(0);
    expect(body).toHaveProperty('price');
    expect(body).toHaveProperty('route');
    expect(body.route).toEqual(['WETH', 'USDC']);
    expect(body).toHaveProperty('routePath', 'WETH -> USDC');
    expect(body).toHaveProperty('methodParameters');
    expect(body.methodParameters).toHaveProperty('to');
    expect(body.methodParameters).toHaveProperty('calldata');
    expect(body.methodParameters).toHaveProperty('value');
  });

  it('should return a valid quote for BUY side', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/quote-swap',
      query: {
        network: 'mainnet',
        walletAddress: '0x0000000000000000000000000000000000000001',
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: '1',
        side: 'BUY',
        slippagePct: '1',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty('tokenIn', mockUSDC.address);
    expect(body).toHaveProperty('tokenOut', mockWETH.address);
    expect(body).toHaveProperty('amountOut', 1);
    expect(body).toHaveProperty('amountIn');
    expect(body.amountIn).toBeGreaterThan(0);
  });

  it('should handle V3 protocol', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/quote-swap',
      query: {
        network: 'mainnet',
        walletAddress: '0x0000000000000000000000000000000000000001',
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: '1',
        side: 'SELL',
        slippagePct: '1',
        protocols: ['v3'],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty('protocols');
    expect(body.protocols).toContain('v3');
  });

  it('should handle multiple protocols', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/quote-swap',
      query: {
        network: 'mainnet',
        walletAddress: '0x0000000000000000000000000000000000000001',
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: '1',
        side: 'SELL',
        slippagePct: '1',
        protocols: ['v2', 'v3'],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty('protocols');
    expect(body.protocols).toEqual(['v2', 'v3']);
  });

  it('should return 404 for invalid token', async () => {
    mockEthereum.getToken.mockImplementation((symbol: string) => {
      if (symbol === 'INVALID') return null;
      const tokens: any = {
        WETH: mockWETH,
        USDC: mockUSDC,
      };
      return tokens[symbol];
    });

    const response = await server.inject({
      method: 'GET',
      url: '/quote-swap',
      query: {
        network: 'mainnet',
        walletAddress: '0x0000000000000000000000000000000000000001',
        baseToken: 'INVALID',
        quoteToken: 'USDC',
        amount: '1',
        side: 'SELL',
        slippagePct: '1',
      },
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('message');
    expect(body.message).toContain('Token not found');
  });

  it('should handle errors gracefully', async () => {
    // Mock provider to throw error
    jest.doMock('ethers', () => {
      const actual = jest.requireActual('ethers');
      return {
        ...actual,
        Contract: jest.fn().mockImplementation(() => {
          throw new Error('Contract error');
        }),
      };
    });

    const response = await server.inject({
      method: 'GET',
      url: '/quote-swap',
      query: {
        network: 'mainnet',
        walletAddress: '0x0000000000000000000000000000000000000001',
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: '1',
        side: 'SELL',
        slippagePct: '1',
      },
    });

    expect(response.statusCode).toBe(500);
  });
});
