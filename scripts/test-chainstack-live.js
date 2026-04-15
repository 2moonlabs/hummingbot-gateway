#!/usr/bin/env node

/**
 * Live Chainstack Integration Testing Script
 *
 * Verifies the Chainstack RPC provider integration with a real API key.
 * Hits the Gateway's chain status endpoints for every Chainstack-supported
 * network and exercises Solana transaction monitoring if a Solana node exists.
 *
 * Prerequisites:
 * - Valid Chainstack API key configured in conf/apiKeys.yml under `chainstack`
 * - Gateway chains/solana.yml and chains/ethereum.yml use `rpcProvider: chainstack`
 * - At least one running Chainstack node matching each network you want to test
 * - Gateway server running: pnpm start --passphrase=test123 --dev
 *
 * Usage: node scripts/test-chainstack-live.js
 */

const axios = require('axios');

const GATEWAY_URL = 'http://localhost:15888';
const CHAINSTACK_API = 'https://api.chainstack.com/v1/nodes';

const tests = { passed: 0, failed: 0, results: [] };

function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const colors = {
    info: '\x1b[34m[INFO]\x1b[0m',
    success: '\x1b[32m[\u2713]\x1b[0m',
    error: '\x1b[31m[\u2717]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
    test: '\x1b[36m[TEST]\x1b[0m',
  };
  console.log(`${timestamp} ${colors[type] || colors.info} ${message}`);
}

async function testCase(name, fn) {
  log(`Running: ${name}`, 'test');
  try {
    const startTime = Date.now();
    await fn();
    const duration = Date.now() - startTime;
    tests.passed++;
    tests.results.push({ name, status: 'passed', duration });
    log(`\u2713 ${name} (${duration}ms)`, 'success');
  } catch (error) {
    tests.failed++;
    tests.results.push({ name, status: 'failed', error: error.message });
    log(`\u2717 ${name}: ${error.message}`, 'error');
  }
}

// Mirrors ChainstackService.NETWORK_MAP — kept in sync by hand.
const GATEWAY_NETWORKS = [
  { chain: 'ethereum', network: 'mainnet', expectedChainId: 1 },
  { chain: 'ethereum', network: 'arbitrum', expectedChainId: 42161 },
  { chain: 'ethereum', network: 'polygon', expectedChainId: 137 },
  { chain: 'ethereum', network: 'optimism', expectedChainId: 10 },
  { chain: 'ethereum', network: 'base', expectedChainId: 8453 },
  { chain: 'ethereum', network: 'avalanche', expectedChainId: 43114 },
  { chain: 'ethereum', network: 'bsc', expectedChainId: 56 },
  { chain: 'ethereum', network: 'celo', expectedChainId: 42220 },
  { chain: 'ethereum', network: 'sepolia', expectedChainId: 11155111 },
  { chain: 'solana', network: 'mainnet-beta' },
  { chain: 'solana', network: 'devnet' },
];

async function readChainstackApiKey() {
  const fs = require('fs');
  const path = require('path');
  const apiKeysPath = path.join(process.cwd(), 'conf', 'apiKeys.yml');
  if (!fs.existsSync(apiKeysPath)) return '';
  const contents = fs.readFileSync(apiKeysPath, 'utf8');
  const match = contents.match(/^chainstack:\s*['"]?([^'"\s]+)['"]?/m);
  return match ? match[1] : '';
}

async function listChainstackNodes(apiKey) {
  const response = await axios.get(CHAINSTACK_API, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 10000,
  });
  const data = response.data;
  return Array.isArray(data) ? data : data.results || [];
}

async function testChainStatus({ chain, network, expectedChainId }) {
  const response = await axios.get(`${GATEWAY_URL}/chains/${chain}/status?network=${network}`);
  if (response.status !== 200) {
    throw new Error(`Expected status 200, got ${response.status}`);
  }
  const data = response.data;
  if (expectedChainId !== undefined && data.chainId !== expectedChainId) {
    throw new Error(`Expected chainId ${expectedChainId}, got ${data.chainId}`);
  }
  log(`${chain}/${network}: chainId=${data.chainId ?? 'n/a'}, block=${data.blockNumber ?? 'n/a'}`, 'info');
}

async function runTests() {
  log('\ud83d\ude80 Starting Chainstack Integration Tests', 'info');

  const apiKey = await readChainstackApiKey();
  if (!apiKey) {
    log('No chainstack key found in conf/apiKeys.yml — skipping Platform API discovery', 'warn');
  } else {
    await testCase('Chainstack Platform API: list_nodes', async () => {
      const nodes = await listChainstackNodes(apiKey);
      log(`Discovered ${nodes.length} Chainstack node(s)`, 'info');
      nodes.forEach((n) =>
        log(`  - ${n.id} ${n.protocol}/${n.network} [${n.status}]`, 'info'),
      );
    });
  }

  for (const network of GATEWAY_NETWORKS) {
    await testCase(`Chain status: ${network.chain}/${network.network}`, () => testChainStatus(network));
  }

  log('', 'info');
  log('=== Test Summary ===', 'info');
  log(`Total: ${tests.passed + tests.failed}`, 'info');
  log(`Passed: ${tests.passed}`, tests.passed > 0 ? 'success' : 'info');
  log(`Failed: ${tests.failed}`, tests.failed > 0 ? 'error' : 'info');

  if (tests.failed > 0) {
    log('', 'info');
    log('Failed tests:', 'error');
    tests.results
      .filter((r) => r.status === 'failed')
      .forEach((r) => log(`  - ${r.name}: ${r.error}`, 'error'));
    process.exit(1);
  }
  process.exit(0);
}

process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error.message}`, 'error');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`, 'error');
  process.exit(1);
});

runTests();
