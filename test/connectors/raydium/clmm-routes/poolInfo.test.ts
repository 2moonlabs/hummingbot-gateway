import { Raydium } from '../../../../src/connectors/raydium/raydium';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';

jest.mock('../../../../src/connectors/raydium/raydium');

const buildApp = async () => {
  const server = fastifyWithTypeProvider();
  await server.register(require('@fastify/sensible'));
  const { poolInfoRoute } = await import('../../../../src/connectors/raydium/clmm-routes/poolInfo');
  await server.register(poolInfoRoute);
  return server;
};

const mockPoolAddress = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv';

const mockPoolInfo = {
  address: mockPoolAddress,
  baseTokenAddress: 'So11111111111111111111111111111111111111112',
  quoteTokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  binStep: 4,
  feePct: 0.0001,
  price: 200.5,
  baseTokenAmount: 1000,
  quoteTokenAmount: 200500,
  activeBinId: -28800,
};

describe('GET /pool-info (raydium clmm)', () => {
  let app: any;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const mockRaydium = {
      getClmmPoolInfo: jest.fn().mockResolvedValue(mockPoolInfo),
    };
    (Raydium.getInstance as jest.Mock).mockResolvedValue(mockRaydium);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the base pool info shape', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/pool-info',
      query: { network: 'mainnet-beta', poolAddress: mockPoolAddress },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual(
      expect.objectContaining({
        address: mockPoolAddress,
        baseTokenAddress: mockPoolInfo.baseTokenAddress,
        quoteTokenAddress: mockPoolInfo.quoteTokenAddress,
        feePct: expect.any(Number),
        price: expect.any(Number),
        activeBinId: expect.any(Number),
      }),
    );
  });

  it('returns 404 when pool not found', async () => {
    (Raydium.getInstance as jest.Mock).mockResolvedValue({
      getClmmPoolInfo: jest.fn().mockResolvedValue(null),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/pool-info',
      query: { network: 'mainnet-beta', poolAddress: mockPoolAddress },
    });
    expect(response.statusCode).toBe(404);
  });

  describe('binCount param (impl deferred — schema accepted but no bins yet)', () => {
    it('accepts binCount=0 and returns no bins[]', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/pool-info',
        query: { network: 'mainnet-beta', poolAddress: mockPoolAddress, binCount: 0 },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).bins).toBeUndefined();
    });

    it('accepts binCount>0 but still returns no bins[] (impl deferred)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/pool-info',
        query: { network: 'mainnet-beta', poolAddress: mockPoolAddress, binCount: 11 },
      });
      // The schema is accepted; bins[] is not populated until the Raydium
      // bin-distribution helper lands. This test guards against accidental
      // schema regressions.
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).bins).toBeUndefined();
    });

    it('rejects binCount above the schema max', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/pool-info',
        query: { network: 'mainnet-beta', poolAddress: mockPoolAddress, binCount: 999 },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
