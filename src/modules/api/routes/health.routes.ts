import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';

export const healthRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (fastify, opts) => {
  const { container } = opts;

  fastify.get('/health', async () => {
    const propertiesCount = container.propertiesRepo.getPropertyCount();
    const usersCount = container.usersRepo.getUserCount();

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      stats: {
        properties: propertiesCount,
        users: usersCount,
      },
    };
  });
};
