# HomEasy — Пошаговый план развития

> Статус: черновик плана, составлен на основе анализа переписки с GPT (см. `next steps`) и текущего состояния прототипа.
> Цель: превратить агрегатор объявлений в demand-first matching marketplace для аренды в Камбодже.

---

## Зафиксированный продуктовый поток (2026-10-09)

HomEasy остаётся browse/search-first marketplace: пользователь сначала просматривает и фильтрует реальные объявления. Основное действие в карточке и деталях — **«Мне интересно»**. Оно фиксирует lead и создаёт лёгкую внутреннюю цепочку `Request → Match/Offer → ContactGrant`; после выдачи `ContactGrant` интерфейс открывает Chat и Call. Сбор внешних demand-сигналов остаётся дополнительным каналом привлечения, а не входной точкой основного пользовательского потока.

Это целевой продуктовый контракт для следующего этапа. Текущая интеграционная ветка Phase 6A собирает уже принятый canonical read path и не реализует новый CTA или lifecycle.

---

## 1. Оценка предложений GPT (что принимаем, что отбрасываем)

### Принятые ключевые идеи

1. **Продукт — не «Telegram-бот с объявлениями», а housing matching backend с Telegram-интерфейсом.**
   Главная ценность — соединить реальный запрос арендатора с реально доступным объектом быстрее, чем он сам это делает через Facebook.

2. **Ingestion должен быть заменяемым.**
   Сегодня: Khmer24 + Facebook/Camoufox. Завтра: Apify, Bright Data, agent-submitted, landlord-submitted. Domain logic (matching, UI, notifications, БД) не должна знать, откуда пришёл listing.

3. **SourceOccurrence + freshness history — обязательный фундамент.**
   Без истории появления/исчезновения объявлений невозможны: dedupe, отслеживание цен, понимание реальной доступности, отладка parser'ов. Переделать это позже дорого.

4. **DemandCandidate ≠ Request.**
   Пост «looking for rent» в Facebook — это внешний сигнал. Он проходит AI-разбор, matching, human review. Только после перехода пользователя по персональной ссылке и подтверждения создаётся настоящий Request.

5. **Domain tracking gateway — часть базовой архитектуры, не nice-to-have.**
   Все внешние ссылки идут через `https://domain.com/r/<id>`, фиксируют source/group/post/timestamp/request, затем редиректят в Telegram Mini App. Это даёт полную цепочку attribution: reply → click → Telegram open → Request confirmed → alert permission → listing opened → contact/offer.

6. **Analytics с первого дня.**
   Нужны события по всей воронке спроса и предложения, чтобы принимать решения на данных, а не на ощущениях.

7. **Admin notifications — отдельный слой.**
   Ежедневный digest + событийные alerts в Telegram. Не заставлять себя лазить в Grafana/Metabase каждый день.

8. **Telegram-first остаётся.**
   Не строить public Web App и WhatsApp из страха потерять пользователей. Сначала измерить реальный отвал между domain click и Telegram open. Если отвал маленький — веб не нужен. WhatsApp — в бэклог.

9. **Ранний агентский пилот с 3 существующими агентами.**
   Один кхмерский агент (знакомый) + два русскоязычных/англоязычных. Подключаются уже на первых реальных Requests, не ждём 100 пользователей. Формат: invite-only, бесплатно, цель — получить поведенческие данные.

10. **Offer — базовая сущность.**
    Не просто «агент видит lead», а `Agent → Listing → Offer → Request` со своей ценой, условиями, availability, notes. Это создаёт data graph, который со временем становится moat.

11. **Монетизация начинается после доказанной ценности.**
    Первые closed loops — бесплатно. Первый pricing test: Agent Pro / pay-per-qualified-lead. Не renter premium, не commission split.

12. **Инфраструктура остаётся дешёвой.**
    Mac сейчас; mini-PC дома при первых признаках жизни. Docker Compose, Postgres, workers, scraper containers, bot, API, cloudflared. Обязательный внешний backup БД.

### Что не принимаем / откладываем

- Полноценный public Web App на старте.
- WhatsApp.
- Сложную верификацию агентов, KYC, escrow, contracts.
- Commission/success fee до legal-проверки в Камбодже.
- Микросервисы, Kubernetes, собственная proxy-инфраструктура.
- Автоматический Facebook demand outreach (пока human review).

---

## 2. Архитектурные принципы

### Главная метафора продукта

```
NOW:
Facebook ──────┐
Khmer24 ───────┼──→ HomEasy platform
               │
LATER:
Facebook ──────┐
Khmer24 ───────┤
Agents ────────┤
Landlords ─────┼──→ HomEasy platform
Renters ───────┤
Referrals ─────┤
SEO/Web ───────┘

EVEN LATER:
HomEasy marketplace
        ↑
agents + landlords upload because
        the renters are already there
```

### Интерфейсы и уровни ответственности

- **SourceAdapter**: `fetchNewItems()`, `getItem()`, `normalize()`, `healthCheck()`. Реализации: `Khmer24Adapter`, `FacebookCamoufoxAdapter`, позже `FacebookApifyAdapter`, `AgentSubmittedAdapter`, `LandlordSubmittedAdapter`.
- **Canonical Listings**: Property + Listing + ListingSourceOccurrence. Один объект может иметь несколько источников с разными ценами.
- **Demand**: DemandCandidate → Request. DemandCandidate — внешний сигнал; Request — подтверждённая потребность пользователя.
- **Matching**: deterministic hard constraints → availability → budget/location/bedrooms → soft preference scoring → freshness → trust → agent responsiveness. LLM только на этапе parsing/soft features.
- **Agent workflow**: Request → Offer → Renter view → Contact unlock. Контакт арендатора скрыт до его согласия.
- **Monetization**: supply бесплатен; платим за доступ к demand и инструменты вокруг него.

### Минимальная data model

```
Search (сохранённый фильтр пользователя)
Request (конкретная потребность, lifecycle + expires_at)
DemandCandidate (внешний сигнал, confidence, human_review_status)
Property (физический объект)
Listing (конкретное предложение Property)
ListingSourceOccurrence (источник, external_id, source_url, first_seen_at, last_seen_at, last_checked_at, raw_hash, raw_payload, parser_version, price_seen, status)
Agent (профиль, уровни верификации, response stats)
Match (Request ↔ Listing, score, reasons)
Offer (Agent → Listing → Request, price, availability, terms, notes, timestamps)
ContactGrant (пользователь разрешил раскрыть контакт агенту)
Event (analytics events: source, campaign, group, request_id, user_id, listing_id, agent_id)
```

### Privacy / data minimization

- Не хранить голосовые сообщения после transcription без явной причины.
- Не раздавать scraped Facebook demand агентам без opt-in.
- Не называть человека из Facebook «lead» до подтверждения Request.
- Минимизировать PII в логах.

---

## 3. Стадии дорожной карты

### Стадия 0. Текущий прототип (Done / WIP)

**Что уже есть:**
- Khmer24 scraper.
- Facebook/Camoufox scraper.
- AI voice/text parser.
- Telegram Bot + Mini App.
- База данных, backend, Docker Compose.

**Цель:** технический pipeline работает.

### Стадия 1. Фундамент данных и наблюдаемость

**Цель:** превратить скрейпинг в надёжное ядро данных и получить visibility.

**Действия:**
1.1. Ввести `SourceAdapter` интерфейс и рефакторить Khmer24 + Facebook scraper'ы под него.
1.2. Создать таблицу `listing_source_occurrences` с полями:
      - `source` (khmer24, facebook, agent, landlord)
      - `external_id`
      - `source_url`
      - `first_seen_at`, `last_seen_at`, `last_checked_at`
      - `raw_hash`, `raw_payload`
      - `parser_version`
      - `price_seen`
      - `status` (active, removed, stale, duplicate)
1.3. Реализовать dedupe на основе хешей + canonical property (адрес/координаты/здание + bedrooms + rough price).
1.4. Добавить freshness scoring: just scraped = high, 3 days = good, 14 days = demote, 30 days = probably stale, agent confirmed today = boost.
1.5. Поднять domain tracking gateway:
      - роут `/r/:slug`
      - запись event `tracking_link_clicked` с source/group/post/request_id
      - редирект в Telegram Mini App через `https://t.me/YourBot/yourapp?startapp=<request_id>`
      - fallback: если Telegram не открылся — показать landing с кнопкой.
1.6. Внедрить event analytics: таблица/сервис `events` с полями `event_type`, `source`, `campaign`, `group_id`, `post_id`, `request_id`, `user_id`, `listing_id`, `agent_id`, `metadata`, `created_at`.
1.7. Сделать admin Telegram notifications:
      - Ежедневный digest (новые listings, demand candidates, confirmed requests, unique renters, клики по ссылкам, conversion click → Telegram → Request, requests без matches, agent offers, среднее время первого offer).
      - Real-time alerts: новый горячий Request без подходящих listings за 30 минут, scraper упал 3 раза подряд, агент ответил на первый lead, первый подтверждённый rental, аномалия в конверсии.
1.8. Подключить внешний backup БД (nightly pg_dump → encrypted → R2 / другой диск).

**Decision gate:**
- Можем ли мы доверять freshness и dedupe? (target: <5% false duplicates, <10% stale listings marked active)
- Есть ли полная цепочка attribution от reply до Request?

### Стадия 2. Захват спроса (DemandCandidate)

**Цель:** научиться находить и разбирать посты арендаторов в Facebook.

**Действия:**
2.1. Расширить Facebook scraper/classifier: помимо `FOR RENT` распознавать `LOOKING_FOR_RENT`.
2.2. AI-pipeline для demand:
      - raw post → classifier (housing demand?)
      - extract request: city, budget_min/max, move_in, lease_months, bedrooms, amenities (wifi, pool, pet), confidence.
      - store as `DemandCandidate` со статусом `pending_review`.
2.3. Human review loop: система присылает тебе в Telegram карточку кандидата с 8 matches и кнопками [Approve & Send Link] [Edit] [Ignore].
2.4. После approve генерировать персональную domain-ссылку `domain.com/r/<request_id>` с сообщением в Facebook: «I found 8 places matching what you described. See them here: <link>».
2.5. При переходе по ссылке фиксировать `tracking_link_clicked`, редирект в Mini App, показывать предзаполненный Request с кнопками [Looks right] [Edit].
2.6. При подтверждении в Mini App создавать настоящий `Request` и просить `requestWriteAccess()` для уведомлений.

**Decision gate:**
- Из 50–100 обработанных demand posts: сколько кликов по ссылке? сколько подтверждений? Если почти никто не кликает — меняем outreach/value proposition. Если кликают, но падают на Telegram — рассматриваем Web App.

### Стадия 3. Request lifecycle и Telegram deep links

**Цель:** Request становится полноценной сущностью с жизненным циклом.

**Действия:**
3.1. Статусы Request: `draft`, `confirmed`, `active`, `paused`, `fulfilled`, `expired`, `cancelled`.
3.2. `expires_at` — запрос «с 20 октября» 15 ноября уже не lead.
3.3. Matching engine: hard constraints → availability → budget/location/bedrooms → soft preferences → freshness → trust.
3.4. Telegram notifications: new matches, price changes, listing removed, reminder before expiry.
3.5. В Mini App: страница Request, список matches, сохранение, запрос контакта.

**Decision gate:**
- Пользователи возвращаются по alerts? (retention loop найден)
- Requests получают ≥3 релевантных варианта? (Request Coverage Rate)

### Стадия 4. Пилот с 3 агентами (invite-only)

**Цель:** проверить, могут ли агенты закрывать пробелы scraped inventory.

**Действия:**
4.1. Добавить роли: `RENTER`, `AGENT`, `ADMIN`. Allowlist для первых агентов.
4.2. Минимальный Agent UI (Telegram / Mini App):
      - [Offer listing] — предложить существующий listing из базы.
      - [Add property] — добавить новый объект (ручно/через форму).
      - [Ignore] — пропустить Request.
4.3. Агент видит структурированный Request, но НЕ видит контакт арендатора.
4.4. Offer создаётся со своей ценой, условиями, availability, notes.
4.5. Renter получает Offer в Mini App: [Shortlist] [Decline] [Request contact].
4.6. Contact unlock: renter нажимает [Request contact] → система спрашивает подтверждение → создаётся `ContactGrant` → агент видит контакт.

**Decision gate (после 10–20 реальных Requests):**
- Агенты вообще отвечают? Среднее время ответа?
- Предлагают ли в рамках бюджета/района?
- Реально ли их объекты доступны?
- Покрывают ли дырки, которых нет в scraped inventory?

### Стадия 5. Монетизация (Agent Pro / pay-per-qualified-lead)

**Цель:** получить первые реальные деньги после доказанной ценности.

**Действия:**
5.1. Определить пакет Agent Pro:
      - Free: 5 listings, basic profile, manual request feed, limited offers.
      - Pro ($19–29/month beta): unlimited/larger inventory, instant hot-request alerts, more active requests matched to inventory, saved lead filters, availability tools, request history, analytics, priority notifications.
5.2. Pay-per-qualified-lead как альтернатива/гибрид:
      - Free agent: $3–5 за accepted introduction.
      - Pro: 10 leads included, дальше дешевле.
5.3. Ручная оплата через KHQR → admin переключает `plan`/`paid_until`. Автоматизация — только когда ручная обработка начнёт мешать.
5.4. Не продавать размещение inventory. Featured listings только как дополнительная опция позже и с явной меткой «Sponsored», отдельно от «Best Match».

**Decision gate:**
- Агенты сами спрашивают «а когда следующий запрос?» / «можно мне такие сразу?»
- Есть ли 20–50 качественных Requests в месяц?
- Можем ли получить $100–500 MRR?

### Стадия 6. Liquidity engine

**Цель:** marketplace начинает систематически закрывать запросы.

**Действия:**
6.1. Agent alerts: instant уведомления о новых Request, подходящих под их inventory.
6.2. Availability confirmation: агенты подтверждают, что listing всё ещё доступен;TTL для stale listings.
6.3. Agent rankings: response rate, median response time, accepted offers, renter rating.
6.4. ContactGrant как отдельная сущность и бизнес-логика.
6.5. Weekly founder report с аномалиями и рекомендациями (например, «Requests <$300 выросли на 38%, но coverage упал до 24%»).

**Decision gate:**
- Request Coverage Rate ≥70%?
- Time to First Good Match <X часов?
- Time to First Qualified Offer <Y часов?

### Стадия 7. Собственный supply

**Цель:** снизить зависимость от scraping.

**Действия:**
7.1. Улучшенный Agent UI для добавления inventory.
7.2. Landlord-submitted listings (позже).
7.3. Проверка, что агенты/владельцы сами загружают объекты, потому что арендаторы уже на платформе.

### Стадия 8. Расширение geography

**Цель:** проверить переносимость модели.

**Действия:**
8.1. Phnom Penh как следующий рынок.
8.2. Kampot, Sihanoukville, Battambang — позже.
8.3. Для каждого города — сначала scraper + demand, потом agents.

### Стадия 9. B2B и analytics

**Цель:** монетизировать собственные данные.

**Действия:**
9.1. Demand Analytics Dashboard для агентов: распределение по бюджетам, районам, unmet demand.
9.2. Agency workspace / mini-CRM: shared inventory, lead routing, SLA, team members.
9.3. Pricing tiers: Solo $29, Agency $99, Agency Plus $199 (иллюстративно).
9.4. Developer campaigns (при выходе в продажи/condo).

### Стадия 10. Transaction layer (очень позже)

**Цель:** booking / deposit / contracts.

**Действия:**
10.1. Только после legal-проверки в Камбодже.
10.2. Не брать custody денег, не подписывать договоры за стороны без лицензии.
10.3. Возможно: concierge/verified viewing service.

---

## 4. Ближайшие действия (ближайшие 2–4 недели)

### Неделя 1: SourceAdapter + SourceOccurrence
- [ ] Определить интерфейс `SourceAdapter`.
- [ ] Рефакторить Khmer24 scraper под SourceAdapter.
- [ ] Рефакторить Facebook/Camoufox scraper под SourceAdapter.
- [ ] Создать миграцию `listing_source_occurrences`.
- [ ] Заполнить историю для существующих listings (first_seen_at = now, last_seen_at = now).
- [ ] Реализовать dedupe pipeline.

### Неделя 2: Domain tracking gateway + Analytics
- [ ] Зарегистрировать/настроить домен (если ещё не сделано).
- [ ] Реализовать endpoint `/r/:slug`.
- [ ] Создать таблицу `events` и сервис `EventService`.
- [ ] Подключить генерацию domain-ссылок для всех внешних outbound (Facebook replies, Telegram sharing).
- [ ] Добавить базовые события: `tracking_link_clicked`, `miniapp_opened`, `request_confirmed`, `notifications_allowed`, `listing_opened`, `listing_saved`, `contact_requested`.

### Неделя 3: Admin notifications
- [ ] Создать `AdminNotificationService` (Telegram bot для админа).
- [ ] Ежедневный digest в 09:00.
- [ ] Real-time alerts на критичные события.
- [ ] Добавить команды `/stats`, `/digest` для ручного запроса.

### Неделя 4: DemandCandidate foundation
- [ ] Добавить classification в Facebook scraper: `FOR_RENT` vs `LOOKING_FOR_RENT`.
- [ ] AI pipeline для извлечения demand-полей.
- [ ] Создать таблицу `demand_candidates`.
- [ ] Human review UI в Telegram для админа.
- [ ] Approve → generate domain link → send Facebook reply.

**После этого:** запустить пилот demand capture и собирать метрики 1–2 недели.

---

## 5. Метрики и decision gates

### North star (пилот)

- **Request Coverage Rate**: % confirmed Requests, получивших ≥3 релевантных и реально доступных варианта за X времени.
- **Time to First Good Match**: от confirmed Request до показа 3 хороших matches.
- **Time to First Qualified Offer**: когда появляются агенты.

### Воронка demand

```
Demand candidate discovered
↓ Outbound reply sent
↓ Link clicked
↓ Telegram opened
↓ Request confirmed
↓ Write access granted
↓ First matching listing shown
↓ Listing opened
↓ Saved
↓ Contact requested
↓ Agent offer received
↓ Offer opened
↓ Contact unlocked
↓ Viewing
↓ Rented
```

### Воронка supply

- listing age
- last seen
- availability confirmed
- duplicate rate
- agent response time
- agent response rate
- offer rejection rate

### Diagnostic matrix

| Симптом | Что означает |
|---|---|
| Мало кликов по персональной ссылке | Плохой outreach/value proposition |
| Кликают, но падают на Telegram | Нужен Web App |
| Telegram не мешает | Web отложить |
| Requests есть, inventory нет | Фокус на supply |
| Inventory есть, но stale | Freshness problem |
| Агенты дают хорошие варианты быстро | Очень сильный сигнал |
| Агенты игнорируют Requests | Менять agent model |
| Пользователи возвращаются по alerts | Найден retention loop |

---

## 6. Монетизация: сводная таблица

| Модель | Когда | Потенциал | Статус |
|---|---|---|---|
| Agent Pro subscription | рано | $$$ | основная |
| Pay per qualified lead | рано/средне | $$$ | очень интересная |
| Contact unlock | рано/средне | $$ | вариант lead fee |
| Featured / Sponsored listings | когда есть трафик | $$ | дополнительная, с меткой |
| Featured Agent | когда есть трафик | $$ | дополнительная |
| Agency Team / CRM | позже | $$$$ | очень хорошая B2B |
| Demand analytics | позже | $$$$ | потенциально сильная |
| Developer campaigns | после масштабирования | $$$$ | продажи condo |
| Renter Premium / Concierge | позже | $$ | осторожно |
| Referral ecosystem | средне | $$ | ancillary revenue |
| Success fee / commission share | позже | $$$$ | только после legal |
| Transaction / booking fee | сильно позже | $$$$ | только после legal |

**Правило:** сначала бесплатно для агентов, пока не появится доказанная ценность. Первый pricing test — Agent Pro $19–29/мес или $3–5 за qualified lead.

---

## 7. Инфраструктура и операции

### Сейчас

- Mac, Docker Compose, Postgres, local development.
- Facebook scraper на residential IP.
- Telegram Bot + Mini App.

### При первых признаках жизни

- Mini PC (Linux) дома, 24/7.
- Docker Compose:
  - api
  - telegram-bot
  - worker
  - scheduler
  - postgres
  - redis (при необходимости)
  - facebook-scraper
  - khmer24-scraper
  - cloudflared
- Cloudflare Tunnel для inbound traffic.
- Nightly pg_dump → encrypted → R2 / другой диск.

### Backup

- Не HA, не Kubernetes.
- Просто: `pg_dump` → encrypt → somewhere else.
- Cloudflare R2 free tier (10 GB-month, free egress) или второй локальный диск.

### Proxy / Facebook scraping

- Продолжать использовать домашний Cambodian residential IP, пока работает.
- Если Camoufox начнёт отваливаться — переключиться на Apify/Bright Data как commodity ingestion.
- Никогда не запускать Playwright/Puppeteer с proxy без `attachTrafficGuard` (см. `AGENTS.md`).
- Не переносить scraping в cloud только ради «красивой схемы».

---

## 8. Юридические и privacy-ограничения (Камбоджа)

- Раннее позиционирование: software platform / advertising / matching / SaaS for agents, а не real-estate agency.
- Не принимать rent/deposit, не подписывать договоры за стороны, не брать custody денег без legal-проверки.
- Real Estate Business and Pawnshop Regulator, Prakas No. 064 — лицензирование агентской деятельности. Перед commission/success fee — консультация cambodian real-estate lawyer.
- Cambodian Draft Law on Personal Data Protection (draft, июль 2026) — минимизация данных, не хранить audio без причины, не раздавать scraped demand без opt-in.
- Featured/Verified — продавать promotion, не саму верификацию. Verification = trust.

---

## 9. Что НЕ делаем сейчас

- [ ] WhatsApp
- [ ] Native iOS/Android
- [ ] Полноценный CRM для агентов
- [ ] Payments / rent collection
- [ ] KYC
- [ ] Escrow
- [ ] Contracts
- [ ] Automatic viewing scheduling
- [ ] Sophisticated reputation system
- [ ] Microservices
- [ ] Kubernetes
- [ ] Собственная proxy infrastructure
- [ ] Миллионы scraped listings
- [ ] Сложный semantic vector search
- [ ] Автоматический Facebook demand outreach без human review
- [ ] Public Web App без данных об отвале Telegram

---

## 10. Связанные файлы

- `AGENTS.md` — правила работы с Camoufox, residential proxy, scraping.
- `MONETIZATION.md` — существующий черновик монетизации (будет дополняться).
- `HOMEASY_LOG.md` — лог реализации этого плана.
- `next steps` — исходная переписка с GPT.

---

*Последнее обновление: 2026-10-06*
