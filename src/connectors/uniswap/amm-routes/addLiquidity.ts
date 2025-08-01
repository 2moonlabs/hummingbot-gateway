import { Contract } from '@ethersproject/contracts';
import { Percent } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { wrapEthereum } from '../../../chains/ethereum/routes/wrap';
import {
  AddLiquidityRequestType,
  AddLiquidityRequest,
  AddLiquidityResponseType,
  AddLiquidityResponse,
} from '../../../schemas/amm-schema';
import { logger } from '../../../services/logger';
import { Uniswap } from '../uniswap';
import {
  getUniswapV2RouterAddress,
  IUniswapV2Router02ABI,
} from '../uniswap.contracts';
import { formatTokenAmount } from '../uniswap.utils';

import { getUniswapAmmLiquidityQuote } from './quoteLiquidity';

async function addLiquidity(
  fastify: any,
  network: string,
  walletAddress: string,
  poolAddress: string,
  baseToken: string,
  quoteToken: string,
  baseTokenAmount: number,
  quoteTokenAmount: number,
  slippagePct?: number,
): Promise<AddLiquidityResponseType> {
  const networkToUse = network || 'base';

  // Handle ETH->WETH wrapping if needed for baseToken
  let actualBaseToken = baseToken;
  let baseWrapTxHash = null;
  if (baseToken === 'ETH') {
    const uniswap = await Uniswap.getInstance(networkToUse);
    const wethToken = uniswap.getTokenBySymbol('WETH');
    if (!wethToken) {
      throw new Error('WETH token not found');
    }

    logger.info(
      `ETH detected as base token, wrapping ${baseTokenAmount} ETH to WETH first`,
    );

    const wrapResult = await wrapEthereum(
      fastify,
      networkToUse,
      walletAddress,
      baseTokenAmount.toString(),
    );
    baseWrapTxHash = wrapResult.signature;
    actualBaseToken = 'WETH';

    logger.info(
      `Successfully wrapped ${baseTokenAmount} ETH to WETH, transaction hash: ${baseWrapTxHash}`,
    );
  }

  // Handle ETH->WETH wrapping if needed for quoteToken
  let actualQuoteToken = quoteToken;
  let quoteWrapTxHash = null;
  if (quoteToken === 'ETH') {
    const uniswap = await Uniswap.getInstance(networkToUse);
    const wethToken = uniswap.getTokenBySymbol('WETH');
    if (!wethToken) {
      throw new Error('WETH token not found');
    }

    logger.info(
      `ETH detected as quote token, wrapping ${quoteTokenAmount} ETH to WETH first`,
    );

    const wrapResult = await wrapEthereum(
      fastify,
      networkToUse,
      walletAddress,
      quoteTokenAmount.toString(),
    );
    quoteWrapTxHash = wrapResult.signature;
    actualQuoteToken = 'WETH';

    logger.info(
      `Successfully wrapped ${quoteTokenAmount} ETH to WETH, transaction hash: ${quoteWrapTxHash}`,
    );
  }

  // Get quote first to calculate optimal amounts and get execution data
  const quote = await getUniswapAmmLiquidityQuote(
    networkToUse,
    poolAddress,
    actualBaseToken,
    actualQuoteToken,
    baseTokenAmount,
    quoteTokenAmount,
    slippagePct,
  );

  // Get Ethereum instance
  const ethereum = await Ethereum.getInstance(networkToUse);
  const uniswap = await Uniswap.getInstance(networkToUse);

  // Get wallet
  const wallet = await ethereum.getWallet(walletAddress);
  if (!wallet) {
    throw new Error('Wallet not found');
  }

  // Get the router contract with signer
  const router = new Contract(
    quote.routerAddress,
    IUniswapV2Router02ABI.abi,
    wallet,
  );

  // Calculate slippage-adjusted amounts
  const slippageTolerance = slippagePct
    ? new Percent(slippagePct, 100)
    : uniswap.getAllowedSlippage();

  const slippageMultiplier = new Percent(1).subtract(slippageTolerance);

  const baseTokenMinAmount = quote.rawBaseTokenAmount
    .mul(slippageMultiplier.numerator.toString())
    .div(slippageMultiplier.denominator.toString());

  const quoteTokenMinAmount = quote.rawQuoteTokenAmount
    .mul(slippageMultiplier.numerator.toString())
    .div(slippageMultiplier.denominator.toString());

  // Prepare the transaction parameters
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

  let tx;

  // Check if one of the tokens is WETH
  if (quote.baseTokenObj.symbol === 'WETH') {
    // Check allowance for quote token
    const tokenContract = ethereum.getContract(
      quote.quoteTokenObj.address,
      wallet,
    );
    const allowance = await ethereum.getERC20Allowance(
      tokenContract,
      wallet,
      quote.routerAddress,
      quote.quoteTokenObj.decimals,
    );

    const currentAllowance = BigNumber.from(allowance.value);
    logger.info(
      `Current allowance for ${quote.quoteTokenObj.symbol}: ${formatTokenAmount(currentAllowance.toString(), quote.quoteTokenObj.decimals)}`,
    );
    logger.info(
      `Amount needed for ${quote.quoteTokenObj.symbol}: ${formatTokenAmount(quote.rawQuoteTokenAmount.toString(), quote.quoteTokenObj.decimals)}`,
    );

    // Check if allowance is sufficient
    if (currentAllowance.lt(quote.rawQuoteTokenAmount)) {
      throw new Error(
        `Insufficient allowance for ${quote.quoteTokenObj.symbol}. Please approve at least ${formatTokenAmount(quote.rawQuoteTokenAmount.toString(), quote.quoteTokenObj.decimals)} ${quote.quoteTokenObj.symbol} for the Uniswap router (${quote.routerAddress})`,
      );
    }

    // Add liquidity ETH + Token
    tx = await router.addLiquidityETH(
      quote.quoteTokenObj.address,
      quote.rawQuoteTokenAmount,
      quoteTokenMinAmount,
      baseTokenMinAmount,
      walletAddress,
      deadline,
      {
        value: quote.rawBaseTokenAmount,
        gasLimit: 300000,
      },
    );
  } else if (quote.quoteTokenObj.symbol === 'WETH') {
    // Check allowance for base token
    const tokenContract = ethereum.getContract(
      quote.baseTokenObj.address,
      wallet,
    );
    const allowance = await ethereum.getERC20Allowance(
      tokenContract,
      wallet,
      quote.routerAddress,
      quote.baseTokenObj.decimals,
    );

    const currentAllowance = BigNumber.from(allowance.value);
    logger.info(
      `Current allowance for ${quote.baseTokenObj.symbol}: ${formatTokenAmount(currentAllowance.toString(), quote.baseTokenObj.decimals)}`,
    );
    logger.info(
      `Amount needed for ${quote.baseTokenObj.symbol}: ${formatTokenAmount(quote.rawBaseTokenAmount.toString(), quote.baseTokenObj.decimals)}`,
    );

    // Check if allowance is sufficient
    if (currentAllowance.lt(quote.rawBaseTokenAmount)) {
      throw new Error(
        `Insufficient allowance for ${quote.baseTokenObj.symbol}. Please approve at least ${formatTokenAmount(quote.rawBaseTokenAmount.toString(), quote.baseTokenObj.decimals)} ${quote.baseTokenObj.symbol} for the Uniswap router (${quote.routerAddress})`,
      );
    }

    // Add liquidity Token + ETH
    tx = await router.addLiquidityETH(
      quote.baseTokenObj.address,
      quote.rawBaseTokenAmount,
      baseTokenMinAmount,
      quoteTokenMinAmount,
      walletAddress,
      deadline,
      {
        value: quote.rawQuoteTokenAmount,
        gasLimit: 300000,
      },
    );
  } else {
    // Both tokens are ERC20 - check allowances for both
    const baseTokenContract = ethereum.getContract(
      quote.baseTokenObj.address,
      wallet,
    );
    const baseAllowance = await ethereum.getERC20Allowance(
      baseTokenContract,
      wallet,
      quote.routerAddress,
      quote.baseTokenObj.decimals,
    );

    const quoteTokenContract = ethereum.getContract(
      quote.quoteTokenObj.address,
      wallet,
    );
    const quoteAllowance = await ethereum.getERC20Allowance(
      quoteTokenContract,
      wallet,
      quote.routerAddress,
      quote.quoteTokenObj.decimals,
    );

    const currentBaseAllowance = BigNumber.from(baseAllowance.value);
    const currentQuoteAllowance = BigNumber.from(quoteAllowance.value);

    logger.info(
      `Current base allowance for ${quote.baseTokenObj.symbol}: ${formatTokenAmount(currentBaseAllowance.toString(), quote.baseTokenObj.decimals)}`,
    );
    logger.info(
      `Amount needed for ${quote.baseTokenObj.symbol}: ${formatTokenAmount(quote.rawBaseTokenAmount.toString(), quote.baseTokenObj.decimals)}`,
    );
    logger.info(
      `Current quote allowance for ${quote.quoteTokenObj.symbol}: ${formatTokenAmount(currentQuoteAllowance.toString(), quote.quoteTokenObj.decimals)}`,
    );
    logger.info(
      `Amount needed for ${quote.quoteTokenObj.symbol}: ${formatTokenAmount(quote.rawQuoteTokenAmount.toString(), quote.quoteTokenObj.decimals)}`,
    );

    // Check if both allowances are sufficient
    if (currentBaseAllowance.lt(quote.rawBaseTokenAmount)) {
      throw new Error(
        `Insufficient allowance for ${quote.baseTokenObj.symbol}. Please approve at least ${formatTokenAmount(quote.rawBaseTokenAmount.toString(), quote.baseTokenObj.decimals)} ${quote.baseTokenObj.symbol} for the Uniswap router (${quote.routerAddress})`,
      );
    }

    if (currentQuoteAllowance.lt(quote.rawQuoteTokenAmount)) {
      throw new Error(
        `Insufficient allowance for ${quote.quoteTokenObj.symbol}. Please approve at least ${formatTokenAmount(quote.rawQuoteTokenAmount.toString(), quote.quoteTokenObj.decimals)} ${quote.quoteTokenObj.symbol} for the Uniswap router (${quote.routerAddress})`,
      );
    }

    // Add liquidity Token + Token
    tx = await router.addLiquidity(
      quote.baseTokenObj.address,
      quote.quoteTokenObj.address,
      quote.rawBaseTokenAmount,
      quote.rawQuoteTokenAmount,
      baseTokenMinAmount,
      quoteTokenMinAmount,
      walletAddress,
      deadline,
      { gasLimit: 300000 },
    );
  }

  // Wait for transaction confirmation
  const receipt = await tx.wait();

  // Calculate gas fee
  const gasFee = formatTokenAmount(
    receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(),
    18, // ETH has 18 decimals
  );

  return {
    signature: receipt.transactionHash,
    fee: gasFee,
    baseTokenAmountAdded: quote.baseTokenAmount,
    quoteTokenAmountAdded: quote.quoteTokenAmount,
    ...(baseWrapTxHash && { baseWrapTxHash }),
    ...(quoteWrapTxHash && { quoteWrapTxHash }),
  };
}

export const addLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(require('@fastify/sensible'));
  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.post<{
    Body: AddLiquidityRequestType;
    Reply: AddLiquidityResponseType;
  }>(
    '/add-liquidity',
    {
      schema: {
        description: 'Add liquidity to a Uniswap V2 pool',
        tags: ['uniswap/amm'],
        body: {
          ...AddLiquidityRequest,
          properties: {
            ...AddLiquidityRequest.properties,
            network: { type: 'string', default: 'base' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            poolAddress: {
              type: 'string',
              examples: [''],
            },
            baseToken: { type: 'string', examples: ['WETH'] },
            quoteToken: { type: 'string', examples: ['USDC'] },
            baseTokenAmount: { type: 'number', examples: [0.001] },
            quoteTokenAmount: { type: 'number', examples: [2.5] },
            slippagePct: { type: 'number', examples: [1] },
          },
        },
        response: {
          200: AddLiquidityResponse,
        },
      },
    },
    async (request) => {
      try {
        const {
          network,
          poolAddress: requestedPoolAddress,
          baseToken,
          quoteToken,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
          walletAddress: requestedWalletAddress,
        } = request.body;

        // Validate essential parameters
        if (
          !baseToken ||
          !quoteToken ||
          !baseTokenAmount ||
          !quoteTokenAmount
        ) {
          throw fastify.httpErrors.badRequest('Missing required parameters');
        }

        const networkToUse = network || 'base';

        // Get wallet address - either from request or first available
        let walletAddress = requestedWalletAddress;
        if (!walletAddress) {
          walletAddress = await Ethereum.getFirstWalletAddress();
          if (!walletAddress) {
            throw fastify.httpErrors.badRequest(
              'No wallet address provided and no wallets found.',
            );
          }
          logger.info(`Using first available wallet address: ${walletAddress}`);
        }

        // Find pool address if not provided
        const uniswap = await Uniswap.getInstance(networkToUse);
        let poolAddress = requestedPoolAddress;
        if (!poolAddress) {
          poolAddress = await uniswap.findDefaultPool(
            baseToken,
            quoteToken,
            'amm',
          );

          if (!poolAddress) {
            throw fastify.httpErrors.notFound(
              `No AMM pool found for pair ${baseToken}-${quoteToken}`,
            );
          }
        }

        return await addLiquidity(
          fastify,
          networkToUse,
          walletAddress,
          poolAddress,
          baseToken,
          quoteToken,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        );
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }

        // Handle specific user-actionable errors
        if (e.message && e.message.includes('Insufficient allowance')) {
          throw fastify.httpErrors.badRequest(e.message);
        }

        // Handle insufficient funds errors
        if (
          e.code === 'INSUFFICIENT_FUNDS' ||
          (e.message && e.message.includes('insufficient funds'))
        ) {
          throw fastify.httpErrors.badRequest(
            'Insufficient ETH balance to pay for gas fees. Please add more ETH to your wallet.',
          );
        }

        throw fastify.httpErrors.internalServerError('Failed to add liquidity');
      }
    },
  );
};

export default addLiquidityRoute;
