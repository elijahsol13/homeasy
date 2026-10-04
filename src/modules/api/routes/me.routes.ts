import type { FastifyPluginAsync } from 'fastify';
import type { AppContainer } from '../../../container';
import { isAdminTelegramUser, optionalTelegramAuth } from '../auth';

export const meRoutes: FastifyPluginAsync<{ container: AppContainer }> = async (fastify, opts) => {
  const { container } = opts;

  /**
   * GET /api/v1/me
   * Returns the authenticated Telegram user (if any) and their capabilities.
   * Admin flag is derived server-side from validated initData only.
   */
  fastify.get('/api/v1/me', { preHandler: optionalTelegramAuth }, async (request) => {
    const tgUser = request.telegramUser;
    const isAdmin = isAdminTelegramUser(tgUser?.id);

    let role: string | undefined;
    if (tgUser) {
      role = container.usersRepo.findByTelegramId(tgUser.id)?.role;
    }

    return {
      authenticated: Boolean(tgUser),
      user: tgUser
        ? {
            id: tgUser.id,
            firstName: tgUser.first_name,
            lastName: tgUser.last_name,
            username: tgUser.username,
          }
        : null,
      role: role ?? null,
      isAdmin: isAdmin || role === 'admin',
    };
  });
};
