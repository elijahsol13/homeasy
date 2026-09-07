import { Composer, InputFile } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { env } from '../../../config/env';
import { authInChatKeyboard, adminBackKeyboard } from '../keyboards/admin.keyboard';

export function createTelegramAuthHandler(container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  function isAdmin(ctx: MyContext): boolean {
    const from = ctx.from;
    if (!from) return false;
    if (env.ADMIN_IDS && env.ADMIN_IDS.includes(from.id)) return true;
    const user = container.usersRepo.findByTelegramId(from.id);
    return user?.role === 'admin';
  }

  // ─── Start In-Chat Authentication ──────────────────────────────────────────

  async function startInChatAuth(ctx: MyContext) {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const adminId = ctx.from!.id;
    const statusMsg = await ctx.reply(
      '⏳ <b>Launching secure browser session via residential proxy...</b>\n\n' +
        'Please wait 10-15 seconds for initial page rendering.',
      { parse_mode: 'HTML' },
    );

    try {
      const result = await container.telegramAuthService.startSession(adminId);

      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

      const caption =
        '🔐 <b>Facebook Authorization (Residential Proxy)</b>\n\n' +
        `• <b>Status:</b> ${result.message}\n` +
        '• <b>Steps:</b>\n' +
        '  1. Tap <b>[👤 Ввести логин]</b> and send your email/phone.\n' +
        '  2. Tap <b>[🔑 Ввести пароль]</b> and send your password.\n' +
        '  3. Tap <b>[🚀 Войти]</b> to authenticate.\n' +
        '  4. If prompted for 2FA, tap <b>[📲 Ввести 2FA]</b>.\n\n' +
        '<i>🛡️ All password messages are deleted immediately after entry.</i>';

      await ctx.replyWithPhoto(new InputFile(result.screenshot, 'fb_login.jpg'), {
        caption,
        parse_mode: 'HTML',
        reply_markup: authInChatKeyboard({ is2FA: result.is2FA }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ <b>Failed to launch authorization session:</b>\n<code>${msg}</code>`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
      ).catch(async () => {
        await ctx.reply(`❌ <b>Failed to launch authorization session:</b>\n<code>${msg}</code>`, {
          parse_mode: 'HTML',
          reply_markup: adminBackKeyboard(),
        });
      });
    }
  }

  handler.command('auth_fb_chat', async (ctx) => {
    await startInChatAuth(ctx);
  });

  handler.callbackQuery(['admin:auth:fb_chat', 'cb:admin:auth:fb_chat'], async (ctx) => {
    await ctx.answerCallbackQuery();
    await startInChatAuth(ctx);
  });

  // ─── Input Requests (Login, Password, 2FA) ──────────────────────────────────

  handler.callbackQuery('cb:auth:fb:login', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
    await ctx.answerCallbackQuery();
    const adminId = ctx.from.id;

    if (!container.telegramAuthService.hasSession(adminId)) {
      await ctx.reply('⚠️ No active session. Start a new one with /auth_fb_chat.');
      return;
    }

    container.telegramAuthService.setWaitingForInput(adminId, 'login');
    await ctx.reply('👤 <b>Введите ваш логин / email от Facebook в ответном сообщении:</b>', {
      parse_mode: 'HTML',
    });
  });

  handler.callbackQuery('cb:auth:fb:pass', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
    await ctx.answerCallbackQuery();
    const adminId = ctx.from.id;

    if (!container.telegramAuthService.hasSession(adminId)) {
      await ctx.reply('⚠️ No active session. Start a new one with /auth_fb_chat.');
      return;
    }

    container.telegramAuthService.setWaitingForInput(adminId, 'password');
    await ctx.reply(
      '🔑 <b>Введите ваш пароль от Facebook:</b>\n\n' +
        '<i>🛡️ Ваше сообщение с паролем будет автоматически удалено сразу после ввода.</i>',
      { parse_mode: 'HTML' },
    );
  });

  handler.callbackQuery('cb:auth:fb:2fa', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
    await ctx.answerCallbackQuery();
    const adminId = ctx.from.id;

    if (!container.telegramAuthService.hasSession(adminId)) {
      await ctx.reply('⚠️ No active session. Start a new one with /auth_fb_chat.');
      return;
    }

    container.telegramAuthService.setWaitingForInput(adminId, '2fa');
    await ctx.reply('📲 <b>Отправьте 6-значный код подтверждения (2FA / SMS / Authenticator):</b>', {
      parse_mode: 'HTML',
    });
  });

  // ─── Submit Form ────────────────────────────────────────────────────────────

  handler.callbackQuery('cb:auth:fb:submit', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
    await ctx.answerCallbackQuery({ text: '⏳ Submitting...' });
    const adminId = ctx.from.id;

    if (!container.telegramAuthService.hasSession(adminId)) {
      await ctx.reply('⚠️ No active session. Start a new one with /auth_fb_chat.');
      return;
    }

    const waitMsg = await ctx.reply('⏳ <i>Submitting login form and awaiting response...</i>', {
      parse_mode: 'HTML',
    });

    try {
      const result = await container.telegramAuthService.submitForm(adminId);
      await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => {});

      if (result.isLoggedIn) {
        await ctx.replyWithPhoto(new InputFile(result.screenshot, 'fb_success.jpg'), {
          caption:
            `🎉 <b>Facebook Login Successful!</b>\n\n` +
            `• <b>User ID:</b> <code>${result.c_user || 'Authenticated'}</code>\n` +
            `• Session cookies saved to <code>data/fb_session.json</code>.\n` +
            `• Scraper will use this residential session automatically.`,
          parse_mode: 'HTML',
          reply_markup: adminBackKeyboard(),
        });
        await container.telegramAuthService.closeSession(adminId);
        return;
      }

      const caption =
        `🔍 <b>Current Browser State</b>\n\n` +
        `• <b>Status:</b> ${result.message}\n` +
        (result.is2FA
          ? `\n👉 <b>Please tap [📲 Ввести 2FA] to enter your confirmation code.</b>`
          : `\n👉 If credentials failed, tap [👤 Ввести логин] or [🔑 Ввести пароль] again.`);

      await ctx.replyWithPhoto(new InputFile(result.screenshot, 'fb_submit.jpg'), {
        caption,
        parse_mode: 'HTML',
        reply_markup: authInChatKeyboard({ is2FA: result.is2FA }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => {});
      await ctx.reply(`❌ <b>Submission error:</b>\n<code>${msg}</code>`, {
        parse_mode: 'HTML',
        reply_markup: authInChatKeyboard(),
      });
    }
  });

  // ─── Refresh Screenshot ─────────────────────────────────────────────────────

  handler.callbackQuery('cb:auth:fb:refresh', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
    await ctx.answerCallbackQuery({ text: '📸 Refreshing screenshot...' });
    const adminId = ctx.from.id;

    if (!container.telegramAuthService.hasSession(adminId)) {
      await ctx.reply('⚠️ No active session. Start a new one with /auth_fb_chat.');
      return;
    }

    try {
      const screen = await container.telegramAuthService.refreshScreenshot(adminId);
      await ctx.replyWithPhoto(new InputFile(screen, 'fb_screen.jpg'), {
        caption: '🔄 <b>Updated Browser Screenshot</b>',
        parse_mode: 'HTML',
        reply_markup: authInChatKeyboard(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`⚠️ Failed to capture screenshot: ${msg}`);
    }
  });

  // ─── Save Session Manually ──────────────────────────────────────────────────

  handler.callbackQuery('cb:auth:fb:save', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
    const adminId = ctx.from.id;

    if (!container.telegramAuthService.hasSession(adminId)) {
      await ctx.answerCallbackQuery({ text: '⚠️ No active session.' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '💾 Checking session...' });
    const res = await container.telegramAuthService.saveSessionManually(adminId);

    if (res.c_user) {
      await ctx.reply(
        `🎉 <b>Session Saved Successfully!</b>\n\n` +
          `• <b>c_user:</b> <code>${res.c_user}</code>\n` +
          `• Stored at: <code>data/fb_session.json</code>`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
      );
      await container.telegramAuthService.closeSession(adminId);
    } else {
      await ctx.reply(
        `⚠️ <b>Warning: c_user cookie not found yet.</b>\n` +
          `Complete login or 2FA first, then tap Save again.`,
        { parse_mode: 'HTML', reply_markup: authInChatKeyboard() },
      );
    }
  });

  // ─── Cancel Session ─────────────────────────────────────────────────────────

  handler.callbackQuery('cb:auth:fb:cancel', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
    await ctx.answerCallbackQuery({ text: 'Closing session...' });
    const adminId = ctx.from.id;
    await container.telegramAuthService.closeSession(adminId);
    await ctx.reply('🛑 <b>Session closed.</b> You can return to admin menu.', {
      parse_mode: 'HTML',
      reply_markup: adminBackKeyboard(),
    });
  });

  // ─── Direct Session File / JSON Import ──────────────────────────────────────

  handler.callbackQuery(['admin:auth:fb_import', 'cb:admin:auth:fb_import'], async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
    await ctx.answerCallbackQuery();

    await ctx.reply(
      '📥 <b>Import Facebook Session State</b>\n\n' +
        'You can import a pre-authenticated session in two ways:\n\n' +
        '1️⃣ <b>Send File:</b> Send your <code>fb_session.json</code> file as a document to this chat.\n\n' +
        '2️⃣ <b>Command:</b> Run <code>/import_fb_session {json_content}</code>\n\n' +
        '<i>The JSON must contain <code>c_user</code> and <code>xs</code> cookies.</i>',
      { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
    );
  });

  handler.command('import_fb_session', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const payload = ctx.message?.text?.replace(/^\/import_fb_session\s*/i, '').trim();
    if (!payload) {
      await ctx.reply(
        'Usage: <code>/import_fb_session &lt;json_content&gt;</code> or simply send <code>fb_session.json</code> as a file attachment.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const result = container.telegramAuthService.importSessionJson(payload);
    if (result.success) {
      await ctx.reply(
        `🎉 <b>Session Import Successful!</b>\n\n` +
          `• <b>User ID:</b> <code>${result.c_user}</code>\n` +
          `• Saved to <code>data/fb_session.json</code>.\n` +
          `• Scraper will use this session automatically.`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
      );
    } else {
      await ctx.reply(`❌ <b>Import Failed:</b> ${result.message}`, {
        parse_mode: 'HTML',
        reply_markup: adminBackKeyboard(),
      });
    }
  });

  // ─── Incoming Message Router for Awaiting Inputs ────────────────────────────

  handler.on('message:text', async (ctx, next) => {
    const adminId = ctx.from?.id;
    if (!adminId || !isAdmin(ctx)) return next();

    const waiting = container.telegramAuthService.getWaitingForInput(adminId);
    if (!waiting) return next();

    const text = ctx.message.text.trim();

    if (waiting === 'login') {
      const waitMsg = await ctx.reply('⏳ <i>Entering login into browser...</i>', { parse_mode: 'HTML' });
      try {
        const screen = await container.telegramAuthService.enterLogin(adminId, text);
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
        await ctx.replyWithPhoto(new InputFile(screen, 'fb_login.jpg'), {
          caption: '✅ <b>Login entered!</b> Now tap <b>[🔑 Ввести пароль]</b> or <b>[🚀 Войти]</b>.',
          parse_mode: 'HTML',
          reply_markup: authInChatKeyboard(),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`⚠️ Failed to enter login: ${msg}`, { reply_markup: authInChatKeyboard() });
      }
      return;
    }

    if (waiting === 'password') {
      // 🛡️ Security: Immediately delete the password message from Telegram chat history
      await ctx.deleteMessage().catch(() => {});

      const waitMsg = await ctx.reply(
        '⏳ <i>Entering password into browser (message securely deleted)...</i>',
        { parse_mode: 'HTML' },
      );

      try {
        const screen = await container.telegramAuthService.enterPassword(adminId, text);
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
        await ctx.replyWithPhoto(new InputFile(screen, 'fb_pass.jpg'), {
          caption: '✅ <b>Password entered!</b> Tap <b>[🚀 Войти (Submit)]</b> to authenticate.',
          parse_mode: 'HTML',
          reply_markup: authInChatKeyboard(),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`⚠️ Failed to enter password: ${msg}`, { reply_markup: authInChatKeyboard() });
      }
      return;
    }

    if (waiting === '2fa') {
      const waitMsg = await ctx.reply('⏳ <i>Submitting 2FA code...</i>', { parse_mode: 'HTML' });
      try {
        const result = await container.telegramAuthService.enter2FACode(adminId, text);
        await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});

        if (result.isLoggedIn) {
          await ctx.replyWithPhoto(new InputFile(result.screenshot, 'fb_success.jpg'), {
            caption:
              `🎉 <b>2FA Verified & Login Successful!</b>\n\n` +
              `• <b>User ID:</b> <code>${result.c_user || 'Authenticated'}</code>\n` +
              `• Session saved to <code>data/fb_session.json</code>.`,
            parse_mode: 'HTML',
            reply_markup: adminBackKeyboard(),
          });
          await container.telegramAuthService.closeSession(adminId);
          return;
        }

        await ctx.replyWithPhoto(new InputFile(result.screenshot, 'fb_2fa.jpg'), {
          caption: `🔍 <b>2FA Result:</b> ${result.message}`,
          parse_mode: 'HTML',
          reply_markup: authInChatKeyboard({ is2FA: true }),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`⚠️ Failed to enter 2FA code: ${msg}`, { reply_markup: authInChatKeyboard() });
      }
      return;
    }

    await next();
  });

  // ─── Document Upload Listener for fb_session.json ───────────────────────────

  handler.on('message:document', async (ctx, next) => {
    if (!isAdmin(ctx)) return next();

    const doc = ctx.message.document;
    const fileName = doc.file_name?.toLowerCase() || '';

    if (!fileName.endsWith('.json')) return next();

    try {
      const file = await ctx.getFile();
      if (!file.file_path) {
        await ctx.reply('❌ Unable to download file from Telegram.');
        return;
      }

      const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
      const res = await fetch(fileUrl);
      const text = await res.text();

      const result = container.telegramAuthService.importSessionJson(text);
      if (result.success) {
        await ctx.reply(
          `🎉 <b>Session File Imported Successfully!</b>\n\n` +
            `• <b>User ID:</b> <code>${result.c_user}</code>\n` +
            `• Saved to <code>data/fb_session.json</code>.\n` +
            `• Scraper will use this session automatically.`,
          { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
        );
      } else {
        await ctx.reply(`❌ <b>Import Failed:</b> ${result.message}`, {
          parse_mode: 'HTML',
          reply_markup: adminBackKeyboard(),
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Error processing document: ${msg}`);
    }
  });

  return handler;
}
