import { Composer, InlineKeyboard } from 'grammy';
import type { MyContext } from '../session';
import type { AppContainer } from '../../../container';
import { env } from '../../../config/env';
import { MAX_USER_FILTERS } from '../../../database/repositories/filters.repo';
import { sendListingCard } from '../../../services/notifier';
import { formatBedroomsLabel } from '../keyboards/filter.keyboard';
import { buildPriceRangeLabel } from './filters.handler';
import type { NLSearchCriteria } from '../../../services/nl-search.service';

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
      message: '⏳ <b>Слишком много запросов в минуту</b> (максимум 4).\nПожалуйста, подождите минуту перед следующим поиском.',
    };
  }

  if (record.dayTimestamps.length >= 20) {
    return {
      allowed: false,
      message: '⏳ <b>Превышен дневной лимит запросов</b> (20 в сутки).\nПопробуйте воспользоваться кнопками пошагового поиска или картой Mini App.',
    };
  }

  record.minuteTimestamps.push(now);
  record.dayTimestamps.push(now);
  return { allowed: true };
}

// ─── Render AI Result Card ───────────────────────────────────────────────────

function renderCriteriaMessage(criteria: NLSearchCriteria, matchingCount: number): { text: string; keyboard: InlineKeyboard } {
  const cityLabel = criteria.city === 'phnom_penh' ? '🏙 Пномпень' : '🌴 Сиемреап';
  const typeLabel = criteria.type === 'sale' ? '🏷️ Продажа' : '🏠 Аренда';
  const categoryLabel = criteria.category ? ` (${criteria.category})` : '';

  const minCents = criteria.min_price ? criteria.min_price * 100 : null;
  const maxCents = criteria.max_price ? criteria.max_price * 100 : null;
  const budgetStr = buildPriceRangeLabel(minCents, maxCents);

  const bedsStr = criteria.bedrooms && criteria.bedrooms.length > 0 ? formatBedroomsLabel(criteria.bedrooms) : 'Любое';

  let extraLines = '';
  if (criteria.requires_pool) extraLines += '\n• <b>Бассейн:</b> 🏊 Обязательно';
  if (criteria.pet_friendly) extraLines += '\n• <b>Питомцы:</b> 🐾 Pet-friendly';
  if (criteria.location) extraLines += `\n• <b>Район:</b> 📍 ${criteria.location}`;
  if (criteria.primary_landmark) extraLines += `\n• <b>Ориентир:</b> 🚩 ${criteria.primary_landmark}`;
  if (criteria.min_lease_preferred) extraLines += `\n• <b>Срок аренды:</b> от ${criteria.min_lease_preferred} мес.`;

  let unindexedLine = '';
  if (criteria.unindexed_features && criteria.unindexed_features.length > 0) {
    unindexedLine = `\n• <b>Пожелания:</b> ✨ ${criteria.unindexed_features.join(', ')}`;
  }

  const text =
    `🎯 <b>Параметры поиска распознаны:</b>\n\n` +
    `• <b>Город:</b> ${cityLabel}\n` +
    `• <b>Тип:</b> ${typeLabel}${categoryLabel}\n` +
    `• <b>Бюджет:</b> ${budgetStr}\n` +
    `• <b>Спальни:</b> ${bedsStr}` +
    extraLines +
    unindexedLine +
    `\n\n📦 <i>В базе прямо сейчас: <b>${matchingCount}</b> подходящих объектов</i>`;

  const kb = new InlineKeyboard();

  if (matchingCount > 0) {
    kb.text(`🔍 Показать ${matchingCount} вариантов`, 'cb:ai:show').row();
  }
  kb.text('✅ Сохранить этот алерт', 'cb:ai:save').row();
  kb.text('✏️ Настроить ползунками', 'cb:ai:edit')
    .text('🔄 Новый запрос', 'cb:ai:reset');

  return { text, keyboard: kb };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createNLSearchHandler(container: AppContainer): Composer<MyContext> {
  const handler = new Composer<MyContext>();

  // ── 1. Voice Notes Handler ──────────────────────────────────────────────────
  handler.on('message:voice', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    // Check voice duration before downloading
    const voice = ctx.message.voice;
    if (voice.duration > 30) {
      await ctx.reply(
        `⏱ <b>Голосовое сообщение слишком длинное</b> (${voice.duration} сек., максимум 30 сек.).\n\n` +
          `Пожалуйста, запишите короткий голосовой запрос, например:\n` +
          `<i>«Ищу 1-комнатную квартиру с бассейном в Сиемреапе до 400$»</i>`,
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
        await ctx.reply('⚠️ Не удалось загрузить аудиосообщение из Telegram. Попробуйте ещё раз.');
        return;
      }

      const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
      const res = await fetch(fileUrl);
      if (!res.ok) {
        await ctx.reply('⚠️ Ошибка скачивания аудио. Попробуйте текстовый ввод.');
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
      await ctx.reply('⚠️ Произошла ошибка при распознавании голосового сообщения. Пожалуйста, попробуйте написать текстом.');
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
        `⚠️ <b>Текст запроса слишком длинный</b> (${text.length} симв., максимум 350).\n\n` +
          `Пожалуйста, опишите основные параметры кратко (город, тип жилья, бюджет, пожелания).`,
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
    const draft = ctx.session.filterDraft;
    const from = ctx.from;
    if (!from || !draft) {
      await ctx.answerCallbackQuery('Сессия истекла. Повторите запрос.');
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
      limit: 3,
      offset: 0,
    });

    if (results.items.length === 0) {
      await ctx.reply('😔 Подходящих объектов прямо сейчас не найдено в базе. Сохраните алерт, чтобы получить уведомление при появлении!');
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
      await ctx.reply(`📥 <b>Ещё ${remaining} подходящих объектов в базе</b>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text(`📥 Показать ещё 3 объекта (осталось ${remaining})`, `cb:ai:more:3`)
          .row()
          .text('✅ Сохранить этот алерт', 'cb:ai:save')
          .text('🛠 Мои фильтры', 'cb:menu:filters'),
      });
    } else {
      await ctx.reply(
        `🏁 <b>Вы посмотрели все найденные объекты (${results.total}).</b>\n\n` +
          `Нажмите <b>[ ✅ Сохранить этот алерт ]</b>, чтобы новые объекты приходили вам сразу при публикации!`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Сохранить этот алерт', 'cb:ai:save')
            .row()
            .text('🔙 Главное меню', 'cb:menu:main'),
        },
      );
    }
  });

  handler.callbackQuery(/^cb:ai:more:(\d+)$/, async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const offset = parseInt(ctx.match[1]!, 10);
    const draft = ctx.session.filterDraft;

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
      await ctx.reply(`📥 <b>Ещё ${remaining} подходящих объектов в базе</b>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text(`📥 Показать ещё 3 объекта (осталось ${remaining})`, `cb:ai:more:${nextOffset}`)
          .row()
          .text('✅ Сохранить этот алерт', 'cb:ai:save')
          .text('🛠 Мои фильтры', 'cb:menu:filters'),
      });
    } else {
      await ctx.reply(
        `🏁 <b>Вы посмотрели все подходящие объекты (${results.total}).</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Сохранить этот алерт', 'cb:ai:save')
            .row()
            .text('🔙 Главное меню', 'cb:menu:main'),
        },
      );
    }
  });

  handler.callbackQuery('cb:ai:save', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const draft = ctx.session.filterDraft;
    if (!draft || !draft.type || !draft.city) {
      await ctx.answerCallbackQuery('❌ Параметры поиска не найдены. Повторите запрос.');
      return;
    }

    const user = container.usersRepo.findByTelegramId(from.id);
    if (!user) {
      await ctx.answerCallbackQuery('❌ Пользователь не найден.');
      return;
    }

    const activeCount = container.filtersRepo.countUserActiveFilters(user.id);
    if (activeCount >= MAX_USER_FILTERS) {
      await ctx.answerCallbackQuery({
        text: `⚠️ Лимит ${MAX_USER_FILTERS} фильтров исчерпан. Удалите старый фильтр!`,
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

    await ctx.answerCallbackQuery('✅ Алерт сохранён!');
    await ctx.reply(
      `✅ <b>Поисковый алерт успешно сохранён!</b>\n\n` +
        `🔔 Бот будет автоматически мониторить все новые объявления в Khmer24 и группах Facebook и присылать подходящие варианты прямо сюда.`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🛠 Управление фильтрами', 'cb:menu:filters')
          .row()
          .text('🔙 Главное меню', 'cb:menu:main'),
      },
    );
  });

  handler.callbackQuery('cb:ai:edit', async (ctx) => {
    await ctx.answerCallbackQuery();
    // Move user into wizard to fine-tune budget or other fields
    ctx.session.wizardStep = 'filter:budget';
    await ctx.reply(
      `✏️ <b>Настройка параметров</b>\n\n` +
        `Текущий бюджет: <b>${buildPriceRangeLabel(
          ctx.session.filterDraft.min_price ? ctx.session.filterDraft.min_price * 100 : null,
          ctx.session.filterDraft.max_price ? ctx.session.filterDraft.max_price * 100 : null,
        )}</b>\n\n` +
        `Отправьте новую сумму или диапазон (например <code>250-450</code> или <code>300</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('◀️ Оставить как есть', 'cb:filter:pool')
          .text('❌ Отмена', 'cb:filter:cancel'),
      },
    );
  });

  handler.callbackQuery('cb:ai:reset', async (ctx) => {
    ctx.session.wizardStep = 'idle';
    ctx.session.filterDraft = { locations: [] };
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🎙 <b>Готов к новому запросу!</b>\n\n` +
        `Запишите голосовое сообщение (до 30 сек) или напишите текстом, какое жильё вы ищете.\n\n` +
        `<i>Например: «Ищу квартиру с бассейном в Сиемреапе до 400$»</i>`,
      { parse_mode: 'HTML' },
    );
  });

  return handler;
}

// ─── Helper: Handle Criteria Result ──────────────────────────────────────────

async function handleSearchCriteriaResult(ctx: MyContext, criteria: NLSearchCriteria): Promise<void> {
  if (!criteria.is_real_estate_query) {
    await ctx.reply(
      `🤖 <b>Я виртуальный помощник HomEasy</b>\n\n` +
        `Я умею мгновенно настраивать поиск жилья в <b>Сиемреапе</b> и <b>Пномпене</b> по вашим голосовым или текстовым запросам.\n\n` +
        `💡 <b>Попробуйте сказать или написать:</b>\n` +
        `• <i>«Ищу 1-комнатную квартиру с бассейном в Сиемреапе до 400$»</i>\n` +
        `• <i>«Студия в центре Пномпеня на полгода, можно с кошкой»</i>\n` +
        `• <i>«Дом с 3 спальнями в Wat Bo от 500 до 800 долларов»</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🛠 Пошаговый фильтр', 'cb:menu:new_filter')
          .row()
          .text('🏠 Главное меню', 'cb:menu:main'),
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
