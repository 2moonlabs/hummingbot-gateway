import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import {
  CollectFeesRequest,
  CollectFeesResponse,
  CollectFeesRequestType,
  CollectFeesResponseType,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { Meteora } from '../meteora';

export async function collectFees(
  fastify: FastifyInstance,
  network: string,
  address: string,
  positionAddress: string,
): Promise<CollectFeesResponseType> {
  const solana = await Solana.getInstance(network);
  const meteora = await Meteora.getInstance(network);
  const wallet = await solana.getWallet(address);

  // Get position result and check if it's null before destructuring
  const positionResult = await meteora.getRawPosition(
    positionAddress,
    wallet.publicKey,
  );

  if (!positionResult) {
    throw fastify.httpErrors.notFound(`Position not found: ${positionAddress}`);
  }

  // Now safely destructure
  const { position, info } = positionResult;

  if (!position) {
    throw fastify.httpErrors.notFound(`Position not found: ${positionAddress}`);
  }

  const dlmmPool = await meteora.getDlmmPool(info.publicKey.toBase58());
  if (!dlmmPool) {
    throw fastify.httpErrors.notFound(
      `Pool not found for position: ${positionAddress}`,
    );
  }

  const tokenX = await solana.getToken(dlmmPool.tokenX.publicKey.toBase58());
  const tokenY = await solana.getToken(dlmmPool.tokenY.publicKey.toBase58());
  const tokenXSymbol = tokenX?.symbol || 'UNKNOWN';
  const tokenYSymbol = tokenY?.symbol || 'UNKNOWN';

  logger.info(`Collecting fees from position ${positionAddress}`);

  const claimSwapFeeTx = await dlmmPool.claimSwapFee({
    owner: wallet.publicKey,
    position: position,
  });

  const { signature, fee } = await solana.sendAndConfirmTransaction(
    claimSwapFeeTx,
    [wallet],
    300_000,
  );

  const { balanceChange: collectedFeeX } =
    await solana.extractTokenBalanceChangeAndFee(
      signature,
      dlmmPool.tokenX.publicKey.toBase58(),
      dlmmPool.pubkey.toBase58(),
    );

  const { balanceChange: collectedFeeY } =
    await solana.extractTokenBalanceChangeAndFee(
      signature,
      dlmmPool.tokenY.publicKey.toBase58(),
      dlmmPool.pubkey.toBase58(),
    );

  logger.info(
    `Fees collected from position ${positionAddress}: ${Math.abs(collectedFeeX).toFixed(4)} ${tokenXSymbol}, ${Math.abs(collectedFeeY).toFixed(4)} ${tokenYSymbol}`,
  );

  return {
    signature,
    fee,
    baseFeeAmountCollected: Math.abs(collectedFeeX),
    quoteFeeAmountCollected: Math.abs(collectedFeeY),
  };
}

export const collectFeesRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Solana.getWalletAddressExample();

  fastify.post<{
    Body: CollectFeesRequestType;
    Reply: CollectFeesResponseType;
  }>(
    '/collect-fees',
    {
      schema: {
        description: 'Collect fees from a Meteora position',
        tags: ['meteora/clmm'],
        body: {
          ...CollectFeesRequest,
          properties: {
            ...CollectFeesRequest.properties,
            network: { type: 'string', default: 'mainnet-beta' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
          },
        },
        response: {
          200: CollectFeesResponse,
        },
      },
    },
    async (request) => {
      try {
        const { network, walletAddress, positionAddress } = request.body;
        const networkToUse = network || 'mainnet-beta';

        return await collectFees(
          fastify,
          networkToUse,
          walletAddress,
          positionAddress,
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

export default collectFeesRoute;
