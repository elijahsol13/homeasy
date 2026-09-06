import { Composer, InlineKeyboard } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { createDatabaseBackup } from '../../../database/backup';
import { runEnrichment } from '../../../database/enrich-properties';
import { env } from '../../../config/env';

export function createAdminHandler(container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  // ─── Guard ────────────────────────────────────────────────────────────────────

  function isAdmin(ctx: MyContext): boolean {
    const from = ctx.from;
    if (!from) return false;
    const user = container.usersRepo.findByTelegramId(from.id);
    return user?.role === 'admin';
  }

  // ─── /ingest_json ─────────────────────────────────────────────────────────────

  handler.command('ingest_json', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const msg = ctx.message;
    if (!msg) return;

    // Accept JSON inline or as a reply to a message containing JSON
    let jsonText: string | undefined;

    if (msg.reply_to_message?.text) {
      jsonText = msg.reply_to_message.text;
    } else {
      const inlineText = msg.text?.replace(/^\/ingest_json\s*/i, '').trim();
      jsonText = inlineText && inlineText.length > 0 ? inlineText : undefined;
    }

    if (!jsonText) {
      await ctx.reply(
        '📤 <b>Ingest JSON — Usage</b>\n\n' +
          '<b>Single listing (inline):</b>\n' +
          '<code>/ingest_json {"title":"2BR in BKK1","price":800,"type":"rent","location":"BKK1","city":"phnom_penh"}</code>\n\n' +
          '<b>Bulk (reply to message with JSON array):</b>\n' +
          'Send a message containing a JSON array, then reply to it with <code>/ingest_json</code>.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      await ctx.reply('❌ <b>Invalid JSON</b> — please check your payload and try again.', {
        parse_mode: 'HTML',
      });
      return;
    }

    const processingMsg = await ctx.reply('⏳ Processing...');

    try {
      if (Array.isArray(parsed)) {
        const result = await container.ingestionService.bulkIngest(parsed);
        await ctx.api.editMessageText(
          processingMsg.chat.id,
          processingMsg.message_id,
          `✅ <b>Bulk Ingest Complete</b>\n\n` +
            `📊 Total:      <b>${result.total}</b>\n` +
            `✅ Inserted:   <b>${result.inserted}</b>\n` +
            `🔁 Duplicates: <b>${result.duplicates}</b>\n` +
            `❌ Errors:     <b>${result.errors}</b>`,
          { parse_mode: 'HTML' },
        );
      } else {
        const result = await container.ingestionService.ingestRawListing(parsed);

        let reply: string;
        if (result.status === 'inserted') {
          reply = `✅ Listing inserted (ID: <b>${result.propertyId}</b>)\nHash: <code>${result.hash?.slice(0, 16)}…</code>`;
        } else if (result.status === 'duplicate') {
          reply = `🔁 <b>Duplicate</b> — this listing is already in the database.\nHash: <code>${result.hash?.slice(0, 16)}…</code>`;
        } else {
          reply = `❌ <b>Error:</b> ${result.error}`;
        }

        await ctx.api.editMessageText(processingMsg.chat.id, processingMsg.message_id, reply, {
          parse_mode: 'HTML',
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        processingMsg.chat.id,
        processingMsg.message_id,
        `❌ <b>Ingest failed:</b> ${msg}`,
        { parse_mode: 'HTML' },
      );
    }
  });

  // ─── /stats ───────────────────────────────────────────────────────────────────

  handler.command('stats', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const [users, properties, filters] = [
      container.usersRepo.getUserCount(),
      container.propertiesRepo.getPropertyCount(),
      container.filtersRepo.getFilterCount(),
    ];

    const analytics24h = container.analyticsRepo.getSummary(24);
    const metrics24h = container.metricsRepo.getSummaryByHours('all', 24);
    const metricsAllTime = container.metricsRepo.getAllTimeSummary();

    await ctx.reply(
      `📊 <b>HomEasy Comprehensive Statistics</b>\n\n` +
        `👥 <b>Users & Database:</b>\n` +
        `  • Total Registered: <b>${users}</b>\n` +
        `  • Active Users (24h): <b>${analytics24h.activeUsers}</b>\n` +
        `  • Total Events (24h): <b>${analytics24h.totalEvents}</b>\n` +
        `  • Total Listings: <b>${properties}</b>\n` +
        `  • Active Alerts: <b>${filters}</b>\n\n` +
        `🔄 <b>Scraper Activity (24h):</b>\n` +
        `  • Runs completed: <b>${metrics24h.runsCount}</b>\n` +
        `  • Total Scraped: <b>${metrics24h.totalScraped}</b>\n` +
        `  • New Inserted: <b>+${metrics24h.inserted}</b>\n` +
        `  • Duplicates: <b>${metrics24h.duplicates}</b>\n` +
        `  • Errors: <b>${metrics24h.errors}</b>\n\n` +
        `📚 <b>All-Time Scraper Totals:</b>\n` +
        `  • Runs: <b>${metricsAllTime.runsCount}</b>\n` +
        `  • Total Scraped: <b>${metricsAllTime.totalScraped.toLocaleString()}</b>\n` +
        `  • New Inserted: <b>+${metricsAllTime.inserted.toLocaleString()}</b>\n` +
        `  • Duplicates: <b>${metricsAllTime.duplicates.toLocaleString()}</b>`,
      { parse_mode: 'HTML' },
    );
  });

  // ─── /backup ──────────────────────────────────────────────────────────────────
  handler.command('backup', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const waitMsg = await ctx.reply('⏳ Creating database backup snapshot...');
    const result = createDatabaseBackup();

    if (result.success) {
      const sizeKb = Math.round((result.sizeBytes ?? 0) / 1024);
      await ctx.api.editMessageText(
        waitMsg.chat.id,
        waitMsg.message_id,
        `📦 <b>Database Backup Complete</b>\n\n` +
          `📁 <b>File:</b> <code>${result.filename}</code>\n` +
          `⚖️ <b>Size:</b> <b>${sizeKb} KB</b>\n` +
          `📚 <b>Retained Snapshots:</b> <b>${result.retainedCount}</b> (pruned ${result.prunedCount})`,
        { parse_mode: 'HTML' },
      );
    } else {
      await ctx.api.editMessageText(
        waitMsg.chat.id,
        waitMsg.message_id,
        `❌ <b>Backup Failed:</b> ${result.error}`,
        { parse_mode: 'HTML' },
      );
    }
  });

  // ─── /enrich ──────────────────────────────────────────────────────────────────
  handler.command('enrich', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const waitMsg = await ctx.reply('⏳ Step 1/2: Creating safety backup before enrichment...');

    // Safety backup before any enrichment mutation
    const backupResult = createDatabaseBackup();
    if (!backupResult.success) {
      await ctx.api.editMessageText(
        waitMsg.chat.id,
        waitMsg.message_id,
        `🚨 <b>Enrichment Aborted:</b> Safety backup failed (${backupResult.error}). No changes were made.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.api.editMessageText(
      waitMsg.chat.id,
      waitMsg.message_id,
      `⏳ Step 2/2: Safety backup OK (${backupResult.filename}). Scanning & enriching properties...`,
      { parse_mode: 'HTML' },
    );

    try {
      const stats = runEnrichment();
      container.db.exec('PRAGMA optimize;');

      await ctx.api.editMessageText(
        waitMsg.chat.id,
        waitMsg.message_id,
        `✅ <b>Database Enrichment Complete</b>\n\n` +
          `📦 Total Scanned:       <b>${stats.totalScanned}</b>\n` +
          `✨ Total Enriched:      <b>${stats.totalUpdated}</b>\n` +
          `🚫 Spam / Land Culled:  <b>${stats.deactivatedSpam}</b>\n` +
          `🛏 Bedrooms Recovered:   <b>${stats.recoveredBedrooms}</b>\n` +
          `🚿 Bathrooms Recovered:  <b>${stats.recoveredBathrooms}</b>\n` +
          `📍 Sangkats Recovered:  <b>${stats.recoveredLocation}</b>\n` +
          `📞 Contacts Recovered:  <b>${stats.recoveredPhone + stats.recoveredTelegram}</b>\n` +
          `📅 Dates Backfilled:    <b>${stats.backfilledPostedAt}</b>\n\n` +
          `🛡️ <i>Safety backup snapshot saved.</i>`,
        { parse_mode: 'HTML' },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        waitMsg.chat.id,
        waitMsg.message_id,
        `💥 <b>Enrichment Error:</b> ${msg}`,
        { parse_mode: 'HTML' },
      );
    }
  });

  // ─── /broadcast (stub for future use) ────────────────────────────────────────
  handler.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const text = ctx.message?.text?.replace(/^\/broadcast\s*/i, '').trim();
    if (!text) {
      await ctx.reply('Usage: /broadcast <message text>');
      return;
    }

    await ctx.reply(
      `📢 <b>Broadcast</b> is not yet implemented.\n\nMessage preview:\n<i>${text}</i>`,
      { parse_mode: 'HTML' },
    );
  });

  // ─── Remote Visual Browser Authentication ───────────────────────────────────

  function getBrowserAuthUrl(adminId: number, service: 'facebook' | 'khmer24'): string {
    const token = container.remoteBrowserService.createSessionToken(adminId, service);
    const baseUrl = env.API_PUBLIC_URL || env.WEBAPP_URL || `http://localhost:${env.API_PORT}`;
    return `${baseUrl}/admin/remote-browser?token=${token}`;
  }

  handler.command('auth_fb', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const fromId = ctx.from!.id;
    const url = getBrowserAuthUrl(fromId, 'facebook');
    const kb = new InlineKeyboard().url('🌐 Открыть браузер Facebook', url);

    await ctx.reply(
      '🔐 <b>Удаленная авторизация в Facebook (через резидентный прокси)</b>\n\n' +
        'Нажмите кнопку ниже, чтобы открыть интерактивное окно браузера прямо на телефоне:\n' +
        '• Сессия запускается на сервере строго через прокси `FB_PROXY`.\n' +
        '• Введите свои учетные данные и пройдите 2FA.\n' +
        '• После успешного входа сессия автоматически сохранится на сервере.\n\n' +
        `Прямая ссылка:\n${url}\n\n` +
        '<i>Ссылка активна 15 минут.</i>',
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });

  handler.command('auth_k24', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const fromId = ctx.from!.id;
    const url = getBrowserAuthUrl(fromId, 'khmer24');
    const kb = new InlineKeyboard().url('🌐 Открыть браузер Khmer24', url);

    await ctx.reply(
      '🔐 <b>Удаленная авторизация в Khmer24</b>\n\n' +
        'Нажмите кнопку ниже, чтобы открыть интерактивное окно браузера:\n' +
        '• Сессия запускается на сервере напрямую (без прокси).\n' +
        '• Выполните вход по номеру телефона / паролю.\n' +
        '• Сессия автоматически сохранится на сервере.\n\n' +
        '<i>Ссылка активна 15 минут.</i>',
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });

  handler.callbackQuery('admin:auth:fb', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    const fromId = ctx.from.id;
    const url = getBrowserAuthUrl(fromId, 'facebook');
    const kb = new InlineKeyboard().url('🌐 Открыть браузер Facebook', url);

    await ctx.reply(
      '🔐 <b>Сессия авторизации Facebook готова</b>\n\n' +
        'Перейдите по кнопке ниже для входа через резидентный прокси:\n' +
        `<code>${url}</code>`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });

  handler.callbackQuery('admin:auth:k24', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: '⛔ Только для администраторов', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    const fromId = ctx.from.id;
    const url = getBrowserAuthUrl(fromId, 'khmer24');
    const kb = new InlineKeyboard().url('🌐 Открыть браузер Khmer24', url);

    await ctx.reply(
      '🔐 <b>Сессия авторизации Khmer24 готова</b>\n\n' +
        'Перейдите по кнопке ниже для входа в аккаунт Khmer24:\n' +
        `<code>${url}</code>`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });

  return handler;
}
