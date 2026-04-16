import { ChainstackService } from '../../src/rpc/chainstack-service';
import { httpGet } from '../../src/services/http-client';

// Mock only httpGet; keep other exports (like HttpClientError) intact.
jest.mock('../../src/services/http-client', () => {
  const actual = jest.requireActual('../../src/services/http-client');
  return {
    ...actual,
    httpGet: jest.fn(),
  };
});

const mockedHttpGet = httpGet as jest.MockedFunction<typeof httpGet>;

const mockOk = <T>(data: T) => ({ data, status: 200, statusText: 'OK' });

const testApiKey = 'test-chainstack-key-123';

const solanaMainnetNode = {
  id: 'ND-111-111-111',
  protocol: 'solana',
  network: 'solana-mainnet',
  status: 'running',
  https_endpoint: 'https://solana-mainnet.core.chainstack.com/abc',
  wss_endpoint: 'wss://solana-mainnet.core.chainstack.com/abc',
};

const ethereumMainnetNode = {
  id: 'ND-333-333-333',
  protocol: 'ethereum',
  network: 'ethereum-mainnet',
  status: 'running',
  https_endpoint: 'https://ethereum-mainnet.core.chainstack.com/ghi',
  wss_endpoint: 'wss://ethereum-mainnet.core.chainstack.com/ghi',
};

const arbitrumNode = {
  id: 'ND-444-444-444',
  protocol: 'arbitrum',
  network: 'arbitrum-mainnet',
  status: 'running',
  https_endpoint: 'https://arbitrum-mainnet.core.chainstack.com/jkl',
  wss_endpoint: 'wss://arbitrum-mainnet.core.chainstack.com/jkl',
};

describe('ChainstackService', () => {
  beforeEach(() => {
    mockedHttpGet.mockReset();
  });

  describe('initialize', () => {
    it('discovers a Solana mainnet node and caches endpoints', async () => {
      mockedHttpGet.mockResolvedValueOnce(mockOk([solanaMainnetNode, ethereumMainnetNode]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'solana', network: 'mainnet-beta', chainId: 101 },
      );
      await service.initialize();

      expect(mockedHttpGet).toHaveBeenCalledWith(
        'https://api.chainstack.com/v1/nodes',
        expect.objectContaining({
          headers: { Authorization: `Bearer ${testApiKey}` },
        }),
      );
      expect(service.getHttpUrl()).toBe(solanaMainnetNode.https_endpoint);
      expect(service.getWebSocketUrl()).toBe(solanaMainnetNode.wss_endpoint);
    });

    it('discovers an Ethereum mainnet node', async () => {
      mockedHttpGet.mockResolvedValueOnce(mockOk([ethereumMainnetNode]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'ethereum', network: 'mainnet', chainId: 1 },
      );
      await service.initialize();

      expect(service.getHttpUrl()).toBe(ethereumMainnetNode.https_endpoint);
    });

    it('maps arbitrum/polygon via protocol name, not "ethereum"', async () => {
      mockedHttpGet.mockResolvedValueOnce(mockOk([ethereumMainnetNode, arbitrumNode]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'ethereum', network: 'arbitrum', chainId: 42161 },
      );
      await service.initialize();

      expect(service.getHttpUrl()).toBe(arbitrumNode.https_endpoint);
    });

    it('ignores stopped nodes', async () => {
      const stopped = { ...solanaMainnetNode, status: 'stopped' };
      mockedHttpGet.mockResolvedValueOnce(mockOk([stopped]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'solana', network: 'mainnet-beta', chainId: 101 },
      );

      await expect(service.initialize()).rejects.toThrow(/No running Chainstack node/);
    });

    it('throws when no matching node exists for the requested network', async () => {
      mockedHttpGet.mockResolvedValueOnce(mockOk([ethereumMainnetNode]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'solana', network: 'devnet', chainId: 103 },
      );

      await expect(service.initialize()).rejects.toThrow(/No running Chainstack node/);
    });

    it('throws when the gateway network is not mapped to a Chainstack network', async () => {
      mockedHttpGet.mockResolvedValueOnce(mockOk([]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'ethereum', network: 'unknown-network', chainId: 99999 },
      );

      await expect(service.initialize()).rejects.toThrow(/Chainstack network not supported/);
    });

    it('throws on empty API key', async () => {
      const service = new ChainstackService({ apiKey: '' }, { chain: 'solana', network: 'mainnet-beta', chainId: 101 });

      await expect(service.initialize()).rejects.toThrow(/API key/);
    });
  });

  describe('getHttpUrl / getWebSocketUrl', () => {
    it('getHttpUrl throws before initialize()', () => {
      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'solana', network: 'mainnet-beta', chainId: 101 },
      );

      expect(() => service.getHttpUrl()).toThrow(/not initialized/);
    });

    it('getWebSocketUrl returns null before initialize()', () => {
      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'solana', network: 'mainnet-beta', chainId: 101 },
      );

      expect(service.getWebSocketUrl()).toBeNull();
    });
  });

  describe('supportsTransactionMonitoring', () => {
    it('returns true for Solana after initialize (WSS endpoint present)', async () => {
      mockedHttpGet.mockResolvedValueOnce(mockOk([solanaMainnetNode]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'solana', network: 'mainnet-beta', chainId: 101 },
      );
      await service.initialize();

      expect(service.supportsTransactionMonitoring()).toBe(true);
    });

    it('returns false for Ethereum even after initialize', async () => {
      mockedHttpGet.mockResolvedValueOnce(mockOk([ethereumMainnetNode]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'ethereum', network: 'mainnet', chainId: 1 },
      );
      await service.initialize();

      expect(service.supportsTransactionMonitoring()).toBe(false);
    });

    it('returns false before initialize', () => {
      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'solana', network: 'mainnet-beta', chainId: 101 },
      );

      expect(service.supportsTransactionMonitoring()).toBe(false);
    });
  });

  describe('getProvider', () => {
    it('returns an ethers provider after Ethereum initialize', async () => {
      mockedHttpGet.mockResolvedValueOnce(mockOk([ethereumMainnetNode]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'ethereum', network: 'mainnet', chainId: 1 },
      );
      await service.initialize();

      const provider = service.getProvider();
      expect(provider).toBeDefined();
      // Rate-limit interceptor wraps the provider in a Proxy; connection.url is preserved.
      expect(provider.connection.url).toBe(ethereumMainnetNode.https_endpoint);
    });

    it('throws on Solana chain (Ethereum-only)', async () => {
      mockedHttpGet.mockResolvedValueOnce(mockOk([solanaMainnetNode]));

      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'solana', network: 'mainnet-beta', chainId: 101 },
      );
      await service.initialize();

      expect(() => service.getProvider()).toThrow(/Ethereum-only/);
    });

    it('throws before initialize', () => {
      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'ethereum', network: 'mainnet', chainId: 1 },
      );

      expect(() => service.getProvider()).toThrow(/not initialized/);
    });
  });

  describe('isWebSocketConnected', () => {
    it('returns false when WebSocket is not initialized', () => {
      const service = new ChainstackService(
        { apiKey: testApiKey },
        { chain: 'solana', network: 'mainnet-beta', chainId: 101 },
      );

      expect(service.isWebSocketConnected()).toBe(false);
    });
  });
});
