import { providers } from 'ethers';

import { logger } from '../../services/logger';
import { createRateLimitAwareEthereumProvider } from '../../services/rpc-connection-interceptor';
import { RPCProvider, RPCProviderConfig, NetworkInfo } from '../../services/rpc-provider-base';

/**
 * Infura Service - Optimized RPC provider for Ethereum/EVM networks
 * Extends RPCProvider base class with Ethereum-specific features
 *
 * Features:
 * - Support for 30+ Ethereum networks and testnets
 * - HTTP provider always available, WebSocket connects on-demand
 * - Auto-disconnect WebSocket after idle timeout
 * - Automatic network endpoint mapping
 * - Health check capabilities
 */
export class InfuraService extends RPCProvider {
  private provider!: providers.JsonRpcProvider;
  private wsProvider?: providers.WebSocketProvider;
  private wsConnecting: Promise<providers.WebSocketProvider> | null = null;
  private idleTimeout: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs = 30000; // Disconnect after 30s of no activity

  constructor(config: RPCProviderConfig, networkInfo: NetworkInfo) {
    super(config, networkInfo);

    if (networkInfo.chain !== 'ethereum') {
      throw new Error('InfuraService only supports Ethereum networks');
    }

    this.initializeHttpProvider();
  }

  /**
   * Get the Infura HTTP RPC URL for the current network
   */
  public getHttpUrl(): string {
    const network = this.getInfuraNetworkName();
    return `https://${network}.infura.io/v3/${this.config.apiKey}`;
  }

  /**
   * Get the Infura WebSocket RPC URL for the current network
   * Returns null if WebSocket is not configured or API key is invalid
   */
  public getWebSocketUrl(): string | null {
    if (!this.shouldUseWebSocket()) return null;

    const network = this.getInfuraNetworkName();
    return `wss://${network}.infura.io/ws/v3/${this.config.apiKey}`;
  }

  /**
   * Initialize HTTP provider (always available)
   */
  private initializeHttpProvider(): void {
    const httpUrl = this.getHttpUrl();

    // Initialize HTTP provider with rate limit detection
    this.provider = createRateLimitAwareEthereumProvider(
      new providers.JsonRpcProvider(httpUrl, {
        name: this.getNetworkName(),
        chainId: this.networkInfo.chainId,
      }),
      httpUrl,
    );
  }

  /**
   * Initialize the service
   */
  public async initialize(): Promise<void> {
    // HTTP provider initialized in constructor
    // WebSocket connects on-demand when getWebSocketProvider() is called
    logger.info(`Infura service initialized for ${this.getNetworkName()} (WebSocket will connect on-demand)`);
  }

  /**
   * Get or create WebSocket provider on-demand
   * Returns null if WebSocket is not available
   */
  public async getWebSocketProvider(): Promise<providers.WebSocketProvider | null> {
    if (!this.shouldUseWebSocket()) {
      return null;
    }

    // Return existing connected provider
    if (this.wsProvider && this.isWebSocketConnected()) {
      this.resetIdleTimeout();
      return this.wsProvider;
    }

    // If already connecting, wait for that attempt
    if (this.wsConnecting) {
      try {
        return await this.wsConnecting;
      } catch {
        return null;
      }
    }

    // Start new connection
    this.wsConnecting = this.connectWebSocket();
    try {
      const provider = await this.wsConnecting;
      this.resetIdleTimeout();
      return provider;
    } catch (error: any) {
      logger.warn(`Failed to connect Infura WebSocket: ${error.message}`);
      return null;
    } finally {
      this.wsConnecting = null;
    }
  }

  /**
   * Connect to Infura WebSocket endpoint
   */
  private async connectWebSocket(): Promise<providers.WebSocketProvider> {
    const wsUrl = this.getWebSocketUrl();
    if (!wsUrl) {
      throw new Error('WebSocket URL not available');
    }

    logger.info(`Connecting to Infura WebSocket for ${this.getNetworkName()} on-demand`);

    // Clean up existing provider if any
    if (this.wsProvider) {
      try {
        this.wsProvider.destroy();
      } catch {
        // Ignore cleanup errors
      }
    }

    this.wsProvider = createRateLimitAwareEthereumProvider(new providers.WebSocketProvider(wsUrl), wsUrl);

    // Wait for connection to be ready
    await this.wsProvider.ready;
    logger.info(`Infura WebSocket connected for ${this.getNetworkName()}`);

    return this.wsProvider;
  }

  /**
   * Reset idle timeout - call this when WebSocket is actively used
   */
  private resetIdleTimeout(): void {
    this.cancelIdleTimeout();
    this.idleTimeout = setTimeout(() => {
      if (this.wsProvider) {
        logger.info(`Closing idle Infura WebSocket for ${this.getNetworkName()}`);
        this.wsProvider.destroy();
        this.wsProvider = undefined;
      }
    }, this.idleTimeoutMs);
  }

  /**
   * Cancel pending idle timeout
   */
  private cancelIdleTimeout(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
  }

  /**
   * Check if WebSocket is currently connected
   */
  public override isWebSocketConnected(): boolean {
    return !!(this.wsProvider && this.wsProvider._websocket && this.wsProvider._websocket.readyState === 1);
  }

  /**
   * Map chainId to Infura network name
   */
  private getInfuraNetworkName(): string {
    const networkMap: Record<number, string> = {
      // Mainnets
      1: 'mainnet',
      10: 'optimism-mainnet',
      56: 'bsc-mainnet',
      137: 'polygon-mainnet',
      324: 'zksync-mainnet',
      534352: 'scroll-mainnet',
      5000: 'mantle-mainnet',
      8453: 'base-mainnet',
      42161: 'arbitrum-mainnet',
      42220: 'celo-mainnet',
      43114: 'avalanche-mainnet',
      59144: 'linea-mainnet',
      81457: 'blast-mainnet',
      204: 'opbnb-mainnet',
      11297108109: 'palm-mainnet',
      // Testnets
      11155111: 'sepolia',
      421614: 'arbitrum-sepolia',
      43113: 'avalanche-fuji',
      84532: 'base-sepolia',
      168587773: 'blast-sepolia',
      97: 'bsc-testnet',
      44787: 'celo-alfajores',
      59141: 'linea-sepolia',
      5003: 'mantle-sepolia',
      5611: 'opbnb-testnet',
      11155420: 'optimism-sepolia',
      11297108099: 'palm-testnet',
      80002: 'polygon-amoy',
      534351: 'scroll-sepolia',
      300: 'zksync-sepolia',
    };

    const network = networkMap[this.networkInfo.chainId];
    if (!network) {
      throw new Error(`Infura network not supported for chainID: ${this.networkInfo.chainId}`);
    }

    return network;
  }

  /**
   * Get human-readable network name
   */
  private getNetworkName(): string {
    const nameMap: Record<number, string> = {
      // Mainnets
      1: 'Ethereum Mainnet',
      10: 'Optimism',
      56: 'BSC',
      137: 'Polygon',
      324: 'ZKsync Era',
      534352: 'Scroll',
      5000: 'Mantle',
      8453: 'Base',
      42161: 'Arbitrum',
      42220: 'Celo',
      43114: 'Avalanche',
      59144: 'Linea',
      81457: 'Blast',
      204: 'opBNB',
      11297108109: 'Palm',
      // Testnets
      11155111: 'Sepolia',
      421614: 'Arbitrum Sepolia',
      43113: 'Avalanche Fuji',
      84532: 'Base Sepolia',
      168587773: 'Blast Sepolia',
      97: 'BSC Testnet',
      44787: 'Celo Alfajores',
      59141: 'Linea Sepolia',
      5003: 'Mantle Sepolia',
      5611: 'opBNB Testnet',
      11155420: 'Optimism Sepolia',
      11297108099: 'Palm Testnet',
      80002: 'Polygon Amoy',
      534351: 'Scroll Sepolia',
      300: 'ZKsync Sepolia',
    };

    return nameMap[this.networkInfo.chainId] || `Chain ${this.networkInfo.chainId}`;
  }

  /**
   * Get the HTTP provider (always available)
   * For WebSocket, use getWebSocketProvider() instead
   */
  public getProvider(): providers.JsonRpcProvider {
    return this.provider;
  }

  /**
   * Health check - verify RPC connection
   */
  public override async healthCheck(): Promise<boolean> {
    try {
      await this.provider.getBlockNumber();
      logger.debug(`Infura health check passed for ${this.getNetworkName()}`);
      return true;
    } catch (error: any) {
      logger.error(`Infura health check failed for ${this.getNetworkName()}: ${error.message}`);
      return false;
    }
  }

  /**
   * Disconnect and clean up resources
   */
  public disconnect(): void {
    this.cancelIdleTimeout();

    if (this.wsProvider) {
      this.wsProvider.destroy();
      this.wsProvider = undefined;
      logger.info(`Infura WebSocket disconnected for ${this.getNetworkName()}`);
    }

    if (this.provider && 'destroy' in this.provider) {
      (this.provider as any).destroy();
    }
  }
}
