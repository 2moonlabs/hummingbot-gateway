import {
  AmmV4Keys,
  CpmmKeys,
  ApiV3PoolInfoStandardItem,
  ApiV3PoolInfoStandardItemCpmm,
  Percent,
} from '@raydium-io/raydium-sdk-v2';
import { VersionedTransaction, Transaction, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Solana, BASE_FEE } from '../../../chains/solana/solana';
import {
  RemoveLiquidityRequest,
  RemoveLiquidityResponse,
  RemoveLiquidityRequestType,
  RemoveLiquidityResponseType,
} from '../../../schemas/amm-schema';
import { logger } from '../../../services/logger';
import { Raydium } from '../raydium';

// Interfaces for SDK responses
interface TokenBurnInfo {
  amount: BN;
  mint: string;
  tokenAccount: string;
}

interface TokenReceiveInfo {
  amount: BN;
  mint: string;
  tokenAccount: string;
}

interface AMMRemoveLiquiditySDKResponse {
  transaction: VersionedTransaction | Transaction;
  tokenBurnInfo?: TokenBurnInfo;
  tokenReceiveInfoA?: TokenReceiveInfo;
  tokenReceiveInfoB?: TokenReceiveInfo;
}

interface CPMMWithdrawLiquiditySDKResponse {
  transaction: VersionedTransaction | Transaction;
  poolMint?: string;
  poolAccount?: string;
  burnAmount?: BN;
  receiveAmountA?: BN;
  receiveAmountB?: BN;
}

async function createRemoveLiquidityTransaction(
  raydium: Raydium,
  ammPoolInfo: any,
  poolInfo: any,
  poolKeys: any,
  lpAmount: BN,
  computeBudgetConfig: { units: number; microLamports: number },
): Promise<VersionedTransaction | Transaction> {
  if (ammPoolInfo.poolType === 'amm') {
    const response: AMMRemoveLiquiditySDKResponse =
      await raydium.raydiumSDK.liquidity.removeLiquidity({
        poolInfo: poolInfo as ApiV3PoolInfoStandardItem,
        poolKeys: poolKeys as AmmV4Keys,
        amountIn: lpAmount,
        txVersion: raydium.txVersion,
        computeBudgetConfig,
      });
    return response.transaction;
  } else if (ammPoolInfo.poolType === 'cpmm') {
    // Use default slippage from Raydium class
    const slippage = new Percent(
      Math.floor(raydium.getSlippagePct() * 100) / 10000,
    );

    const response: CPMMWithdrawLiquiditySDKResponse =
      await raydium.raydiumSDK.cpmm.withdrawLiquidity({
        poolInfo: poolInfo as ApiV3PoolInfoStandardItemCpmm,
        poolKeys: poolKeys as CpmmKeys,
        lpAmount: lpAmount,
        txVersion: raydium.txVersion,
        slippage,
        computeBudgetConfig,
      });
    return response.transaction;
  }
  throw new Error(`Unsupported pool type: ${ammPoolInfo.poolType}`);
}

/**
 * Calculate the LP token amount to remove based on percentage
 */
async function calculateLpAmountToRemove(
  solana: Solana,
  wallet: any,
  _ammPoolInfo: any,
  poolInfo: any,
  poolAddress: string,
  percentageToRemove: number,
): Promise<BN> {
  let lpMint: string;

  // Get LP mint from poolInfo instead of poolKeys
  if (poolInfo.lpMint && poolInfo.lpMint.address) {
    lpMint = poolInfo.lpMint.address;
  } else {
    throw new Error(`Could not find LP mint for pool ${poolAddress}`);
  }

  // Get user's LP token account
  const lpTokenAccounts = await solana.connection.getTokenAccountsByOwner(
    wallet.publicKey,
    { mint: new PublicKey(lpMint) },
  );

  if (lpTokenAccounts.value.length === 0) {
    throw new Error(`No LP token account found for pool ${poolAddress}`);
  }

  // Get LP token balance
  const lpTokenAccount = lpTokenAccounts.value[0].pubkey;
  const accountInfo =
    await solana.connection.getTokenAccountBalance(lpTokenAccount);
  const lpBalance = new BN(
    new Decimal(accountInfo.value.uiAmount)
      .mul(10 ** accountInfo.value.decimals)
      .toFixed(0),
  );

  if (lpBalance.isZero()) {
    throw new Error('LP token balance is zero - nothing to remove');
  }

  // Calculate LP amount to remove based on percentage
  return new BN(
    new Decimal(lpBalance.toString()).mul(percentageToRemove / 100).toFixed(0),
  );
}

async function removeLiquidity(
  _fastify: FastifyInstance,
  network: string,
  walletAddress: string,
  poolAddress: string,
  percentageToRemove: number,
  baseToken?: string,
  quoteToken?: string,
): Promise<RemoveLiquidityResponseType> {
  const solana = await Solana.getInstance(network);
  const raydium = await Raydium.getInstance(network);
  const wallet = await solana.getWallet(walletAddress);

  // If no pool address provided, find default pool using base and quote tokens
  let poolAddressToUse = poolAddress;
  if (!poolAddressToUse) {
    if (!baseToken || !quoteToken) {
      throw new Error(
        'Either poolAddress or both baseToken and quoteToken must be provided',
      );
    }

    poolAddressToUse = await raydium.findDefaultPool(
      baseToken,
      quoteToken,
      'amm',
    );
    if (!poolAddressToUse) {
      throw new Error(`No AMM pool found for pair ${baseToken}-${quoteToken}`);
    }
  }

  const ammPoolInfo = await raydium.getAmmPoolInfo(poolAddressToUse);
  const [poolInfo, poolKeys] = await raydium.getPoolfromAPI(poolAddressToUse);

  if (percentageToRemove <= 0 || percentageToRemove > 100) {
    throw new Error('Invalid percentageToRemove - must be between 0 and 100');
  }

  // Calculate LP amount to remove
  const lpAmountToRemove = await calculateLpAmountToRemove(
    solana,
    wallet,
    ammPoolInfo,
    poolInfo,
    poolAddressToUse,
    percentageToRemove,
  );

  logger.info(
    `Removing ${percentageToRemove.toFixed(4)}% liquidity from pool ${poolAddressToUse}...`,
  );
  const COMPUTE_UNITS = 600000;

  let currentPriorityFee = (await solana.estimateGas()) * 1e9 - BASE_FEE;
  while (currentPriorityFee <= solana.config.maxPriorityFee * 1e9) {
    const priorityFeePerCU = Math.floor(
      (currentPriorityFee * 1e6) / COMPUTE_UNITS,
    );

    const transaction = await createRemoveLiquidityTransaction(
      raydium,
      ammPoolInfo,
      poolInfo,
      poolKeys,
      lpAmountToRemove,
      {
        units: COMPUTE_UNITS,
        microLamports: priorityFeePerCU,
      },
    );

    if (transaction instanceof VersionedTransaction) {
      (transaction as VersionedTransaction).sign([wallet]);
    } else {
      const txAsTransaction = transaction as Transaction;
      const { blockhash, lastValidBlockHeight } =
        await solana.connection.getLatestBlockhash();
      txAsTransaction.recentBlockhash = blockhash;
      txAsTransaction.lastValidBlockHeight = lastValidBlockHeight;
      txAsTransaction.feePayer = wallet.publicKey;
      txAsTransaction.sign(wallet);
    }

    await solana.simulateTransaction(transaction);

    const { confirmed, signature, txData } =
      await solana.sendAndConfirmRawTransaction(transaction);
    if (confirmed && txData) {
      const { baseTokenBalanceChange, quoteTokenBalanceChange } =
        await solana.extractPairBalanceChangesAndFee(
          signature,
          await solana.getToken(poolInfo.mintA.address),
          await solana.getToken(poolInfo.mintB.address),
          wallet.publicKey.toBase58(),
        );

      logger.info(
        `Liquidity removed from pool ${poolAddressToUse}: ${Math.abs(baseTokenBalanceChange).toFixed(4)} ${poolInfo.mintA.symbol}, ${Math.abs(quoteTokenBalanceChange).toFixed(4)} ${poolInfo.mintB.symbol}`,
      );

      return {
        signature,
        fee: txData.meta.fee / 1e9,
        baseTokenAmountRemoved: Math.abs(baseTokenBalanceChange),
        quoteTokenAmountRemoved: Math.abs(quoteTokenBalanceChange),
      };
    }
    currentPriorityFee =
      currentPriorityFee * solana.config.priorityFeeMultiplier;
    logger.info(
      `Increasing max priority fee to ${(currentPriorityFee / 1e9).toFixed(6)} SOL`,
    );
  }
  throw new Error(
    `Remove liquidity failed after reaching max priority fee of ${(solana.config.maxPriorityFee / 1e9).toFixed(6)} SOL`,
  );
}

export const removeLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Solana.getWalletAddressExample();

  fastify.post<{
    Body: RemoveLiquidityRequestType;
    Reply: RemoveLiquidityResponseType;
  }>(
    '/remove-liquidity',
    {
      schema: {
        description: 'Remove liquidity from a Raydium AMM/CPMM pool',
        tags: ['raydium/amm'],
        body: {
          ...RemoveLiquidityRequest,
          properties: {
            ...RemoveLiquidityRequest.properties,
            network: { type: 'string', default: 'mainnet-beta' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            poolAddress: {
              type: 'string',
              examples: ['6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg'],
            }, // AMM RAY-USDC
            baseToken: { type: 'string', examples: ['SOL'] },
            quoteToken: { type: 'string', examples: ['USDC'] },
            percentageToRemove: { type: 'number', examples: [100] },
          },
        },
        response: {
          200: RemoveLiquidityResponse,
        },
      },
    },
    async (request) => {
      try {
        const {
          network,
          walletAddress,
          poolAddress,
          baseToken,
          quoteToken,
          percentageToRemove,
        } = request.body;

        // Check if either poolAddress or both baseToken and quoteToken are provided
        if (!poolAddress && (!baseToken || !quoteToken)) {
          throw fastify.httpErrors.badRequest(
            'Either poolAddress or both baseToken and quoteToken must be provided',
          );
        }

        return await removeLiquidity(
          fastify,
          network || 'mainnet-beta',
          walletAddress,
          poolAddress,
          percentageToRemove,
          baseToken,
          quoteToken,
        );
      } catch (e) {
        logger.error(e);
        throw fastify.httpErrors.internalServerError('Internal server error');
      }
    },
  );
};

export default removeLiquidityRoute;
