import { createCallbacksHandler } from '../src/modules/bot/handlers/callbacks.handler';
import type { MyContext } from '../src/modules/bot/session';
import type { AppContainer } from '../src/container';
import { env } from '../src/config/env';

describe('createCallbacksHandler Middleware Routing', () => {
  it('calls next() when a callback query is not handled by callbacks router', async () => {
    const mockContainer = {} as AppContainer;
    const composer = createCallbacksHandler(mockContainer);

    const nextMock = jest.fn().mockResolvedValue(undefined);
    const mockCtx = {
      update: {
        callback_query: {
          data: 'cb:ai:show',
        },
      },
      callbackQuery: {
        data: 'cb:ai:show',
      },
      answerCallbackQuery: jest.fn().mockResolvedValue(true),
    } as unknown as MyContext;

    // Run middleware
    await composer.middleware()(mockCtx, nextMock);

    expect(nextMock).toHaveBeenCalledTimes(1);
  });

  it('handles known callback and does not call next()', async () => {
    const editMessageTextMock = jest.fn().mockResolvedValue(true);
    const answerCallbackQueryMock = jest.fn().mockResolvedValue(true);
    const mockContainer = {
      usersRepo: {
        upsertUser: jest.fn().mockReturnValue({ id: 1, role: 'user', alerts_paused: 0 }),
      },
    } as unknown as AppContainer;

    const composer = createCallbacksHandler(mockContainer);

    const nextMock = jest.fn().mockResolvedValue(undefined);
    const mockCtx = {
      update: {
        callback_query: {
          data: 'cb:menu:main',
        },
      },
      container: mockContainer,
      from: { id: 12345, username: 'test_user' },
      callbackQuery: {
        data: 'cb:menu:main',
      },
      editMessageText: editMessageTextMock,
      answerCallbackQuery: answerCallbackQueryMock,
    } as unknown as MyContext;

    await composer.middleware()(mockCtx, nextMock);

    expect(editMessageTextMock).toHaveBeenCalled();
    expect(nextMock).not.toHaveBeenCalled();
  });

  it.each(['cb:prop:save:123', 'cb:prop:report:123', 'cb:fav:remove:123', 'cb:fav:page:1'])
  ('blocks old legacy callbacks for canonical canary without touching rollback data: %s', async (data) => {
    const previousPath = env.LISTING_READ_PATH;
    const previousCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
    const propertiesRepo = { getPropertyById: jest.fn(), reportProperty: jest.fn() };
    const favoritesRepo = { removeFavorite: jest.fn(), addFavorite: jest.fn(), getUserFavorites: jest.fn() };
    const usersRepo = { findByTelegramId: jest.fn() };
    const container = { propertiesRepo, favoritesRepo, usersRepo } as unknown as AppContainer;
    const answer = jest.fn().mockResolvedValue(true);
    const next = jest.fn();
    try {
      env.LISTING_READ_PATH = 'legacy';
      env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [12345];
      await createCallbacksHandler(container).middleware()({
        update: { callback_query: { data } }, callbackQuery: { data },
        from: { id: 12345 }, container, answerCallbackQuery: answer,
      } as unknown as MyContext, next);
      expect(next).not.toHaveBeenCalled();
      expect(answer).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Old button') }));
      expect(propertiesRepo.reportProperty).not.toHaveBeenCalled();
      expect(favoritesRepo.removeFavorite).not.toHaveBeenCalled();
      expect(favoritesRepo.addFavorite).not.toHaveBeenCalled();
      expect(usersRepo.findByTelegramId).not.toHaveBeenCalled();
    } finally {
      env.LISTING_READ_PATH = previousPath;
      env.CANONICAL_READ_CANARY_TELEGRAM_IDS = previousCanaries;
    }
  });

  it('keeps old save buttons available for users outside the canary', async () => {
    const previousPath = env.LISTING_READ_PATH;
    const previousCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
    const usersRepo = { findByTelegramId: jest.fn().mockReturnValue(undefined) };
    const container = { usersRepo } as unknown as AppContainer;
    const data = 'cb:prop:save:123';
    try {
      env.LISTING_READ_PATH = 'legacy';
      env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [12345];
      await createCallbacksHandler(container).middleware()({
        update: { callback_query: { data } }, callbackQuery: { data },
        from: { id: 23456 }, container, answerCallbackQuery: jest.fn().mockResolvedValue(true),
      } as unknown as MyContext, jest.fn());
      expect(usersRepo.findByTelegramId).toHaveBeenCalledWith(23456);
    } finally {
      env.LISTING_READ_PATH = previousPath;
      env.CANONICAL_READ_CANARY_TELEGRAM_IDS = previousCanaries;
    }
  });

  describe('canonical complaints', () => {
    const ref = `lst_${'a'.repeat(32)}`;
    const run = async (data: string, container: AppContainer, telegramId = 12345) => {
      const answer = jest.fn().mockResolvedValue(undefined);
      const ctx = {
        update: { callback_query: { data } }, callbackQuery: { data },
        from: { id: telegramId }, container, answerCallbackQuery: answer,
      } as unknown as MyContext;
      await createCallbacksHandler(container).middleware()(ctx, jest.fn());
      return answer;
    };

    it('reports only a visible canonical listing and warns moderators once', async () => {
      const beforePath = env.LISTING_READ_PATH;
      const beforeCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
      const usersRepo = { findByTelegramId: jest.fn().mockReturnValue({ id: 7 }) };
      const listingIdentityRepo = { resolvePublicRef: jest.fn().mockReturnValue({ listingId: 21, publicRef: ref }) };
      const canonicalListingRepo = { getPropertyById: jest.fn().mockReturnValue({ id: 21 }) };
      const canonicalReportsRepo = { report: jest.fn().mockReturnValueOnce({ added: true, total: 1 })
        .mockReturnValueOnce({ added: false, total: 1 }) };
      const analyticsRepo = { trackEvent: jest.fn() };
      const alertService = { warn: jest.fn().mockResolvedValue(undefined) };
      const propertiesRepo = { reportProperty: jest.fn() };
      const container = { usersRepo, listingIdentityRepo, canonicalListingRepo,
        canonicalReportsRepo, analyticsRepo, alertService, propertiesRepo } as unknown as AppContainer;
      try {
        env.LISTING_READ_PATH = 'legacy';
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [12345];
        const success = await run(`cb:cl:report:${ref}`, container);
        const repeated = await run(`cb:cl:report:${ref}`, container);
        expect(success).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Thank you') }));
        expect(repeated).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('already reported') }));
        expect(canonicalReportsRepo.report).toHaveBeenNthCalledWith(1, 21, 7);
        expect(canonicalReportsRepo.report).toHaveBeenCalledTimes(2);
        expect(alertService.warn).toHaveBeenCalledTimes(1);
        expect(analyticsRepo.trackEvent).toHaveBeenCalledTimes(1);
        expect(propertiesRepo.reportProperty).not.toHaveBeenCalled();
      } finally {
        env.LISTING_READ_PATH = beforePath;
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = beforeCanaries;
      }
    });

    it('refuses malformed, missing and pending canonical listings', async () => {
      const beforePath = env.LISTING_READ_PATH;
      const beforeCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
      const usersRepo = { findByTelegramId: jest.fn().mockReturnValue({ id: 7 }) };
      const listingIdentityRepo = { resolvePublicRef: jest.fn().mockReturnValueOnce(undefined)
        .mockReturnValueOnce({ listingId: 21, publicRef: ref }) };
      const canonicalListingRepo = { getPropertyById: jest.fn().mockReturnValue(undefined) };
      const canonicalReportsRepo = { report: jest.fn() };
      const container = { usersRepo, listingIdentityRepo, canonicalListingRepo, canonicalReportsRepo } as unknown as AppContainer;
      try {
        env.LISTING_READ_PATH = 'legacy';
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [12345];
        const invalid = await run('cb:cl:report:123', container);
        const missing = await run(`cb:cl:report:${ref}`, container);
        const pending = await run(`cb:cl:report:${ref}`, container);
        expect(invalid).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Invalid listing') }));
        expect(missing).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('no longer available') }));
        expect(pending).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('no longer available') }));
        expect(canonicalReportsRepo.report).not.toHaveBeenCalled();
      } finally {
        env.LISTING_READ_PATH = beforePath;
        env.CANONICAL_READ_CANARY_TELEGRAM_IDS = beforeCanaries;
      }
    });
  });
});
