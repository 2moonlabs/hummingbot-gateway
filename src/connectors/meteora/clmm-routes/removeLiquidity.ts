import { BN } from '@coral-xyz/anchor';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import {
  RemoveLiquidityRequest,
  RemoveLiquidityResponse,
  RemoveLiquidityRequestType,
  RemoveLiquidityResponseType,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { Meteora } from '../meteora';

// Using Fastify's native error handling
const INVALID_SOLANA_ADDRESS_MESSAGE = (address: string) =>
  `Invalid Solana address: ${address}`;
import { PublicKey } from '@solana/web3.js';

export async function removeLiquidity(
  fastify: FastifyInstance,
  network: string,
  walletAddress: string,
  positionAddress: string,
  percentageToRemove: number,
): Promise<RemoveLiquidityResponseType> {
  const solana = await Solana.getInstance(network);
  const meteora = await Meteora.getInstance(network);
  const wallet = await solana.getWallet(walletAddress);

  try {
    new PublicKey(positionAddress);
    new PublicKey(walletAddress);
  } catch (error) {
    const invalidAddress = error.message.includes(positionAddress)
      ? 'position'
      : 'wallet';
    throw fastify.httpErrors.badRequest(
      INVALID_SOLANA_ADDRESS_MESSAGE(invalidAddress),
    );
  }

  const { position, info } = await meteora.getRawPosition(
    positionAddress,
    wallet.publicKey,
  );
  const dlmmPool = await meteora.getDlmmPool(info.publicKey.toBase58());
  const tokenX = await solana.getToken(dlmmPool.tokenX.publicKey.toBase58());
  const tokenY = await solana.getToken(dlmmPool.tokenY.publicKey.toBase58());
  const tokenXSymbol = tokenX?.symbol || 'UNKNOWN';
  const tokenYSymbol = tokenY?.symbol || 'UNKNOWN';

  logger.info(
    `Removing ${percentageToRemove.toFixed(4)}% liquidity from position ${positionAddress}`,
  );
  const binIdsToRemove = position.positionData.positionBinData.map(
    (bin) => bin.binId,
  );
  const bps = new BN(percentageToRemove * 100);

  const removeLiquidityTx = await dlmmPool.removeLiquidity({
    position: position.publicKey,
    user: wallet.publicKey,
    binIds: binIdsToRemove,
    bps: bps,
    shouldClaimAndClose: false,
  });

  if (Array.isArray(removeLiquidityTx)) {
    throw fastify.httpErrors.internalServerError(
      'Unexpected array of transactions',
    );
  }
  const { signature, fee } = await solana.sendAndConfirmTransaction(
    removeLiquidityTx,
    [wallet],
    1_000_000,
  );

  const { balanceChange: tokenXRemovedAmount } =
    await solana.extractTokenBalanceChangeAndFee(
      signature,
      dlmmPool.tokenX.publicKey.toBase58(),
      dlmmPool.pubkey.toBase58(),
    );

  const { balanceChange: tokenYRemovedAmount } =
    await solana.extractTokenBalanceChangeAndFee(
      signature,
      dlmmPool.tokenY.publicKey.toBase58(),
      dlmmPool.pubkey.toBase58(),
    );

  logger.info(
    `Liquidity removed from position ${positionAddress}: ${Math.abs(tokenXRemovedAmount).toFixed(4)} ${tokenXSymbol}, ${Math.abs(tokenYRemovedAmount).toFixed(4)} ${tokenYSymbol}`,
  );

  return {
    signature,
    fee,
    baseTokenAmountRemoved: Math.abs(tokenXRemovedAmount),
    quoteTokenAmountRemoved: Math.abs(tokenYRemovedAmount),
  };
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
        description: 'Remove liquidity from a Meteora position',
        tags: ['meteora/clmm'],
        body: {
          ...RemoveLiquidityRequest,
          properties: {
            ...RemoveLiquidityRequest.properties,
            network: { type: 'string', default: 'mainnet-beta' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
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
        const { network, walletAddress, positionAddress, percentageToRemove } =
          request.body;

        const networkToUse = network || 'mainnet-beta';

        return await removeLiquidity(
          fastify,
          networkToUse,
          walletAddress,
          positionAddress,
          percentageToRemove,
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

export default removeLiquidityRoute;
