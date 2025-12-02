import WebSocket from 'ws';

import { logger } from '../../services/logger';
import {
  RPCProvider,
  RPCProviderConfig,
  NetworkInfo,
  TransactionMonitorResult,
} from '../../services/rpc-provider-base';

interface WebSocketSubscription {
  signature: string;
  resolve: (result: TransactionMonitorResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface WebSocketMessage {
  jsonrpc: string;
  method?: string;
  params?: {
    result: {
      context: {
        slot: number;
      };
      value:
        | {
            err: any;
          }
        | string
        | any; // For account notifications
    };
    subscription: number;
  };
  result?: number;
  id?: number;
  error?: any;
}

/**
 * Helius Service - Optimized RPC provider for Solana networks
 * Extends RPCProvider base class with Solana-specific features
 *
 * Features:
 * - WebSocket transaction monitoring for faster confirmations (connects on-demand)
 * - Auto-disconnect after idle timeout
 * - Support for both mainnet-beta and devnet
 */
export class HeliusService extends RPCProvider {
  private subscriptions = new Map<number, WebSocketSubscription>();
  private nextSubscriptionId = 1;
  private idleTimeout: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs = 30000; // Disconnect after 30s of no active subscriptions
  private connecting: Promise<void> | null = null; // Prevent concurrent connection attempts

  constructor(config: RPCProviderConfig, networkInfo: NetworkInfo) {
    super(config, networkInfo);
  }

  /**
   * Get the Helius HTTP RPC URL for the current network
   */
  public getHttpUrl(): string {
    const isDevnet = this.networkInfo.network.includes('devnet');
    const subdomain = isDevnet ? 'devnet' : 'mainnet';
    return `https://${subdomain}.helius-rpc.com/?api-key=${this.config.apiKey}`;
  }

  /**
   * Get the Helius WebSocket RPC URL for the current network
   * Returns null if WebSocket is not configured or API key is invalid
   */
  public getWebSocketUrl(): string | null {
    if (!this.shouldUseWebSocket()) return null;

    const isDevnet = this.networkInfo.network.includes('devnet');
    const subdomain = isDevnet ? 'devnet' : 'mainnet';
    return `wss://${subdomain}.helius-rpc.com/?api-key=${this.config.apiKey}`;
  }

  /**
   * Initialize Helius services
   * Note: WebSocket connection is now on-demand, so this is a no-op
   */
  public async initialize(): Promise<void> {
    // WebSocket connects on-demand when monitorTransaction is called
    logger.info('Helius service initialized (WebSocket will connect on-demand)');
  }

  /**
   * Ensure WebSocket is connected, connecting if necessary
   * Returns true if connected, false if WebSocket is not available
   */
  private async ensureWebSocketConnected(): Promise<boolean> {
    if (!this.shouldUseWebSocket()) {
      return false;
    }

    if (this.isWebSocketConnected()) {
      return true;
    }

    // If already connecting, wait for that attempt
    if (this.connecting) {
      try {
        await this.connecting;
        return this.isWebSocketConnected();
      } catch {
        return false;
      }
    }

    // Start new connection
    this.connecting = this.connectWebSocket();
    try {
      await this.connecting;
      return true;
    } catch (error: any) {
      logger.warn(`Failed to connect Helius WebSocket: ${error.message}`);
      return false;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Connect to Helius WebSocket endpoint
   */
  private async connectWebSocket(): Promise<void> {
    const wsUrl = this.getWebSocketUrl();
    if (!wsUrl) {
      throw new Error('WebSocket URL not available');
    }

    const isDevnet = this.networkInfo.network.includes('devnet');
    logger.info(`Connecting to Helius WebSocket (${isDevnet ? 'devnet' : 'mainnet'}) on-demand`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          logger.info('Helius WebSocket connected for transaction monitoring');
          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          try {
            const message: WebSocketMessage = JSON.parse(data.toString());
            this.handleWebSocketMessage(message);
          } catch (error: any) {
            logger.error(`Error parsing WebSocket message: ${error.message}`);
          }
        });

        this.ws.on('error', (error) => {
          logger.error(`WebSocket connection error: ${error.message}`);
          reject(error);
        });

        this.ws.on('close', (code, reason) => {
          logger.info(`WebSocket closed: code=${code}, reason=${reason?.toString()}`);
          this.ws = null;
          // Reject pending subscriptions on unexpected close
          this.handleWebSocketClose();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleWebSocketMessage(message: WebSocketMessage): void {
    if (message.method === 'signatureNotification' && message.params) {
      const subscriptionId = message.params.subscription;
      const result = message.params.result;

      const subscription = this.subscriptions.get(subscriptionId);
      if (subscription) {
        clearTimeout(subscription.timeout);
        this.subscriptions.delete(subscriptionId);

        // Note: Server automatically unsubscribes after signatureNotification,
        // so we don't need to call unsubscribeFromSignature here

        if (result && result.value && typeof result.value === 'object' && 'err' in result.value && result.value.err) {
          subscription.resolve({ confirmed: false, txData: result });
        } else {
          subscription.resolve({ confirmed: true, txData: result });
        }
      }
    } else if (message.result !== undefined && typeof message.id === 'number') {
      // Subscription confirmation - remap from local ID to server subscription ID
      const localId = message.id;
      const serverSubscriptionId = message.result;
      logger.debug(`WebSocket subscription ${localId} confirmed with server ID ${serverSubscriptionId}`);

      // Move subscription from local ID to server subscription ID
      const subscription = this.subscriptions.get(localId);
      if (subscription) {
        this.subscriptions.delete(localId);
        this.subscriptions.set(serverSubscriptionId, subscription);
        logger.debug(`Remapped subscription from local ID ${localId} to server ID ${serverSubscriptionId}`);
      }
    } else if (message.error) {
      // Ignore "Invalid subscription id" errors - these happen when trying to unsubscribe
      // from a subscription that was already auto-removed by the server
      if (message.error.code === -32602 && message.error.message?.includes('Invalid subscription')) {
        logger.debug(`Ignoring expected unsubscribe error: ${message.error.message}`);
        return;
      }

      logger.error(`WebSocket subscription error: ${JSON.stringify(message.error)}`);
      const subscription = this.subscriptions.get(message.id!);
      if (subscription) {
        clearTimeout(subscription.timeout);
        this.subscriptions.delete(message.id!);
        subscription.reject(new Error(`WebSocket error: ${message.error.message}`));
      }
    }
  }

  /**
   * Check if transaction monitoring via WebSocket is supported
   */
  public override supportsTransactionMonitoring(): boolean {
    return this.shouldUseWebSocket();
  }

  /**
   * Monitor a transaction signature for confirmation via WebSocket
   * Connects on-demand if not already connected
   */
  public override async monitorTransaction(
    signature: string,
    timeoutMs: number = 30000,
  ): Promise<TransactionMonitorResult> {
    // Connect on-demand
    const connected = await this.ensureWebSocketConnected();
    if (!connected) {
      throw new Error('WebSocket not available');
    }

    // Cancel idle timeout since we have an active subscription
    this.cancelIdleTimeout();

    return new Promise((resolve, reject) => {
      const subscriptionId = this.nextSubscriptionId++;

      // Wrapper to handle cleanup and idle timeout
      const resolveWithCleanup = (result: TransactionMonitorResult) => {
        this.subscriptions.delete(subscriptionId);
        this.scheduleIdleDisconnect();
        resolve(result);
      };

      const rejectWithCleanup = (error: Error) => {
        this.subscriptions.delete(subscriptionId);
        this.scheduleIdleDisconnect();
        reject(error);
      };

      // Set up timeout
      const timeout = setTimeout(() => {
        this.subscriptions.delete(subscriptionId);
        this.scheduleIdleDisconnect();
        resolve({ confirmed: false });
      }, timeoutMs);

      // Store subscription details
      this.subscriptions.set(subscriptionId, {
        signature,
        resolve: resolveWithCleanup,
        reject: rejectWithCleanup,
        timeout,
      });

      // Subscribe to signature
      const subscribeMessage = {
        jsonrpc: '2.0',
        id: subscriptionId,
        method: 'signatureSubscribe',
        params: [
          signature,
          {
            commitment: 'confirmed',
          },
        ],
      };

      (this.ws as WebSocket).send(JSON.stringify(subscribeMessage));
      logger.info(`Monitoring transaction ${signature} via WebSocket`);
    });
  }

  /**
   * Schedule disconnection after idle timeout if no active subscriptions
   */
  private scheduleIdleDisconnect(): void {
    if (this.subscriptions.size > 0) {
      return; // Still have active subscriptions
    }

    this.cancelIdleTimeout();
    this.idleTimeout = setTimeout(() => {
      if (this.subscriptions.size === 0 && this.ws) {
        logger.info('Closing idle Helius WebSocket connection');
        (this.ws as WebSocket).close();
        this.ws = null;
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
   * Unsubscribe from a signature subscription
   */
  private unsubscribeFromSignature(subscriptionId: number): void {
    if (this.ws && (this.ws as WebSocket).readyState === WebSocket.OPEN) {
      const unsubscribeMessage = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'signatureUnsubscribe',
        params: [subscriptionId],
      };
      (this.ws as WebSocket).send(JSON.stringify(unsubscribeMessage));
    }
  }

  /**
   * Handle WebSocket close - reject pending subscriptions
   * No automatic reconnection; will reconnect on next monitorTransaction call
   */
  private handleWebSocketClose(): void {
    // Reject all pending subscriptions
    for (const [_, subscription] of this.subscriptions) {
      clearTimeout(subscription.timeout);
      subscription.reject(new Error('WebSocket disconnected'));
    }
    this.subscriptions.clear();
    this.cancelIdleTimeout();
  }

  /**
   * Check if WebSocket monitoring is available
   */
  public override isWebSocketConnected(): boolean {
    return this.ws !== null && (this.ws as WebSocket).readyState === WebSocket.OPEN;
  }

  /**
   * Disconnect and clean up all resources
   */
  public disconnect(): void {
    this.cancelIdleTimeout();

    // Clear all pending subscriptions
    for (const [_, subscription] of this.subscriptions) {
      clearTimeout(subscription.timeout);
      subscription.reject(new Error('Service disconnected'));
    }
    this.subscriptions.clear();

    if (this.ws) {
      (this.ws as WebSocket).close();
      this.ws = null;
      logger.info('Helius WebSocket disconnected');
    }
  }
}
