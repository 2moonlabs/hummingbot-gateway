import { StrategyType } from '@meteora-ag/dlmm';
import { DecimalUtil } from '@orca-so/common-sdk';
import { Type, Static } from '@sinclair/typebox';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BN } from 'bn.js';
import { Decimal } from 'decimal.js';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import {
  OpenPositionRequest,
  OpenPositionResponse,
  OpenPositionResponseType,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { Meteora } from '../meteora';
import { MeteoraConfig } from '../meteora.config';

// Using Fastify's native error handling

// Define error messages
const INVALID_SOLANA_ADDRESS_MESSAGE = (address: string) =>
  `Invalid Solana address: ${address}`;
const POOL_NOT_FOUND_MESSAGE = (poolAddress: string) =>
  `Pool not found: ${poolAddress}`;
const MISSING_AMOUNTS_MESSAGE = 'Missing amounts for position creation';
const INSUFFICIENT_BALANCE_MESSAGE = (
  token: string,
  required: string,
  actual: string,
) =>
  `Insufficient balance for ${token}. Required: ${required}, Available: ${actual}`;
const OPEN_POSITION_ERROR_MESSAGE = (error: any) =>
  `Failed to open position: ${error.message || error}`;

const SOL_POSITION_RENT = 0.05; // SOL amount required for position rent
const SOL_TRANSACTION_BUFFER = 0.01; // Additional SOL buffer for transaction costs

async function openPosition(
  fastify: FastifyInstance,
  network: string,
  walletAddress: string,
  lowerPrice: number,
  upperPrice: number,
  poolAddress: string,
  baseTokenAmount: number | undefined,
  quoteTokenAmount: number | undefined,
  slippagePct?: number,
  strategyType?: number,
): Promise<OpenPositionResponseType> {
  const solana = await Solana.getInstance(network);
  const meteora = await Meteora.getInstance(network);

  // Validate addresses first
  try {
    new PublicKey(poolAddress);
    new PublicKey(walletAddress);
  } catch (error) {
    const invalidAddress = error.message.includes(poolAddress)
      ? 'pool'
      : 'wallet';
    throw fastify.httpErrors.badRequest(
      INVALID_SOLANA_ADDRESS_MESSAGE(invalidAddress),
    );
  }

  const wallet = await solana.getWallet(walletAddress);
  const newImbalancePosition = new Keypair();

  let dlmmPool;
  try {
    dlmmPool = await meteora.getDlmmPool(poolAddress);
    if (!dlmmPool) {
      throw fastify.httpErrors.notFound(POOL_NOT_FOUND_MESSAGE(poolAddress));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Invalid account discriminator')
    ) {
      throw fastify.httpErrors.notFound(POOL_NOT_FOUND_MESSAGE(poolAddress));
    }
    throw error; // Re-throw unexpected errors
  }

  const tokenX = await solana.getToken(dlmmPool.tokenX.publicKey.toBase58());
  const tokenY = await solana.getToken(dlmmPool.tokenY.publicKey.toBase58());
  const tokenXSymbol = tokenX?.symbol || 'UNKNOWN';
  const tokenYSymbol = tokenY?.symbol || 'UNKNOWN';

  if (!baseTokenAmount && !quoteTokenAmount) {
    throw fastify.httpErrors.badRequest(MISSING_AMOUNTS_MESSAGE);
  }

  // Check balances with SOL buffer
  const balances = await solana.getBalance(wallet, [
    tokenXSymbol,
    tokenYSymbol,
    'SOL',
  ]);
  const requiredBaseAmount =
    (baseTokenAmount || 0) +
    (tokenXSymbol === 'SOL' ? SOL_POSITION_RENT + SOL_TRANSACTION_BUFFER : 0);
  const requiredQuoteAmount =
    (quoteTokenAmount || 0) +
    (tokenYSymbol === 'SOL' ? SOL_POSITION_RENT + SOL_TRANSACTION_BUFFER : 0);

  if (balances[tokenXSymbol] < requiredBaseAmount) {
    throw fastify.httpErrors.badRequest(
      INSUFFICIENT_BALANCE_MESSAGE(
        tokenXSymbol,
        requiredBaseAmount.toString(),
        balances[tokenXSymbol].toString(),
      ),
    );
  }

  if (tokenYSymbol && balances[tokenYSymbol] < requiredQuoteAmount) {
    throw fastify.httpErrors.badRequest(
      `Insufficient ${tokenYSymbol} balance. Required: ${requiredQuoteAmount}, Available: ${balances[tokenYSymbol]}`,
    );
  }

  // Get current pool price from active bin
  const activeBin = await dlmmPool.getActiveBin();
  const currentPrice = Number(activeBin.pricePerToken);

  // Validate price position requirements
  if (currentPrice < lowerPrice) {
    if (
      !baseTokenAmount ||
      baseTokenAmount <= 0 ||
      (quoteTokenAmount !== undefined && quoteTokenAmount !== 0)
    ) {
      throw fastify.httpErrors.badRequest(
        OPEN_POSITION_ERROR_MESSAGE(
          `Current price ${currentPrice.toFixed(4)} is below lower price ${lowerPrice.toFixed(4)}. ` +
            `Requires positive ${tokenXSymbol} amount and zero ${tokenYSymbol} amount.`,
        ),
      );
    }
  } else if (currentPrice > upperPrice) {
    if (
      !quoteTokenAmount ||
      quoteTokenAmount <= 0 ||
      (baseTokenAmount !== undefined && baseTokenAmount !== 0)
    ) {
      throw fastify.httpErrors.badRequest(
        OPEN_POSITION_ERROR_MESSAGE(
          `Current price ${currentPrice.toFixed(4)} is above upper price ${upperPrice.toFixed(4)}. ` +
            `Requires positive ${tokenYSymbol} amount and zero ${tokenXSymbol} amount.`,
        ),
      );
    }
  }

  const lowerPricePerLamport = dlmmPool.toPricePerLamport(lowerPrice);
  const upperPricePerLamport = dlmmPool.toPricePerLamport(upperPrice);
  const minBinId = dlmmPool.getBinIdFromPrice(
    Number(lowerPricePerLamport),
    true,
  );
  const maxBinId = dlmmPool.getBinIdFromPrice(
    Number(upperPricePerLamport),
    false,
  );

  const totalXAmount = new BN(
    DecimalUtil.toBN(
      new Decimal(
        baseTokenAmount || 0 + (tokenXSymbol === 'SOL' ? SOL_POSITION_RENT : 0),
      ),
      dlmmPool.tokenX.decimal,
    ),
  );
  const totalYAmount = new BN(
    DecimalUtil.toBN(
      new Decimal(
        quoteTokenAmount ||
          0 + (tokenYSymbol === 'SOL' ? SOL_POSITION_RENT : 0),
      ),
      dlmmPool.tokenY.decimal,
    ),
  );

  const createPositionTx =
    await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newImbalancePosition.publicKey,
      user: wallet.publicKey,
      strategy: {
        maxBinId,
        minBinId,
        strategyType: strategyType ?? MeteoraConfig.config.strategyType,
      },
      totalXAmount,
      totalYAmount,
      slippage: slippagePct ?? meteora.getSlippagePct(),
    });

  logger.info(
    `Opening position in pool ${poolAddress} with price range ${lowerPrice.toFixed(4)} - ${upperPrice.toFixed(4)} ${tokenYSymbol}/${tokenXSymbol}`,
  );
  const { signature } = await solana.sendAndConfirmTransaction(
    createPositionTx,
    [wallet, newImbalancePosition],
    1_000_000,
  );

  const { baseTokenBalanceChange, quoteTokenBalanceChange, fee } =
    await solana.extractPairBalanceChangesAndFee(
      signature,
      tokenX,
      tokenY,
      wallet.publicKey.toBase58(),
    );

  // Calculate sentSOL based on which token is SOL
  const sentSOL =
    tokenXSymbol === 'SOL'
      ? Math.abs(baseTokenBalanceChange - fee)
      : tokenYSymbol === 'SOL'
        ? Math.abs(quoteTokenBalanceChange - fee)
        : fee;

  logger.info(
    `Position opened at ${newImbalancePosition.publicKey.toBase58()}: ${Math.abs(baseTokenBalanceChange).toFixed(4)} ${tokenXSymbol}, ${Math.abs(quoteTokenBalanceChange).toFixed(4)} ${tokenYSymbol}`,
  );

  return {
    signature,
    fee: fee,
    positionAddress: newImbalancePosition.publicKey.toBase58(),
    positionRent: sentSOL,
    baseTokenAmountAdded: baseTokenBalanceChange,
    quoteTokenAmountAdded: quoteTokenBalanceChange,
  };
}

export const MeteoraOpenPositionRequest = Type.Intersect(
  [
    OpenPositionRequest,
    Type.Object({
      strategyType: Type.Optional(
        Type.Number({
          enum: Object.values(StrategyType).filter(
            (x) => typeof x === 'number',
          ),
        }),
      ),
    }),
  ],
  { $id: 'MeteoraOpenPositionRequest' },
);

export type MeteoraOpenPositionRequestType = Static<
  typeof MeteoraOpenPositionRequest
>;

export const openPositionRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Solana.getWalletAddressExample();

  fastify.post<{
    Body: MeteoraOpenPositionRequestType;
    Reply: OpenPositionResponseType;
  }>(
    '/open-position',
    {
      schema: {
        description: 'Open a new Meteora position',
        tags: ['meteora/clmm'],
        body: {
          ...OpenPositionRequest,
          properties: {
            ...OpenPositionRequest.properties,
            network: { type: 'string', default: 'mainnet-beta' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            lowerPrice: { type: 'number', examples: [100] },
            upperPrice: { type: 'number', examples: [180] },
            poolAddress: {
              type: 'string',
              examples: ['2sf5NYcY4zUPXUSmG6f66mskb24t5F8S11pC1Nz5nQT3'],
            },
            baseTokenAmount: { type: 'number', examples: [0.1] },
            quoteTokenAmount: { type: 'number', examples: [15] },
            slippagePct: { type: 'number', examples: [1] },
            strategyType: {
              type: 'number',
              examples: [StrategyType.SpotImBalanced],
              enum: Object.values(StrategyType).filter(
                (x) => typeof x === 'number',
              ),
            },
          },
        },
        response: {
          200: OpenPositionResponse,
        },
      },
    },
    async (request) => {
      try {
        const {
          network,
          walletAddress,
          lowerPrice,
          upperPrice,
          poolAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
          strategyType,
        } = request.body;
        const networkToUse = network || 'mainnet-beta';

        return await openPosition(
          fastify,
          networkToUse,
          walletAddress,
          lowerPrice,
          upperPrice,
          poolAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
          strategyType,
        );
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw fastify.httpErrors.createError(e.statusCode, 'Request failed');
        }
        throw fastify.httpErrors.internalServerError('Internal server error');
      }
    },
  );
};

export default openPositionRoute;
