import { Composer } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { createDatabaseBackup } from '../../../database/backup';
import { runEnrichment } from '../../../database/enrich-properties';
import { env } from '../../../config/env';
import { adminMenuKeyboard, adminBackKeyboard } from '../keyboards/admin.keyboard';
import { getScraperSettings, saveScraperSettings } from '../../../services/settings';

export function createAdminHandler(container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  // ─── Guard ────────────────────────────────────────────────────────────────────

  function isAdmin(ctx: MyContext): boolean {
    const from = ctx.from;
    if (!from) return false;
    if (env.ADMIN_IDS && env.ADMIN_IDS.includes(from.id)) return true;
    const user = container.usersRepo.findByTelegramId(from.id);
    return user?.role === 'admin';
  }

  // ─── Admin Dashboard ─────────────────────────────────────────────────────────

  const DASHBOARD_TEXT =
    '👑 <b>Admin Control Panel</b>\n\n' +
    'Welcome to the administrative control panel. Select an action below:';

  handler.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }
    await ctx.reply(DASHBOARD_TEXT, {
      parse_mode: 'HTML',
      reply_markup: adminMenuKeyboard(),
    });
  });

  handler.callbackQuery(['admin:menu', 'cb:admin:menu'], async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(DASHBOARD_TEXT, {
        parse_mode: 'HTML',
        reply_markup: adminMenuKeyboard(),
      });
    } catch {
      await ctx.reply(DASHBOARD_TEXT, {
        parse_mode: 'HTML',
        reply_markup: adminMenuKeyboard(),
      });
    }
  });

  // ─── Scraper Toggle ────────────────────────────────────────────────────────
  
  handler.command('scraper', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length === 0) {
      const settings = getScraperSettings();
      await ctx.reply(`<b>Server FB Scraper is currently:</b> ${settings.facebookEnabled ? '✅ ENABLED' : '❌ DISABLED'}\n\nUse <code>/scraper off</code> to disable it, or <code>/scraper on</code> to enable it.`, { parse_mode: 'HTML' });
      return;
    }

    const command = args[0].toLowerCase();
    if (command === 'on' || command === 'enable') {
      saveScraperSettings({ facebookEnabled: true });
      await ctx.reply('✅ Server FB Scraper has been <b>ENABLED</b>.', { parse_mode: 'HTML' });
    } else if (command === 'off' || command === 'disable') {
      saveScraperSettings({ facebookEnabled: false });
      await ctx.reply('❌ Server FB Scraper has been <b>DISABLED</b>.\n\nYou can now safely run <code>npm run scrape:fb</code> locally without burning proxy traffic on the server.', { parse_mode: 'HTML' });
    } else {
      await ctx.reply('Unknown command. Use <code>/scraper on</code> or <code>/scraper off</code>.', { parse_mode: 'HTML' });
    }
  });

  // ─── /ingest_json & Ingest Guide ─────────────────────────────────────────────

  const INGEST_GUIDE_TEXT =
    '📤 <b>Ingest JSON — Usage Guide</b>\n\n' +
    '<b>1. Single listing (inline):</b>\n' +
    '<code>/ingest_json {"title":"2BR in BKK1","price":800,"type":"rent","location":"BKK1","city":"phnom_penh"}</code>\n\n' +
    '<b>2. Bulk import (reply to JSON array):</b>\n' +
    'Send a message containing a JSON array of listings, then reply to it with <code>/ingest_json</code>.';

  handler.command('ingest_json', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const msg = ctx.message;
    if (!msg) return;

    let jsonText: string | undefined;

    if (msg.reply_to_message?.text) {
      jsonText = msg.reply_to_message.text;
    } else {
      const inlineText = msg.text?.replace(/^\/ingest_json\s*/i, '').trim();
      jsonText = inlineText && inlineText.length > 0 ? inlineText : undefined;
    }

    if (!jsonText) {
      await ctx.reply(INGEST_GUIDE_TEXT, {
        parse_mode: 'HTML',
        reply_markup: adminBackKeyboard(),
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      await ctx.reply('❌ <b>Invalid JSON</b> — please check your payload and try again.', {
        parse_mode: 'HTML',
        reply_markup: adminBackKeyboard(),
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
          { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
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
          reply_markup: adminBackKeyboard(),
        });
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        processingMsg.chat.id,
        processingMsg.message_id,
        `❌ <b>Ingest failed:</b> ${errorMsg}`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
      );
    }
  });

  handler.callbackQuery(['admin:ingest_help', 'cb:admin:ingest_help'], async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(INGEST_GUIDE_TEXT, {
      parse_mode: 'HTML',
      reply_markup: adminBackKeyboard(),
    });
  });

  // ─── /stats & Metrics ─────────────────────────────────────────────────────────

  async function getStatsMessage(): Promise<string> {
    const [users, properties, filters] = [
      container.usersRepo.getUserCount(),
      container.propertiesRepo.getPropertyCount(),
      container.filtersRepo.getFilterCount(),
    ];

    const analytics24h = container.analyticsRepo.getSummary(24);
    const metrics24h = container.metricsRepo.getSummaryByHours('all', 24);
    const metricsAllTime = container.metricsRepo.getAllTimeSummary();

    return (
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
      `  • Duplicates: <b>${metricsAllTime.duplicates.toLocaleString()}</b>`
    );
  }

  handler.command('stats', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }
    const text = await getStatsMessage();
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: adminBackKeyboard(),
    });
  });

  handler.callbackQuery(['admin:stats', 'cb:admin:stats'], async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const text = await getStatsMessage();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: adminBackKeyboard(),
    });
  });

  // ─── /backup ──────────────────────────────────────────────────────────────────

  async function executeBackup(ctx: MyContext, initialMessage?: { chat: { id: number }; message_id: number }) {
    const result = createDatabaseBackup();

    if (result.success) {
      const sizeKb = Math.round((result.sizeBytes ?? 0) / 1024);
      const text =
        `📦 <b>Database Backup Complete</b>\n\n` +
        `📁 <b>File:</b> <code>${result.filename}</code>\n` +
        `⚖️ <b>Size:</b> <b>${sizeKb} KB</b>\n` +
        `📚 <b>Retained Snapshots:</b> <b>${result.retainedCount}</b> (pruned ${result.prunedCount})`;

      if (initialMessage) {
        await ctx.api.editMessageText(initialMessage.chat.id, initialMessage.message_id, text, {
          parse_mode: 'HTML',
          reply_markup: adminBackKeyboard(),
        });
      } else {
        await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: adminBackKeyboard(),
        });
      }
    } else {
      const text = `❌ <b>Backup Failed:</b> ${result.error}`;
      if (initialMessage) {
        await ctx.api.editMessageText(initialMessage.chat.id, initialMessage.message_id, text, {
          parse_mode: 'HTML',
          reply_markup: adminBackKeyboard(),
        });
      } else {
        await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: adminBackKeyboard(),
        });
      }
    }
  }

  handler.command('backup', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const waitMsg = await ctx.reply('⏳ Creating database backup snapshot...');
    await executeBackup(ctx, waitMsg);
  });

  handler.callbackQuery(['admin:backup', 'cb:admin:backup'], async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const waitMsg = await ctx.reply('⏳ Creating database backup snapshot...');
    await executeBackup(ctx, waitMsg);
  });

  // ─── /enrich ──────────────────────────────────────────────────────────────────

  async function executeEnrichment(ctx: MyContext, waitMsg: { chat: { id: number }; message_id: number }) {
    // Safety backup before any enrichment mutation
    const backupResult = createDatabaseBackup();
    if (!backupResult.success) {
      await ctx.api.editMessageText(
        waitMsg.chat.id,
        waitMsg.message_id,
        `🚨 <b>Enrichment Aborted:</b> Safety backup failed (${backupResult.error}). No changes were made.`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
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
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
      );
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        waitMsg.chat.id,
        waitMsg.message_id,
        `💥 <b>Enrichment Error:</b> ${errorMsg}`,
        { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
      );
    }
  }

  handler.command('enrich', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ This command is for admins only.');
      return;
    }

    const waitMsg = await ctx.reply('⏳ Step 1/2: Creating safety backup before enrichment...');
    await executeEnrichment(ctx, waitMsg);
  });

  handler.callbackQuery(['admin:enrich', 'cb:admin:enrich'], async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: '⛔ Admins only', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const waitMsg = await ctx.reply('⏳ Step 1/2: Creating safety backup before enrichment...');
    await executeEnrichment(ctx, waitMsg);
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
      { parse_mode: 'HTML', reply_markup: adminBackKeyboard() },
    );
  });

  handler.callbackQuery(/^cb:admin:review:(approve|reject):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Admins only', show_alert: true });
      return;
    }

    const match = ctx.callbackQuery.data.match(/^cb:admin:review:(approve|reject):(\d+)$/);
    if (!match) return;
    const action = match[1];
    const propertyId = Number(match[2]);
    const updated = action === 'approve'
      ? container.propertiesRepo.approvePendingProperty(propertyId)
      : container.propertiesRepo.rejectPendingProperty(propertyId);

    await ctx.answerCallbackQuery({
      text: updated ? `Listing ${action}d` : 'Listing already reviewed or missing',
      show_alert: !updated,
    });
    if (!updated) {
      // Stale message — strip the buttons so it can't be tapped again.
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    if (action === 'approve') {
      const property = container.propertiesRepo.getPropertyById(propertyId);
      if (property?.is_active === 1) {
        await container.matcherService.matchAndNotify(property).catch((err) => {
          console.error('Approved listing match error:', err);
        });
      }
    }
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await ctx.reply(`${action === 'approve' ? 'Approved' : 'Rejected'} listing #${propertyId}.`);
  });

  return handler;
}
