import { Composer } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { createDatabaseBackup } from '../../../database/backup';
import { runEnrichment } from '../../../database/enrich-properties';

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

    await ctx.reply(
      `📊 <b>HomEasy Statistics</b>\n\n` +
        `👥 Active Users:     <b>${users}</b>\n` +
        `🏠 Total Listings:   <b>${properties}</b>\n` +
        `🔔 Active Alerts:    <b>${filters}</b>`,
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

  return handler;
}
