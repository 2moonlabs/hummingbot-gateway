import { FastifyPluginAsync } from 'fastify';

import { logger } from '../../services/logger';
import {
  DefaultPoolRequest,
  DefaultPoolResponse,
  DefaultPoolRequestSchema,
  DefaultPoolResponseSchema,
} from '../schemas';
import { addDefaultPool } from '../utils';

export const addPoolRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: DefaultPoolRequest; Reply: DefaultPoolResponse }>(
    '/pools/add',
    {
      schema: {
        description: 'Add a default pool for a specific connector',
        tags: ['system'],
        body: DefaultPoolRequestSchema,
        response: {
          200: DefaultPoolResponseSchema,
        },
      },
    },
    async (request) => {
      const { connector, baseToken, quoteToken, poolAddress } = request.body;
      addDefaultPool(fastify, connector, baseToken, quoteToken, poolAddress);
      return { message: `Default pool added for ${baseToken}-${quoteToken}` };
    },
  );
};

export default addPoolRoute;
