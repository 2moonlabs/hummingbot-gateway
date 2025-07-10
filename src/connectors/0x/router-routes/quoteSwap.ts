import { Static } from '@sinclair/typebox';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { QuoteSwapRequestType } from '../../../schemas/router-schema';
import { logger } from '../../../services/logger';
import { quoteCache } from '../../../services/quote-cache';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { ZeroX, ZeroXQuoteResponse } from '../0x';
import { ZeroXConfig } from '../0x.config';
import { ZeroXQuoteSwapRequest, ZeroXQuoteSwapResponse } from '../schemas';

async function quoteSwap(
  fastify: FastifyInstance,
  network: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct: number,
  indicativePrice: boolean = true,
  takerAddress?: string,
): Promise<Static<typeof ZeroXQuoteSwapResponse>> {
  const ethereum = await Ethereum.getInstance(network);
  const zeroX = await ZeroX.getInstance(network);

  // Resolve token symbols to addresses
  const baseTokenInfo = ethereum.getToken(baseToken);
  const quoteTokenInfo = ethereum.getToken(quoteToken);

  if (!baseTokenInfo || !quoteTokenInfo) {
    throw fastify.httpErrors.badRequest(
      sanitizeErrorMessage('Token not found: {}', !baseTokenInfo ? baseToken : quoteToken),
    );
  }

  // Determine input/output based on side
  const sellToken = side === 'SELL' ? baseTokenInfo.address : quoteTokenInfo.address;
  const buyToken = side === 'SELL' ? quoteTokenInfo.address : baseTokenInfo.address;
  const tokenDecimals = side === 'SELL' ? baseTokenInfo.decimals : quoteTokenInfo.decimals;

  // Convert amount to token units
  const tokenAmount = zeroX.parseTokenAmount(amount, tokenDecimals);

  // Use provided taker address or example
  const walletAddress = takerAddress || (await Ethereum.getWalletAddressExample());

  logger.info(
    `Getting ${indicativePrice ? 'indicative price' : 'firm quote'} for ${amount} ${side === 'SELL' ? baseToken : quoteToken} -> ${side === 'SELL' ? quoteToken : baseToken}`,
  );

  // Get quote or price from 0x API based on indicativePrice flag
  let apiResponse: any;
  if (indicativePrice) {
    // Use price API for indicative quotes (no commitment)
    const priceParams: any = {
      sellToken,
      buyToken,
      takerAddress: walletAddress,
      slippagePercentage: slippagePct / 100, // Convert to percentage
      skipValidation: true, // Always skip validation for price quotes
    };

    // Only add the amount parameter that we're using
    if (side === 'SELL') {
      priceParams.sellAmount = tokenAmount;
    } else {
      priceParams.buyAmount = tokenAmount;
    }

    apiResponse = await zeroX.getPrice(priceParams);
  } else {
    // Use quote API for firm quotes (with commitment)
    const quoteParams: any = {
      sellToken,
      buyToken,
      takerAddress: walletAddress,
      slippagePercentage: slippagePct / 100, // Convert to percentage
      skipValidation: false,
    };

    // Only add the amount parameter that we're using
    if (side === 'SELL') {
      quoteParams.sellAmount = tokenAmount;
    } else {
      quoteParams.buyAmount = tokenAmount;
    }

    apiResponse = await zeroX.getQuote(quoteParams);
  }

  // Parse amounts
  const sellDecimals = side === 'SELL' ? baseTokenInfo.decimals : quoteTokenInfo.decimals;
  const buyDecimals = side === 'SELL' ? quoteTokenInfo.decimals : baseTokenInfo.decimals;

  const estimatedAmountIn = parseFloat(zeroX.formatTokenAmount(apiResponse.sellAmount, sellDecimals));
  const estimatedAmountOut = parseFloat(zeroX.formatTokenAmount(apiResponse.buyAmount, buyDecimals));

  // Calculate min/max amounts based on slippage
  const minAmountOut = side === 'SELL' ? estimatedAmountOut * (1 - slippagePct / 100) : amount;
  const maxAmountIn = side === 'BUY' ? estimatedAmountIn * (1 + slippagePct / 100) : amount;

  // Calculate price based on side
  const price = side === 'SELL' ? estimatedAmountOut / estimatedAmountIn : estimatedAmountIn / estimatedAmountOut;

  // Calculate price with slippage
  // For SELL: worst price = minAmountOut / estimatedAmountIn (minimum quote per base)
  // For BUY: worst price = maxAmountIn / estimatedAmountOut (maximum quote per base)
  const priceWithSlippage = side === 'SELL' ? minAmountOut / estimatedAmountIn : maxAmountIn / estimatedAmountOut;

  // Parse price impact
  const priceImpactPct = apiResponse.estimatedPriceImpact ? parseFloat(apiResponse.estimatedPriceImpact) * 100 : 0;

  // Generate quote ID and cache only for firm quotes
  let quoteId: string;
  let expirationTime: number | undefined;
  const now = Date.now();

  if (!indicativePrice) {
    // Only generate quote ID and cache for firm quotes
    quoteId = uuidv4();
    expirationTime = now + 30000; // 30 seconds TTL

    // Store the quote in global cache for later execution
    quoteCache.set(quoteId, apiResponse, {
      network,
      baseToken,
      quoteToken,
      amount,
      side,
      slippagePct,
      sellToken,
      buyToken,
      baseTokenInfo,
      quoteTokenInfo,
      walletAddress,
    });
  } else {
    // For indicative prices, use a placeholder quote ID
    quoteId = 'indicative-price';
  }

  // Format gas estimate
  const gasEstimate = apiResponse.estimatedGas || apiResponse.gas || '300000';

  return {
    quoteId,
    tokenIn: sellToken,
    tokenOut: buyToken,
    amountIn: side === 'SELL' ? amount : estimatedAmountIn,
    amountOut: side === 'SELL' ? estimatedAmountOut : amount,
    price,
    slippagePct,
    priceWithSlippage,
    minAmountOut,
    maxAmountIn,
    priceImpactPct,
    gasEstimate,
    ...(expirationTime && { expirationTime }),
    // 0x-specific fields (only available for firm quotes)
    sources: apiResponse.sources,
    allowanceTarget: apiResponse.allowanceTarget,
    to: apiResponse.to,
    data: apiResponse.data,
    value: apiResponse.value,
  };
}

export { quoteSwap };

export const quoteSwapRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.get<{
    Querystring: QuoteSwapRequestType;
    Reply: Static<typeof ZeroXQuoteSwapResponse>;
  }>(
    '/quote-swap',
    {
      schema: {
        description:
          'Get a swap quote from 0x. Use indicativePrice=true for price discovery only, or false/undefined for executable quotes',
        tags: ['/connector/0x'],
        querystring: ZeroXQuoteSwapRequest,
        response: { 200: ZeroXQuoteSwapResponse },
      },
    },
    async (request) => {
      try {
        const { network, baseToken, quoteToken, amount, side, slippagePct, indicativePrice, takerAddress } =
          request.query as typeof ZeroXQuoteSwapRequest._type;

        return await quoteSwap(
          fastify,
          network,
          baseToken,
          quoteToken,
          amount,
          side as 'BUY' | 'SELL',
          slippagePct,
          indicativePrice ?? true,
          takerAddress,
        );
      } catch (e: any) {
        if (e.statusCode) throw e;
        logger.error('Error getting quote:', e.message || e);

        // Handle specific error cases
        if (e.message?.includes('0x API key not configured')) {
          throw fastify.httpErrors.badRequest(e.message);
        }
        if (e.message?.includes('0x API Error')) {
          throw fastify.httpErrors.badRequest(e.message);
        }

        throw fastify.httpErrors.internalServerError(e.message || 'Failed to get quote');
      }
    },
  );
};

// Export quote cache for use in execute-quote
export { quoteCache };

export default quoteSwapRoute;
