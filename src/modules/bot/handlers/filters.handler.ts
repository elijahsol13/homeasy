import { Composer, InlineKeyboard } from 'grammy';
import type { MyContext } from '../session';
import {
  bedroomsKeyboard,
  budgetKeyboard,
  categoryKeyboard,
  cityKeyboard,
  confirmKeyboard,
  leaseKeyboard,
  locationsKeyboard,
  poolKeyboard,
  typeKeyboard,
} from '../keyboards/filter.keyboard';
import { mainMenuKeyboard } from '../keyboards/main.keyboard';
import type { AppContainer } from '../../../container';
import { formatListingCard } from '../../../services/notifier';
import { listingActionKeyboard } from '../keyboards/listing.keyboard';
import {
  BEDROOM_OPTIONS,
  BUDGET_RANGES,
  CATEGORY_OPTIONS,
  CITIES,
  DISTRICTS,
  LEASE_OPTIONS,
  POOL_OPTIONS,
  type CityKey,
} from '../../../config/settings';
import type { FilterDraft } from '../session';

// ─── Free-form text input for custom budget ───────────────────────────────────

/**
 * Parses free-form user budget input into min and max numbers in USD.
 * Supports:
 *  - "150-300", "150 - 300", "150 to 300", "150..300", "150/300"
 *  - "under 300", "до 300", "< 300", "max 300"
 *  - "from 200", "от 200", "> 200", "200+"
 *  - "250" -> min: 0, max: 250
 */
export function parseCustomBudgetInput(text: string): { min?: number; max?: number } | null {
  const cleaned = text.replace(/[$,]/g, '').trim().toLowerCase();
  if (!cleaned) return null;

  // Range format: e.g. "150-300", "150 - 300", "150 to 300", "150 300", "150..300"
  const rangeMatch = /(\d+)\s*(?:-|–|—|to|до|\.\.|\/|\s+)\s*(\d+)/i.exec(cleaned);
  if (rangeMatch) {
    const num1 = parseInt(rangeMatch[1]!, 10);
    const num2 = parseInt(rangeMatch[2]!, 10);
    if (!isNaN(num1) && !isNaN(num2)) {
      return { min: Math.min(num1, num2), max: Math.max(num1, num2) };
    }
  }

  // Under / Max / Up to / До / Меньше: e.g. "under 300", "<300", "до 300", "max 300"
  const underMatch = /(?:under|max|up\s*to|<|<=|до|менее|меньше)\s*(\d+)/i.exec(cleaned);
  if (underMatch) {
    const num = parseInt(underMatch[1]!, 10);
    if (!isNaN(num)) return { min: 0, max: num };
  }

  // From / Min / От / Более / Plus: e.g. "from 200", ">200", "от 200", "min 200", "200+"
  const fromMatch = /(?:from|min|>|>=|от|более|больше)\s*(\d+)|(\d+)\s*\+/i.exec(cleaned);
  if (fromMatch) {
    const num = parseInt(fromMatch[1] || fromMatch[2]!, 10);
    if (!isNaN(num)) return { min: num, max: undefined };
  }

  // Single number: "250" -> treat as upper limit (up to $250)
  const singleMatch = /^\s*(\d+)\s*$/.exec(cleaned);
  if (singleMatch) {
    const num = parseInt(singleMatch[1]!, 10);
    if (!isNaN(num) && num > 0) return { min: 0, max: num };
  }

  return null;
}

// ─── Wizard entry ─────────────────────────────────────────────────────────────

export async function startFilterWizard(ctx: MyContext): Promise<void> {
  ctx.session.wizardStep = 'filter:type';
  ctx.session.filterDraft = { locations: [], requires_pool: false };

  await sendOrEdit(
    ctx,
    '🏠 <b>Step 1 / 8 — Listing Type</b>\n\nAre you looking to rent or buy?',
    { parse_mode: 'HTML' as const, reply_markup: typeKeyboard() },
  );
}

// ─── Filter list display ──────────────────────────────────────────────────────

export async function showUserFilters(ctx: MyContext): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = ctx.container.usersRepo.findByTelegramId(from.id);
  if (!user) {
    await sendOrEdit(ctx, '❌ Please /start the bot first.', {});
    return;
  }

  const activeFilters = ctx.container.filtersRepo.getUserFilters(user.id).filter((f) => f.is_active === 1);

  if (activeFilters.length === 0) {
    await sendOrEdit(
      ctx,
      '🛠 <b>Manage Alerts</b>\n\nYou have no active search alerts yet.\n\nTap <b>🔍 Search & Alerts</b> to create one!',
      {
        parse_mode: 'HTML' as const,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Create Alert', callback_data: 'cb:menu:search' }],
            [{ text: '🔙 Main Menu', callback_data: 'cb:menu:main' }],
          ],
        },
      },
    );
    return;
  }

  let text = '🛠 <b>Manage Alerts</b>\n\nHere are your active alerts. Tap a button below to delete any alert:\n\n';
  activeFilters.forEach((f, i) => {
    const cityLabel = CITIES[f.city] ?? f.city;
    const catLabel =
      CATEGORY_OPTIONS.find((c) => c.value === f.category)?.label ?? '🏢 Any Category';
    const priceRange = buildPriceRangeLabel(f.min_price, f.max_price);
    const beds =
      f.bedrooms === null ? 'Any' : f.bedrooms === 0 ? 'Studio' : `${f.bedrooms} BR`;
    const locs = f.locations.length > 0 ? f.locations.join(', ') : 'All Areas';
    const pool = f.requires_pool ? '🏊 Pool: Required' : '🏊 Pool: Any';
    const lease =
      f.min_lease_preferred === 5
        ? '📅 Short-term (1–5 mos)'
        : f.min_lease_preferred === 6
          ? '📆 Long-term (6+ mos)'
          : '⏱️ Any Lease';

    text += `<b>Alert #${i + 1} — ${f.type === 'rent' ? '🏠 Rent' : '🏷️ Sale'} (${cityLabel})</b>\n`;
    text += `   🏷️ ${catLabel}\n`;
    text += `   📍 ${locs}\n`;
    text += `   💰 ${priceRange}/mo\n`;
    text += `   🛏 ${beds} · ${pool}\n`;
    text += `   ⏱️ ${lease}\n\n`;
  });

  const deleteButtons = activeFilters.map((f, i) => [
    {
      text: `🗑 Delete Alert #${i + 1} (${f.type === 'rent' ? 'Rent' : 'Sale'} · ${CITIES[f.city] ?? f.city})`,
      callback_data: `cb:filter:delete:${f.id}`,
    },
  ]);

  await sendOrEdit(ctx, text, {
    parse_mode: 'HTML' as const,
    reply_markup: {
      inline_keyboard: [
        ...deleteButtons,
        [{ text: '🗑 Delete All Alerts', callback_data: 'cb:filter:delete_all' }],
        [{ text: '➕ Add New Alert', callback_data: 'cb:menu:search' }],
        [{ text: '🔙 Main Menu', callback_data: 'cb:menu:main' }],
      ],
    },
  });
}

// ─── Callback router for wizard steps ────────────────────────────────────────

export async function handleFilterCallback(ctx: MyContext, data: string): Promise<void> {
  const step = ctx.session.wizardStep;
  const draft = ctx.session.filterDraft;

  // ── Universal actions ──────────────────────────────────────────────────────

  if (data === 'cb:filter:cancel') {
    ctx.session.wizardStep = 'idle';
    ctx.session.filterDraft = { locations: [] };
    await ctx.editMessageText('❌ Alert creation cancelled.', {
      reply_markup: mainMenuKeyboard(),
    });
    await ctx.answerCallbackQuery('Cancelled');
    return;
  }

  if (data === 'cb:filter:restart') {
    await startFilterWizard(ctx);
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith('cb:filter:delete:')) {
    const filterId = parseInt(data.replace('cb:filter:delete:', ''), 10);
    const from = ctx.from;
    if (from && !isNaN(filterId)) {
      const user = ctx.container.usersRepo.findByTelegramId(from.id);
      if (user) {
        ctx.container.filtersRepo.deactivateFilter(filterId, user.id);
        await ctx.answerCallbackQuery('🗑 Alert deleted!');
        await showUserFilters(ctx);
        return;
      }
    }
  }

  if (data === 'cb:filter:delete_all') {
    const from = ctx.from;
    if (!from) return;
    const user = ctx.container.usersRepo.findByTelegramId(from.id);
    if (user) ctx.container.filtersRepo.deactivateAllUserFilters(user.id);
    await ctx.editMessageText('🗑 All your search alerts have been removed.', {
      reply_markup: mainMenuKeyboard(),
    });
    await ctx.answerCallbackQuery('✅ All alerts deleted');
    return;
  }

  // ── Step 1: filter:type ────────────────────────────────────────────────────

  if (step === 'filter:type' && data.startsWith('cb:filter:type:')) {
    const type = data.replace('cb:filter:type:', '') as 'rent' | 'sale';
    draft.type = type;
    ctx.session.wizardStep = 'filter:category';

    await ctx.editMessageText(
      `✅ <b>${type === 'rent' ? 'For Rent' : 'For Sale'}</b> selected.\n\n` +
        `🏢 <b>Step 2 / 8 — Property Category</b>\n\nWhat category of property are you looking for?`,
      { parse_mode: 'HTML', reply_markup: categoryKeyboard() },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Step 2: filter:category ────────────────────────────────────────────────

  if (step === 'filter:category' && data.startsWith('cb:filter:cat:')) {
    const idx = parseInt(data.replace('cb:filter:cat:', ''), 10);
    const catOpt = CATEGORY_OPTIONS[idx];
    if (catOpt) {
      draft.category = catOpt.value;
    }

    ctx.session.wizardStep = 'filter:city';
    await ctx.editMessageText(
      `✅ <b>Category:</b> ${catOpt?.label ?? 'Any'}\n\n` +
        `🌆 <b>Step 3 / 8 — City</b>\n\nWhich city are you looking in?`,
      { parse_mode: 'HTML', reply_markup: cityKeyboard() },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Step 3: filter:city ────────────────────────────────────────────────────

  if (step === 'filter:city' && data.startsWith('cb:filter:city:')) {
    const city = data.replace('cb:filter:city:', '') as CityKey;
    draft.city = city;
    draft.locations = [];
    ctx.session.wizardStep = 'filter:locations';

    await ctx.editMessageText(
      `✅ <b>${CITIES[city]}</b> selected.\n\n` +
        `📍 <b>Step 4 / 8 — Districts / Sangkats</b>\n\n` +
        `Pick specific areas or tap <b>Any Area</b> for the whole city. Tap <b>✅ Done</b> when ready.`,
      { parse_mode: 'HTML', reply_markup: locationsKeyboard(city, draft.locations) },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Step 4: filter:locations ───────────────────────────────────────────────

  if (step === 'filter:locations') {
    const city = draft.city!;
    const districts = DISTRICTS[city];

    if (data === 'cb:filter:loc:all') {
      draft.locations = [];
      await ctx.editMessageReplyMarkup({ reply_markup: locationsKeyboard(city, draft.locations) });
      await ctx.answerCallbackQuery('🌍 All areas selected');
      return;
    }

    if (data === 'cb:filter:loc:done') {
      ctx.session.wizardStep = 'filter:budget';
      const locLabel = draft.locations.length > 0 ? draft.locations.join(', ') : 'All Areas';

      await ctx.editMessageText(
        `✅ <b>Areas:</b> ${locLabel}\n\n` +
          `💰 <b>Step 5 / 8 — Monthly Budget</b>\n\n` +
          `Select a preset range or <b>type your custom budget directly</b> (e.g. <code>150-300</code>, <code>under 250</code>, or <code>200</code>):`,
        { parse_mode: 'HTML', reply_markup: budgetKeyboard() },
      );
      await ctx.answerCallbackQuery();
      return;
    }

    if (data.startsWith('cb:filter:loc:')) {
      const idx = parseInt(data.replace('cb:filter:loc:', ''), 10);
      if (!isNaN(idx) && idx < districts.length) {
        const district = districts[idx]!;
        const pos = draft.locations.indexOf(district);
        if (pos >= 0) {
          draft.locations.splice(pos, 1);
        } else {
          draft.locations.push(district);
        }
        await ctx.editMessageReplyMarkup({ reply_markup: locationsKeyboard(city, draft.locations) });
        await ctx.answerCallbackQuery(
          draft.locations.includes(district) ? `✅ ${district}` : `Deselected`,
        );
      }
      return;
    }
  }

  // ── Step 5: filter:budget ──────────────────────────────────────────────────

  if ((step === 'filter:budget' || step === 'filter:budget:custom') && data === 'cb:filter:budget:custom') {
    ctx.session.wizardStep = 'filter:budget:custom';
    await ctx.editMessageText(
      '✍️ <b>Enter Custom Budget</b>\n\n' +
        'Please send a message with your budget range in USD.\n\n' +
        '<b>Examples:</b>\n' +
        '• <code>150-300</code> ($150 to $300)\n' +
        '• <code>under 250</code> (up to $250)\n' +
        '• <code>200+</code> (from $200)\n' +
        '• <code>250</code> (up to $250)\n\n' +
        '<i>Type your budget into the chat below:</i>',
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🔙 Back to Presets', 'cb:filter:budget:back')
          .row()
          .text('❌ Cancel', 'cb:filter:cancel'),
      },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (step === 'filter:budget:custom' && data === 'cb:filter:budget:back') {
    ctx.session.wizardStep = 'filter:budget';
    await ctx.editMessageText(
      '💰 <b>Step 5 / 8 — Monthly Budget</b>\n\n' +
        'Select a preset range or <b>type your custom budget directly</b> (e.g. <code>150-300</code>, <code>under 250</code>, or <code>200</code>):',
      { parse_mode: 'HTML', reply_markup: budgetKeyboard() },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if ((step === 'filter:budget' || step === 'filter:budget:custom') && data.startsWith('cb:filter:budget:')) {
    const key = data.replace('cb:filter:budget:', '');

    if (key === 'any') {
      draft.min_price = undefined;
      draft.max_price = undefined;
    } else {
      const idx = parseInt(key, 10);
      const range = BUDGET_RANGES[idx];
      if (range) {
        draft.min_price = range.min;
        draft.max_price = range.max ?? undefined;
      }
    }

    ctx.session.wizardStep = 'filter:bedrooms';
    await ctx.editMessageText(
      `✅ <b>Budget:</b> ${buildPriceRangeLabel(draft.min_price ?? null, draft.max_price ?? null)}\n\n` +
        `🛏 <b>Step 6 / 8 — Bedrooms</b>\n\nHow many bedrooms do you need?`,
      { parse_mode: 'HTML', reply_markup: bedroomsKeyboard() },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Step 6: filter:bedrooms ────────────────────────────────────────────────

  if (step === 'filter:bedrooms' && data.startsWith('cb:filter:beds:')) {
    const idx = parseInt(data.replace('cb:filter:beds:', ''), 10);
    const opt = BEDROOM_OPTIONS[idx];
    if (opt !== undefined) {
      draft.bedrooms = opt.value;
    }

    ctx.session.wizardStep = 'filter:pool';
    const bedsLabel =
      draft.bedrooms === null ? 'Any' : draft.bedrooms === 0 ? 'Studio' : `${draft.bedrooms} BR`;

    await ctx.editMessageText(
      `✅ <b>Bedrooms:</b> ${bedsLabel}\n\n` +
        `🏊 <b>Step 7 / 8 — Swimming Pool</b>\n\nDo you require a swimming pool?`,
      { parse_mode: 'HTML', reply_markup: poolKeyboard() },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Step 7: filter:pool ────────────────────────────────────────────────────

  if (step === 'filter:pool' && data.startsWith('cb:filter:pool:')) {
    const idx = parseInt(data.replace('cb:filter:pool:', ''), 10);
    const opt = POOL_OPTIONS[idx];
    if (opt !== undefined) {
      draft.requires_pool = opt.value;
    }

    ctx.session.wizardStep = 'filter:lease';
    await ctx.editMessageText(
      `✅ <b>Pool:</b> ${draft.requires_pool ? 'Required 🏊' : 'Any'}\n\n` +
        `⏱️ <b>Step 8 / 8 — Lease Term</b>\n\nWhat is your preferred lease duration?`,
      { parse_mode: 'HTML', reply_markup: leaseKeyboard() },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Step 8: filter:lease ───────────────────────────────────────────────────

  if (step === 'filter:lease' && data.startsWith('cb:filter:lease:')) {
    const idx = parseInt(data.replace('cb:filter:lease:', ''), 10);
    const opt = LEASE_OPTIONS[idx];
    if (opt !== undefined) {
      draft.min_lease_preferred = opt.value;
    }

    ctx.session.wizardStep = 'filter:confirm';
    const summary = buildFilterSummary(draft);

    await ctx.editMessageText(
      `📋 <b>Alert Summary</b>\n\n${summary}\n\nDoes everything look right?`,
      { parse_mode: 'HTML', reply_markup: confirmKeyboard() },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Confirm ────────────────────────────────────────────────────────────────

  if (data === 'cb:filter:confirm') {
    const from = ctx.from;
    if (!from) return;

    const user = ctx.container.usersRepo.findByTelegramId(from.id);
    if (!user || !draft.type || !draft.city) {
      await ctx.answerCallbackQuery('❌ Session expired — please try again');
      ctx.session.wizardStep = 'idle';
      return;
    }

    const savedFilter = ctx.container.filtersRepo.createFilter({
      user_id: user.id,
      type: draft.type,
      category: draft.category ?? null,
      requires_pool: draft.requires_pool ?? false,
      min_lease_preferred: draft.min_lease_preferred ?? null,
      city: draft.city,
      min_price: draft.min_price ?? null,
      max_price: draft.max_price ?? null,
      bedrooms: draft.bedrooms ?? null,
      locations: draft.locations,
    });

    ctx.session.wizardStep = 'idle';
    ctx.session.filterDraft = { locations: [] };

    const instantMatches = ctx.container.matcherService.findMatchingPropertiesForFilter(savedFilter, 4);

    if (instantMatches.length > 0) {
      await ctx.editMessageText(
        `✅ <b>Search Alert Saved!</b>\n\n🎉 <i>Found ${instantMatches.length} matching listing(s) available right now:</i>`,
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(user.alerts_paused === 1) },
      );
      for (const prop of instantMatches) {
        const text = formatListingCard(prop);
        const reply_markup = listingActionKeyboard(prop);
        const validPhoto = prop.photos?.find((u) => u.startsWith('http'));
        try {
          if (validPhoto) {
            await ctx.api.sendPhoto(from.id, validPhoto, {
              caption: text,
              parse_mode: 'HTML',
              reply_markup,
            });
          } else {
            await ctx.api.sendMessage(from.id, text, {
              parse_mode: 'HTML',
              reply_markup,
            });
          }
        } catch (err) {
          console.warn(`[ColdStart] Failed to send match #${prop.id}:`, err);
        }
      }
    } else {
      await ctx.editMessageText(
        '✅ <b>Search Alert Saved!</b>\n\n' +
          "You'll be notified as soon as a matching listing appears.\n\n" +
          'Use <b>🛠 Manage Alerts</b> to view or delete your alerts.',
        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(user.alerts_paused === 1) },
      );
    }
    await ctx.answerCallbackQuery('✅ Alert saved!');
    return;
  }

  await ctx.answerCallbackQuery('⚠️ Please follow the steps in order');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPriceRangeLabel(min: number | null, max: number | null): string {
  const hasMin = min !== null && min > 0;
  const hasMax = max !== null;

  if (hasMin && hasMax) return `$${min!.toLocaleString('en-US')} – $${max!.toLocaleString('en-US')}`;
  if (hasMin) return `From $${min!.toLocaleString('en-US')}`;
  if (hasMax) return `Up to $${max!.toLocaleString('en-US')}`;
  return 'Any Budget';
}

function buildFilterSummary(draft: FilterDraft): string {
  const typeLabel = draft.type === 'rent' ? '🏠 For Rent' : '🏷️ For Sale';
  const catLabel =
    CATEGORY_OPTIONS.find((c) => c.value === draft.category)?.label ?? '🏢 Any Category';
  const cityLabel = draft.city ? CITIES[draft.city] : '—';
  const locsLabel = draft.locations.length > 0 ? draft.locations.join(', ') : 'All Areas';
  const budgetLabel = buildPriceRangeLabel(draft.min_price ?? null, draft.max_price ?? null);
  const bedsLabel =
    draft.bedrooms === undefined || draft.bedrooms === null
      ? 'Any'
      : draft.bedrooms === 0
        ? 'Studio'
        : draft.bedrooms >= 4
          ? '4+ BR'
          : `${draft.bedrooms} BR`;
  const poolLabel = draft.requires_pool ? '🏊 Pool Required' : 'Any';
  const leaseLabel =
    draft.min_lease_preferred === 5
      ? '📅 Short-term (1–5 mos)'
      : draft.min_lease_preferred === 6
        ? '📆 Long-term (6+ mos)'
        : '⏱️ Any Lease';

  return (
    `• Type: <b>${typeLabel}</b>\n` +
    `• Category: <b>${catLabel}</b>\n` +
    `• City: <b>${cityLabel}</b>\n` +
    `• Areas: <b>${locsLabel}</b>\n` +
    `• Budget: <b>${budgetLabel}/mo</b>\n` +
    `• Bedrooms: <b>${bedsLabel}</b>\n` +
    `• Pool: <b>${poolLabel}</b>\n` +
    `• Lease Term: <b>${leaseLabel}</b>`
  );
}

async function sendOrEdit(
  ctx: MyContext,
  text: string,
  opts: Record<string, unknown>,
): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, opts);
  } else {
    await ctx.reply(text, opts);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createFiltersHandler(_container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  handler.command('myfilters', async (ctx) => {
    await showUserFilters(ctx);
  });

  handler.on('message:text', async (ctx, next) => {
    const step = ctx.session.wizardStep;
    if (step !== 'filter:budget' && step !== 'filter:budget:custom') {
      return next();
    }

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      return next();
    }

    const parsed = parseCustomBudgetInput(text);
    if (!parsed) {
      await ctx.reply(
        '⚠️ <b>Could not understand budget format.</b>\n\n' +
          'Please send your budget like:\n' +
          '• <code>150-300</code> (between $150 and $300)\n' +
          '• <code>under 250</code> (up to $250)\n' +
          '• <code>200+</code> (from $200)\n' +
          '• <code>250</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const draft = ctx.session.filterDraft;
    draft.min_price = parsed.min;
    draft.max_price = parsed.max;
    ctx.session.wizardStep = 'filter:bedrooms';

    await ctx.reply(
      `✅ <b>Budget:</b> ${buildPriceRangeLabel(draft.min_price ?? null, draft.max_price ?? null)}\n\n` +
        `🛏 <b>Step 6 / 8 — Bedrooms</b>\n\nHow many bedrooms do you need?`,
      { parse_mode: 'HTML', reply_markup: bedroomsKeyboard() },
    );
  });

  return handler;
}

