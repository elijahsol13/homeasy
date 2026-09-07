import { createCallbacksHandler } from '../src/modules/bot/handlers/callbacks.handler';
import type { MyContext } from '../src/modules/bot/session';
import type { AppContainer } from '../src/container';

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
});
