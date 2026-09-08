import { Composer, InlineKeyboard } from 'grammy';
import type { MyContext, FilterDraft } from '../session';
import type { AppContainer } from '../../../container';
import { env } from '../../../config/env';
import { MAX_USER_FILTERS } from '../../../database/repositories/filters.repo';
import { sendListingCard } from '../../../services/notifier';
import { formatBedroomsLabel } from '../keyboards/filter.keyboard';
import { buildPriceRangeLabel } from './filters.handler';
import type { NLSearchCriteria } from '../../../services/nl-search.service';
import type { CityKey, PropertyCategory } from '../../../config/settings';

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
// Max 4 queries / min, max 20 queries / day per Telegram user
interface RateLimitRecord {
  minuteTimestamps: number[];
  dayTimestamps: number[];
}

const userRateLimits = new Map<number, RateLimitRecord>();

function checkRateLimit(telegramId: number): { allowed: boolean; message?: string } {
  const now = Date.now();
  let record = userRateLimits.get(telegramId);
  if (!record) {
    record = { minuteTimestamps: [], dayTimestamps: [] };
    userRateLimits.set(telegramId, record);
  }

  // Purge expired
  record.minuteTimestamps = record.minuteTimestamps.filter((t) => now - t < 60 * 1000);
  record.dayTimestamps = record.dayTimestamps.filter((t) => now - t < 24 * 60 * 60 * 1000);

  if (record.minuteTimestamps.length >= 4) {
    return {
      allowed: false,
      message: '⏳ <b>Too many requests per minute</b> (limit is 4).\nPlease wait a minute before submitting your next search.',
    };
  }

  if (record.dayTimestamps.length >= 20) {
    return {
      allowed: false,
      message: '⏳ <b>Daily search limit reached</b> (20 queries per day).\nPlease use the step-by-step filter wizard or explore the interactive map in our Mini App.',
    };
  }

  record.minuteTimestamps.push(now);
  record.dayTimestamps.push(now);
  return { allowed: true };
}

// ─── Render AI Result Card ───────────────────────────────────────────────────

function renderCriteriaMessage(criteria: NLSearchCriteria, matchingCount: number): { text: string; keyboard: InlineKeyboard } {
  const cityLabel = criteria.city === 'phnom_penh' ? '🏙 Phnom Penh' : '🌴 Siem Reap';
  const typeLabel = criteria.type === 'sale' ? '🏷️ For Sale' : '🏠 For Rent';
  const categoryLabel = criteria.category ? ` (${criteria.category})` : '';

  const minCents = criteria.min_price ? criteria.min_price * 100 : null;
  const maxCents = criteria.max_price ? criteria.max_price * 100 : null;
  const budgetStr = buildPriceRangeLabel(minCents, maxCents);

  const bedsStr = criteria.bedrooms && criteria.bedrooms.length > 0 ? formatBedroomsLabel(criteria.bedrooms) : 'Any';

  let extraLines = '';
  if (criteria.requires_pool) extraLines += '\n• <b>Swimming Pool:</b> 🏊 Required';
  if (criteria.pet_friendly) extraLines += '\n• <b>Pets:</b> 🐾 Pet-friendly';
  if (criteria.location) extraLines += `\n• <b>District:</b> 📍 ${criteria.location}`;
  if (criteria.primary_landmark) extraLines += `\n• <b>Landmark:</b> 🚩 ${criteria.primary_landmark}`;
  if (criteria.min_lease_preferred) extraLines += `\n• <b>Lease Term:</b> from ${criteria.min_lease_preferred} month(s)`;

  let unindexedLine = '';
  if (criteria.unindexed_features && criteria.unindexed_features.length > 0) {
    unindexedLine = `\n• <b>Preferences:</b> ✨ ${criteria.unindexed_features.join(', ')}`;
  }

  const text =
    `🎯 <b>Search Criteria Understood:</b>\n\n` +
    `• <b>City:</b> ${cityLabel}\n` +
    `• <b>Type:</b> ${typeLabel}${categoryLabel}\n` +
    `• <b>Budget:</b> ${budgetStr}\n` +
    `• <b>Bedrooms:</b> ${bedsStr}` +
    extraLines +
    unindexedLine +
    `\n\n📦 <i>Available in database right now: <b>${matchingCount}</b> matching listing(s)</i>`;

  const kb = new InlineKeyboard();

  if (matchingCount > 0) {
    kb.text(`🔍 View Listings (${matchingCount})`, 'cb:ai:show').row();
  }
  kb.text('✅ Save Search Alert', 'cb:ai:save').row();
  kb.text('✏️ Adjust Filters', 'cb:ai:edit')
    .text('🔄 New Search', 'cb:ai:reset');

  return { text, keyboard: kb };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createNLSearchHandler(container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  // ── 0. Search & Find Commands ───────────────────────────────────────────────
  handler.command(['search', 'find'], async (ctx) => {
    const webUrl = env.WEBAPP_URL;
    const kb = new InlineKeyboard()
      .text('🛠 Step-by-Step Wizard', 'cb:filter:wizard:start')
      .row();
    if (webUrl && (webUrl.startsWith('https://') || webUrl.startsWith('http://'))) {
      if (webUrl.startsWith('https://')) {
        kb.webApp('📱 Open Map & Catalog', webUrl).row();
      } else {
        kb.url('📱 Open Map & Catalog', webUrl).row();
      }
    }
    kb.text('🔙 Main Menu', 'cb:menu:main');

    await ctx.reply(
      '🎙️ <b>AI Voice & Text Search</b>\n\n' +
        'Just send me a <b>voice message</b> (up to 30s) or <b>type in chat</b> what you are looking for:\n\n' +
        '• <i>"Looking for a 1-bedroom apartment with pool in Siem Reap under $400"</i>\n' +
        '• <i>"Rent a villa with pool in Siem Reap under $800"</i>\n' +
        '• <i>"Room for rent in Wat Bo under $200"</i>\n\n' +
        '🤖 Gemini AI will understand your criteria, check matching listings in our database, and offer to save an alert!',
      {
        parse_mode: 'HTML',
        reply_markup: kb,
      },
    );
  });

  // ── 1. Voice Notes Handler ──────────────────────────────────────────────────
  handler.on('message:voice', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    // Check voice duration before downloading
    const voice = ctx.message.voice;
    if (voice.duration > 30) {
      await ctx.reply(
        `⏱ <b>Voice note too long</b> (${voice.duration}s, maximum 30s).\n\n` +
          `Please record a brief voice message, for example:\n` +
          `<i>"Looking for a 1-bedroom apartment with pool in Siem Reap under $400"</i>`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Check rate limit
    const rl = checkRateLimit(from.id);
    if (!rl.allowed) {
      await ctx.reply(rl.message!, { parse_mode: 'HTML' });
      return;
    }

    await ctx.replyWithChatAction('typing');

    try {
      // Download voice file buffer from Telegram
      const file = await ctx.api.getFile(voice.file_id);
      if (!file.file_path) {
        await ctx.reply('⚠️ Could not download audio from Telegram. Please try again.');
        return;
      }

      const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
      const res = await fetch(fileUrl);
      if (!res.ok) {
        await ctx.reply('⚠️ Error downloading audio. Please try text input instead.');
        return;
      }

      const arrayBuf = await res.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuf);

      const user = container.usersRepo.findByTelegramId(from.id);

      const criteria = await container.nlSearchService.parseQuery({
        audioBuffer,
        audioMimeType: 'audio/ogg',
        telegramId: from.id,
        userId: user?.id,
      });

      await handleSearchCriteriaResult(ctx, criteria);
    } catch (err) {
      console.error('[NLSearch] Voice processing error:', err);
      await ctx.reply('⚠️ An error occurred while processing the voice message. Please try sending your query as text.');
    }
  });

  // ── 2. Natural Language Text Messages Handler ────────────────────────────────
  handler.on('message:text', async (ctx, next) => {
    // If user is inside the manual wizard, yield to wizard step handler
    if (ctx.session.wizardStep !== 'idle') {
      return next();
    }

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      return next();
    }

    const from = ctx.from;
    if (!from) return next();

    // Check length limit
    if (text.length > 350) {
      await ctx.reply(
        `⚠️ <b>Query text too long</b> (${text.length} chars, maximum 350).\n\n` +
          `Please summarize your key criteria briefly (city, property type, budget, amenities).`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Check rate limit
    const rl = checkRateLimit(from.id);
    if (!rl.allowed) {
      await ctx.reply(rl.message!, { parse_mode: 'HTML' });
      return;
    }

    await ctx.replyWithChatAction('typing');

    try {
      const user = container.usersRepo.findByTelegramId(from.id);

      const criteria = await container.nlSearchService.parseQuery({
        text,
        telegramId: from.id,
        userId: user?.id,
      });

      await handleSearchCriteriaResult(ctx, criteria);
    } catch (err) {
      console.error('[NLSearch] Text processing error:', err);
      return next();
    }
  });

  // ── 3. Callbacks for AI Flow ────────────────────────────────────────────────
  handler.callbackQuery('cb:ai:show', async (ctx) => {
    const draft = getOrRecoverDraft(ctx);
    const from = ctx.from;
    if (!from || !draft) {
      await ctx.answerCallbackQuery('Session expired. Please submit a new query.');
      return;
    }

    await ctx.answerCallbackQuery();

    const minPriceCents = draft.min_price ? draft.min_price * 100 : undefined;
    const maxPriceCents = draft.max_price ? draft.max_price * 100 : undefined;

    const results = container.propertiesRepo.searchProperties({
      city: draft.city || 'siem_reap',
      type: draft.type || 'rent',
      category: draft.category ?? undefined,
      minPrice: minPriceCents,
      maxPrice: maxPriceCents,
      bedrooms: draft.bedrooms ?? undefined,
      hasPool: draft.requires_pool || undefined,
      locations: draft.locations?.length ? draft.locations : undefined,
      primaryLandmark: draft.primary_landmark ?? undefined,
      limit: 3,
      offset: 0,
    });

    if (results.items.length === 0) {
      await ctx.reply('😔 No matching listings found right now. Save this alert to get notified the moment a property is listed!');
      return;
    }

    for (const prop of results.items) {
      try {
        await sendListingCard(from.id, prop, ctx.api);
      } catch (err) {
        console.warn(`[NLSearch] Failed to send prop #${prop.id}:`, err);
      }
    }

    const remaining = results.total - results.items.length;
    if (remaining > 0) {
      await ctx.reply(`📥 <b>${remaining} more matching listing(s) available in database</b>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text(`📥 Show 3 more (${remaining} left)`, `cb:ai:more:3`)
          .row()
          .text('✅ Save Search Alert', 'cb:ai:save')
          .text('🔔 My Alerts', 'cb:menu:filters'),
      });
    } else {
      await ctx.reply(
        `🏁 <b>You have viewed all matching listings (${results.total}).</b>\n\n` +
          `Tap <b>[ ✅ Save Search Alert ]</b> to automatically receive new listings as soon as they are posted!`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Save Search Alert', 'cb:ai:save')
            .row()
            .text('🔙 Main Menu', 'cb:menu:main'),
        },
      );
    }
  });

  handler.callbackQuery(/^cb:ai:more:(\d+)$/, async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const offset = parseInt(ctx.match[1]!, 10);
    const draft = getOrRecoverDraft(ctx) || { city: 'siem_reap', type: 'rent', locations: [] };

    await ctx.answerCallbackQuery();

    const minPriceCents = draft.min_price ? draft.min_price * 100 : undefined;
    const maxPriceCents = draft.max_price ? draft.max_price * 100 : undefined;

    const results = container.propertiesRepo.searchProperties({
      city: draft.city || 'siem_reap',
      type: draft.type || 'rent',
      category: draft.category ?? undefined,
      minPrice: minPriceCents,
      maxPrice: maxPriceCents,
      bedrooms: draft.bedrooms ?? undefined,
      hasPool: draft.requires_pool || undefined,
      locations: draft.locations?.length ? draft.locations : undefined,
      primaryLandmark: draft.primary_landmark ?? undefined,
      limit: 3,
      offset,
    });

    for (const prop of results.items) {
      try {
        await sendListingCard(from.id, prop, ctx.api);
      } catch (err) {
        console.warn(`[NLSearch] Failed to send prop #${prop.id}:`, err);
      }
    }

    const nextOffset = offset + results.items.length;
    const remaining = results.total - nextOffset;

    if (remaining > 0) {
      await ctx.reply(`📥 <b>${remaining} more matching listing(s) available in database</b>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text(`📥 Show 3 more (${remaining} left)`, `cb:ai:more:${nextOffset}`)
          .row()
          .text('✅ Save Search Alert', 'cb:ai:save')
          .text('🔔 My Alerts', 'cb:menu:filters'),
      });
    } else {
      await ctx.reply(
        `🏁 <b>You have viewed all matching listings (${results.total}).</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Save Search Alert', 'cb:ai:save')
            .row()
            .text('🔙 Main Menu', 'cb:menu:main'),
        },
      );
    }
  });

  handler.callbackQuery('cb:ai:save', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const draft = getOrRecoverDraft(ctx);
    if (!draft || !draft.type || !draft.city) {
      await ctx.answerCallbackQuery('❌ Search parameters not found. Please try again.');
      return;
    }

    const user = container.usersRepo.findByTelegramId(from.id);
    if (!user) {
      await ctx.answerCallbackQuery('❌ User not found.');
      return;
    }

    const activeCount = container.filtersRepo.countUserActiveFilters(user.id);
    if (activeCount >= MAX_USER_FILTERS) {
      await ctx.answerCallbackQuery({
        text: `⚠️ Limit of ${MAX_USER_FILTERS} alerts reached. Please remove an older alert!`,
        show_alert: true,
      });
      return;
    }

    const minPriceCents = draft.min_price ? draft.min_price * 100 : null;
    const maxPriceCents = draft.max_price ? draft.max_price * 100 : null;

    container.filtersRepo.createFilter({
      user_id: user.id,
      type: draft.type,
      category: draft.category ?? null,
      city: draft.city,
      min_price: minPriceCents,
      max_price: maxPriceCents,
      bedrooms: draft.bedrooms ?? null,
      requires_pool: draft.requires_pool ?? false,
      min_lease_preferred: draft.min_lease_preferred ?? null,
      locations: draft.locations ?? [],
    });

    await ctx.answerCallbackQuery('✅ Alert saved!');
    await ctx.reply(
      `✅ <b>Search alert successfully saved!</b>\n\n` +
        `🔔 The bot will continuously monitor new listings across Khmer24 and Facebook groups, sending matching properties directly to your chat.`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🔔 Manage Alerts', 'cb:menu:filters')
          .row()
          .text('🔙 Main Menu', 'cb:menu:main'),
      },
    );
  });

  handler.callbackQuery('cb:ai:edit', async (ctx) => {
    const draft = getOrRecoverDraft(ctx);
    await ctx.answerCallbackQuery();
    // Move user into wizard to fine-tune budget or other fields
    ctx.session.wizardStep = 'filter:budget';
    const currentMin = draft?.min_price ? draft.min_price * 100 : null;
    const currentMax = draft?.max_price ? draft.max_price * 100 : null;
    await ctx.reply(
      `✏️ <b>Adjust Parameters</b>\n\n` +
        `Current budget: <b>${buildPriceRangeLabel(currentMin, currentMax)}</b>\n\n` +
        `Send a new amount or range (e.g. <code>250-450</code> or <code>300</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('◀️ Keep Current', 'cb:filter:pool')
          .text('❌ Cancel', 'cb:filter:cancel'),
      },
    );
  });

  handler.callbackQuery('cb:ai:reset', async (ctx) => {
    ctx.session.wizardStep = 'idle';
    ctx.session.filterDraft = { locations: [] };
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🎙 <b>Ready for your next search!</b>\n\n` +
        `Record a voice note (up to 30s) or send a text describing the home you are looking for.\n\n` +
        `<i>Example: "Looking for an apartment with pool in Siem Reap under $400"</i>`,
      { parse_mode: 'HTML' },
    );
  });

  return handler;
}

// ─── Draft Recovery Helper ──────────────────────────────────────────────────

export function extractDraftFromCriteriaText(text: string): FilterDraft | null {
  if (!text || !text.includes('Search Criteria Understood')) return null;
  const clean = text.replace(/<[^>]+>/g, '');

  const city: CityKey = clean.includes('Sihanoukville') ? 'sihanoukville' : clean.includes('Phnom Penh') ? 'phnom_penh' : 'siem_reap';
  const type: 'rent' | 'sale' = clean.includes('For Sale') ? 'sale' : 'rent';

  // Category
  const catMatch = /\((apartment|condo|house|villa|land|room|hotel)\)/i.exec(clean);
  const category = catMatch ? (catMatch[1]!.toLowerCase() as PropertyCategory) : null;

  // Budget: e.g. "Up to $25,000", "$200 – $500", "From $300"
  let min_price: number | undefined;
  let max_price: number | undefined;
  const budgetRangeMatch = /Budget:\s*.*?\$?(\d[\d,]*)\s*[–-]\s*\$?(\d[\d,]*)/i.exec(clean);
  const budgetUpToMatch = /Budget:\s*.*?Up to \$?(\d[\d,]*)/i.exec(clean);
  const budgetFromMatch = /Budget:\s*.*?From \$?(\d[\d,]*)/i.exec(clean);

  if (budgetRangeMatch) {
    min_price = parseInt(budgetRangeMatch[1]!.replace(/,/g, ''), 10);
    max_price = parseInt(budgetRangeMatch[2]!.replace(/,/g, ''), 10);
  } else if (budgetUpToMatch) {
    max_price = parseInt(budgetUpToMatch[1]!.replace(/,/g, ''), 10);
  } else if (budgetFromMatch) {
    min_price = parseInt(budgetFromMatch[1]!.replace(/,/g, ''), 10);
  }

  // Bedrooms: e.g. "1 BR", "Studio", "1, 2 BR"
  let bedrooms: number[] | null = null;
  const bedsMatch = /Bedrooms:\s*([^\n]+)/i.exec(clean);
  if (bedsMatch) {
    const rawBeds = bedsMatch[1]!;
    const collected: number[] = [];
    if (rawBeds.includes('Studio')) collected.push(0);
    const numMatches = rawBeds.matchAll(/(\d+)\s*BR/gi);
    for (const m of numMatches) {
      const n = parseInt(m[1]!, 10);
      if (!isNaN(n) && !collected.includes(n)) collected.push(n);
    }
    if (collected.length > 0) {
      bedrooms = collected;
    }
  }

  // District / Location
  const distMatch = /District:\s*(?:📍\s*)?([^\n]+)/i.exec(clean);
  const locations: string[] = distMatch ? [distMatch[1]!.trim()] : [];

  // Pool
  const requires_pool = /Swimming Pool:\s*(?:🏊\s*)?Required/i.test(clean);

  return {
    city,
    type,
    category,
    min_price,
    max_price,
    bedrooms,
    requires_pool,
    locations,
  };
}

function getOrRecoverDraft(ctx: MyContext): FilterDraft | null {
  if (ctx.session?.filterDraft?.city && ctx.session?.filterDraft?.type) {
    return ctx.session.filterDraft;
  }
  const msgText = ctx.callbackQuery?.message?.text || (ctx.callbackQuery?.message as any)?.caption || '';
  const recovered = extractDraftFromCriteriaText(msgText);
  if (recovered) {
    ctx.session.filterDraft = recovered;
    return recovered;
  }
  return ctx.session?.filterDraft || null;
}

// ─── Helper: Handle Criteria Result ──────────────────────────────────────────

async function handleSearchCriteriaResult(ctx: MyContext, criteria: NLSearchCriteria): Promise<void> {
  if (!criteria.is_real_estate_query) {
    await ctx.reply(
      `🤖 <b>HomEasy AI Assistant</b>\n\n` +
        `I can instantly find rental and sale properties in <b>Siem Reap</b> and <b>Phnom Penh</b> from your voice notes or text messages.\n\n` +
        `💡 <b>Try asking:</b>\n` +
        `• <i>"Looking for a 1-bedroom apartment with pool in Siem Reap under $400"</i>\n` +
        `• <i>"Studio in Phnom Penh city center for 6 months, pet-friendly"</i>\n` +
        `• <i>"3-bedroom house in Wat Bo between $500 and $800"</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🛠 Step-by-Step Wizard', 'cb:menu:new_filter')
          .row()
          .text('🏠 Main Menu', 'cb:menu:main'),
      },
    );
    return;
  }

  // Populate session draft
  const city = criteria.city || 'siem_reap';
  ctx.session.filterDraft = {
    city,
    type: criteria.type || 'rent',
    category: criteria.category ?? null,
    min_price: criteria.min_price ?? undefined,
    max_price: criteria.max_price ?? undefined,
    bedrooms: criteria.bedrooms ?? [],
    requires_pool: criteria.requires_pool ?? false,
    min_lease_preferred: criteria.min_lease_preferred ?? null,
    locations: criteria.location ? [criteria.location] : [],
    primary_landmark: criteria.primary_landmark ?? null,
  };

  const minPriceCents = criteria.min_price ? criteria.min_price * 100 : undefined;
  const maxPriceCents = criteria.max_price ? criteria.max_price * 100 : undefined;

  const results = ctx.container.propertiesRepo.searchProperties({
    city,
    type: criteria.type || 'rent',
    category: criteria.category ?? undefined,
    minPrice: minPriceCents,
    maxPrice: maxPriceCents,
    bedrooms: criteria.bedrooms ?? undefined,
    hasPool: criteria.requires_pool || undefined,
    primaryLandmark: criteria.primary_landmark ?? undefined,
    limit: 1,
  });

  const { text, keyboard } = renderCriteriaMessage(criteria, results.total);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}
