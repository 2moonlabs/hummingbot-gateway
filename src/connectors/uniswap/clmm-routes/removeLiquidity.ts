import { Contract } from '@ethersproject/contracts';
import { Percent, CurrencyAmount } from '@uniswap/sdk-core';
import { NonfungiblePositionManager, Position } from '@uniswap/v3-sdk';
import { BigNumber } from 'ethers';
import { FastifyPluginAsync } from 'fastify';
import JSBI from 'jsbi';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import {
  RemoveLiquidityRequestType,
  RemoveLiquidityRequest,
  RemoveLiquidityResponseType,
  RemoveLiquidityResponse,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { Uniswap } from '../uniswap';
import { POSITION_MANAGER_ABI } from '../uniswap.contracts';
import { formatTokenAmount } from '../uniswap.utils';

export const removeLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(require('@fastify/sensible'));

  const walletAddressExample = await Ethereum.getWalletAddressExample();

  fastify.post<{
    Body: RemoveLiquidityRequestType;
    Reply: RemoveLiquidityResponseType;
  }>(
    '/remove-liquidity',
    {
      schema: {
        description: 'Remove liquidity from a Uniswap V3 position',
        tags: ['uniswap/clmm'],
        body: {
          ...RemoveLiquidityRequest,
          properties: {
            ...RemoveLiquidityRequest.properties,
            network: { type: 'string', default: 'base' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            positionAddress: {
              type: 'string',
              description: 'Position NFT token ID',
              examples: ['1234'],
            },
            percentageToRemove: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              examples: [50],
            },
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
          walletAddress: requestedWalletAddress,
          positionAddress,
          percentageToRemove,
        } = request.body;

        const networkToUse = network || 'base';
        const chain = 'ethereum'; // Default to ethereum

        // Validate essential parameters
        if (!positionAddress || percentageToRemove === undefined) {
          throw fastify.httpErrors.badRequest('Missing required parameters');
        }

        if (percentageToRemove < 0 || percentageToRemove > 100) {
          throw fastify.httpErrors.badRequest(
            'Percentage to remove must be between 0 and 100',
          );
        }

        // Get Uniswap and Ethereum instances
        const uniswap = await Uniswap.getInstance(networkToUse);
        const ethereum = await Ethereum.getInstance(networkToUse);

        // Get wallet address - either from request or first available
        let walletAddress = requestedWalletAddress;
        if (!walletAddress) {
          walletAddress = await uniswap.getFirstWalletAddress();
          if (!walletAddress) {
            throw fastify.httpErrors.badRequest(
              'No wallet address provided and no default wallet found',
            );
          }
          logger.info(`Using first available wallet address: ${walletAddress}`);
        }

        // Get the wallet
        const wallet = await ethereum.getWallet(walletAddress);
        if (!wallet) {
          throw fastify.httpErrors.badRequest('Wallet not found');
        }

        // Get position manager address
        const positionManagerAddress =
          uniswap.config.uniswapV3NftManagerAddress(networkToUse);

        // Check NFT ownership
        try {
          await uniswap.checkNFTOwnership(positionAddress, walletAddress);
        } catch (error: any) {
          if (error.message.includes('is not owned by')) {
            throw fastify.httpErrors.forbidden(error.message);
          }
          throw fastify.httpErrors.badRequest(error.message);
        }

        // Create position manager contract
        const positionManager = new Contract(
          positionManagerAddress,
          POSITION_MANAGER_ABI,
          ethereum.provider,
        );

        // Get position details
        const position = await positionManager.positions(positionAddress);

        // Get tokens by address
        const token0 = uniswap.getTokenByAddress(position.token0);
        const token1 = uniswap.getTokenByAddress(position.token1);

        // Determine base and quote tokens - WETH or lower address is base
        const isBaseToken0 =
          token0.symbol === 'WETH' ||
          (token1.symbol !== 'WETH' &&
            token0.address.toLowerCase() < token1.address.toLowerCase());

        // Get current liquidity
        const currentLiquidity = position.liquidity;

        // Calculate liquidity to remove based on percentage
        const liquidityToRemove = currentLiquidity
          .mul(Math.floor(percentageToRemove * 100))
          .div(10000);

        // Get the pool
        const pool = await uniswap.getV3Pool(token0, token1, position.fee);
        if (!pool) {
          throw fastify.httpErrors.notFound('Pool not found for position');
        }

        // Create a Position instance to calculate expected amounts
        const positionSDK = new Position({
          pool,
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          liquidity: currentLiquidity.toString(),
        });

        // Calculate the amounts that will be withdrawn
        const liquidityPercentage = new Percent(
          Math.floor(percentageToRemove * 100),
          10000,
        );
        const partialPosition = new Position({
          pool,
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          liquidity: JSBI.divide(
            JSBI.multiply(
              JSBI.BigInt(currentLiquidity.toString()),
              JSBI.BigInt(liquidityPercentage.numerator.toString()),
            ),
            JSBI.BigInt(liquidityPercentage.denominator.toString()),
          ),
        });

        // Get the expected amounts
        const amount0 = partialPosition.amount0;
        const amount1 = partialPosition.amount1;

        // Apply slippage tolerance
        const slippageTolerance = new Percent(100, 10000); // 1% slippage
        const amount0Min = amount0.multiply(
          new Percent(1).subtract(slippageTolerance),
        ).quotient;
        const amount1Min = amount1.multiply(
          new Percent(1).subtract(slippageTolerance),
        ).quotient;

        // Also add any fees that have been collected to the expected amounts
        const totalAmount0 = CurrencyAmount.fromRawAmount(
          token0,
          JSBI.add(
            amount0.quotient,
            JSBI.BigInt(position.tokensOwed0.toString()),
          ),
        );
        const totalAmount1 = CurrencyAmount.fromRawAmount(
          token1,
          JSBI.add(
            amount1.quotient,
            JSBI.BigInt(position.tokensOwed1.toString()),
          ),
        );

        // Create parameters for removing liquidity
        const removeParams = {
          tokenId: positionAddress,
          liquidityPercentage,
          slippageTolerance,
          deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes from now
          burnToken: false,
          collectOptions: {
            expectedCurrencyOwed0: totalAmount0,
            expectedCurrencyOwed1: totalAmount1,
            recipient: walletAddress,
          },
        };

        // Get the calldata using the SDK
        const { calldata, value } =
          NonfungiblePositionManager.removeCallParameters(
            positionSDK,
            removeParams,
          );

        // Execute the transaction to remove liquidity
        const tx = await wallet.sendTransaction({
          to: positionManagerAddress,
          data: calldata,
          value: BigNumber.from(value),
          gasLimit: 500000,
        });

        // Wait for transaction confirmation
        const receipt = await tx.wait();

        // Calculate gas fee
        const gasFee = formatTokenAmount(
          receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(),
          18, // ETH has 18 decimals
        );

        // Calculate token amounts removed including fees
        const token0AmountRemoved = formatTokenAmount(
          totalAmount0.quotient.toString(),
          token0.decimals,
        );
        const token1AmountRemoved = formatTokenAmount(
          totalAmount1.quotient.toString(),
          token1.decimals,
        );

        // Map back to base and quote amounts
        const baseTokenAmountRemoved = isBaseToken0
          ? token0AmountRemoved
          : token1AmountRemoved;
        const quoteTokenAmountRemoved = isBaseToken0
          ? token1AmountRemoved
          : token0AmountRemoved;

        return {
          signature: receipt.transactionHash,
          fee: gasFee,
          baseTokenAmountRemoved,
          quoteTokenAmountRemoved,
        };
      } catch (e) {
        logger.error(e);
        if (e.statusCode) {
          throw e;
        }
        throw fastify.httpErrors.internalServerError(
          'Failed to remove liquidity',
        );
      }
    },
  );
};

export default removeLiquidityRoute;
