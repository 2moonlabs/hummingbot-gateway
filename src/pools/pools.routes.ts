import sensible from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';

import { addPoolRoute } from './routes/addPool';
import { getPoolRoute } from './routes/getPool';
import { listPoolsRoute } from './routes/listPools';
import { removePoolRoute } from './routes/removePool';

export const poolRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);
  
  // Register pool routes
  await fastify.register(listPoolsRoute);
  await fastify.register(getPoolRoute);
  await fastify.register(addPoolRoute);
  await fastify.register(removePoolRoute);
};