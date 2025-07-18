import { Type } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { logger } from '../../services/logger';
import {
  DefaultPoolRequest,
  DefaultPoolResponse,
  DefaultPoolResponseSchema,
} from '../schemas';
import { removeDefaultPool } from '../utils';

export const removePoolRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Omit<DefaultPoolRequest, 'poolAddress'>;
    Reply: DefaultPoolResponse;
  }>(
    '/pools/remove',
    {
      schema: {
        description: 'Remove a default pool for a specific connector',
        tags: ['system'],
        body: Type.Object({
          connector: Type.String({
            description: 'Connector name (e.g., raydium/amm, raydium/clmm)',
            examples: ['raydium/amm', 'raydium/clmm'],
          }),
          baseToken: Type.String({
            description: 'Base token symbol',
            examples: ['SOL', 'USDC'],
          }),
          quoteToken: Type.String({
            description: 'Quote token symbol',
            examples: ['USDC', 'USDT'],
          }),
        }),
        response: {
          200: DefaultPoolResponseSchema,
        },
      },
    },
    async (request) => {
      const { connector, baseToken, quoteToken } = request.body;
      removeDefaultPool(fastify, connector, baseToken, quoteToken);
      return { message: `Default pool removed for ${baseToken}-${quoteToken}` };
    },
  );
};

export default removePoolRoute;
