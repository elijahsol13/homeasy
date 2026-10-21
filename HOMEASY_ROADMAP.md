# HomEasy — Пошаговый план развития

> Статус: долгосрочная продуктовая гипотеза. Нижеприведённый план от 2026-10-14 является историческим: canonical cutover фактически завершён 2026-10-16, а отдельные этапы уже выполнены или изменены. Текущий порядок, состояние и разрешения — только в `agent_docs/project_progress.md` и `agent_docs/decisions.md` (срез 2026-10-21). Не интерпретировать старые пункты как новые задачи.
> Цель: превратить агрегатор объявлений в demand-first matching marketplace для аренды в Камбодже.

---

## 0. Принятый порядок реализации (2026-10-14)

1. **Стабилизировать текущую систему на MacBook / Docker Compose / SQLite:** регрессии, восстановление БД из backup, защита данных, наблюдаемость, основные UX-исправления Mini App.
2. **Довести canonical до полноценного источника чтения** во всех клиентских сценариях: список/фильтры/карта/детали/избранное/модерация/трекинг. Проверить паритет, пройти canary, затем переключить global read path с возможностью отката.
3. **После переключения canonical read path** получить небольшой свежий набор через источники по очереди и оценить реальные карточки, исходный текст, идентичность, доступность и качество попадания в инвентарь. Использовать старые записи только как временные UX/потоковые фикстуры; не вычищать их вручную.
4. **Затем отдельно решить, нужен ли полный сброс устаревшего инвентаря.** Если да, сохранить и проверить локальный recovery snapshot вне автоматической ротации, отрепетировать восстановление, утвердить точную область удаления, сохранить пользовательские/аналитические/атрибуционные данные и только потом последовательно наполнить базу актуальными объявлениями. S3 появится на следующем этапе; для MVP владелец принимает локальное хранение и потерю до 24 часов данных. Полный сброс **отложен** и сейчас не разрешён.
5. **Развивать самостоятельный public Web App параллельно с Telegram Mini App**, используя общий API, модели и по возможности единый React frontend; доступ без Telegram обязателен. Авторизация, ссылки и privacy должны поддерживать обе точки входа.
5. Затем расширять demand-first marketplace (Requests, Offers, агентский пилот) по измеримым воротам нижеприведённых стадий, не раньше стабилизации и заполнения актуальными объявлениями.

Открытые задачи: замер холодной загрузки и задержек UI; нагрузочный тест API при 500–1000 зарегистрированных пользователях с явным указанием числа одновременных запросов; дешёвый постоянно работающий сервер после MVP; анализ накопленных Facebook/Bright Data данных для новых бизнес-идей позднее. Не переносить браузерный Facebook fingerprint/session с macOS на Linux без нового attended login (см. `AGENTS.md`).

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

8. **Telegram Mini App и public Web App развиваются параллельно.**
   Web App должен открываться независимо от Telegram на общей бизнес-логике и API. Измерять потери в воронке domain click → Telegram open → Request, но не ставить web-доступ в зависимость от этого эксперимента. WhatsApp — в бэклог.

9. **Ранний агентский пилот с 3 существующими агентами.**
   Один кхмерский агент (знакомый) + два русскоязычных/англоязычных. Подключаются уже на первых реальных Requests, не ждём 100 пользователей. Формат: invite-only, бесплатно, цель — получить поведенческие данные.

10. **Offer — базовая сущность.**
    Не просто «агент видит lead», а `Agent → Listing → Offer → Request` со своей ценой, условиями, availability, notes. Это создаёт data graph, который со временем становится moat.

11. **Монетизация начинается после доказанной ценности.**
    Первые closed loops — бесплатно. Первый pricing test: Agent Pro / pay-per-qualified-lead. Не renter premium, не commission split.

12. **Инфраструктура остаётся дешёвой.**
    Сейчас MacBook + Docker Compose + **SQLite (WAL)**, отдельные bot, scraper и API containers, cloudflared. Следующий этап после MVP — недорогой постоянно работающий сервер под SSH; миграция на Postgres не принята и потребует отдельного обоснования. Для MVP обязательны локальные проверяемые SQLite snapshots, контроль свежести и репетиция восстановления; внешнее S3-хранилище — отдельный последующий этап. Допустимая потеря данных на MVP — до 24 часов.

### Что не принимаем / откладываем

- Отдельный второй backend или дублирование продукта для public Web App.
- WhatsApp.
- Сложную верификацию агентов, KYC, escrow, contracts.
- Commission/success fee до legal-проверки в Камбодже.
- Микросервисы и Kubernetes.
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

**Примечание к первоначальному дизайну:** этот список описывает целевые контракты, а не отсутствие реализации. В текущем дереве уже существуют `canonical_listing_source_occurrences`, ingest adapters, tracking route, snapshot-сервис и админ-уведомления. Их полноту и совместимость проверять по коду и тестам; ближайшие критерии — в разделе 4.

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
1.8. MVP: запускать независимый локальный backup-процесс (`VACUUM INTO` → проверка целостности → атомарная публикация) каждые 12 часов, контролировать возраст снимка ≤24 часов и проверить восстановление на отдельном экземпляре. После MVP: шифрованная выгрузка проверенных snapshot-файлов в S3/другое удалённое хранилище и репетиция удалённого восстановления.

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
- Из 50–100 обработанных demand posts: сколько кликов по ссылке? сколько подтверждений? Если почти никто не кликает — меняем outreach/value proposition. Если кликают, но падают на Telegram — оптимизируем переход в Web App, который развивается независимо от этого эксперимента.

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

## 4. Ближайшие действия: технические ворота, без привязки к календарным неделям

Актуальная последовательность и ответственные файлы — в `agent_docs/project_progress.md`. Прежний недельный план SourceAdapter → tracking → demand был сформулирован до появления части canonical/occurrence/tracking-кода и больше не является списком нерешённых задач: реализацию проверяем по исходникам.

### Ворота A: резервное восстановление и стабильность
- [x] Автоматический тест создания и восстановления SQLite snapshot на изолированных файлах.
- [x] Отдельный Compose `backup` worker работает на MacBook: каждые 12 часов, повтор при ошибке через 30 минут, 21 локальный snapshot в общей ротации и health-проверка на возраст ≤24 часов. Первая рабочая копия 14.10.2026 проверена; **второй запланированный 12-часовой цикл ещё не наблюдался**.
- [x] Проверены SHA-256, целостность и запись на **изолированной** восстановленной копии. Реальный API запущен внутри временного Docker-контейнера без сети: 69 legacy / 169 canonical объявлений, 7 / 10 маркеров карты, health/detail/filters/400/404. Отчёты `reports/backup-compose-restore-20261014.json` и `reports/backup-docker-api-and-monitor-20261014.json`.
- [x] Установлен локальный macOS LaunchAgent каждые 30 минут для контроля контейнера и свежести снимков (предупреждение через 18 ч, критический статус через 24 ч). Успешная штатная проверка; реальный сценарий аварийного уведомления/пробуждения Mac ещё не проверен.
- [ ] Подтвердить второй независимый 12-часовой snapshot и корректную доставку предупреждения о сбое; определить RTO. Допуск потери данных на MVP — до 24 часов при работающем Mac.
- [ ] Отрепетировать **полный** остановленный Compose/WAL rollback в согласованное окно с проверкой состояния данных и API после запуска. Тестовый контейнер с restored SQLite не заменяет эту процедуру; глобальный переход на canonical пока запрещён.
- [ ] **После MVP:** шифрование/удалённое хранение S3, независимая ротация и подтверждённый возврат из S3. Это не блокирует локальный MVP.
- [ ] Наблюдаемость и диагностика медленных API-запросов и первоначальной загрузки Mini App.

### Ворота B: готовность canonical
- [x] Тестовая проекция listing GPS в list/map/detail с проверкой географических границ.
- [x] Сравнение 13 сценариев list/search на изолированном снимке реальной SQLite + проверка целостности; отчёт `reports/phase6a-canonical-read-parity-20261014.json`. Выявлены 5 исключений source identity, ожидающих ручного review.
- [x] Канареечная админ-модерация canonical при глобальном legacy: pending-only, `publicRef`, защищённый отказ при снятом объявлении, видимость архива только администратору.
- [x] Канонические уведомления: миграция v55, SQLite outbox и уникальная доставка для каждой пары listing/Telegram ID; первые события старого каталога подавляются, отправки после неопределённого ответа Telegram не повторяются. Проверено изолированными тестами, флаг `CANONICAL_ALERTS_ENABLED` по умолчанию выключен.
- [x] Оффлайн-регрессия tracked deep links: API выбирает фактический read cohort, canonical открывается по `publicRef`/проверенному legacy alias с проверкой видимости, Mini App открывает detail и сохраняет результат при React StrictMode effect replay. Реальный Telegram canary остаётся обязательным.
- [ ] Реальная canary-проверка v55: включение флага в нужных Compose-процессах, один новый approved listing, совпадение фильтра, deep link/callback, обработка остановки/повторного включения и контроль очереди без массовых исторических уведомлений.
- [ ] Паритет с legacy на изолированном снимке реальных данных, включая сортировку, фильтры, карту, избранное, статусы модерации, медиассылки, source IDs и tracking.
- [x] Отдельная метрика покрытия legacy ID → canonical identity по таблице aliases. Отчёт `reports/phase6a-alias-identity-delta-v2-20261014.json`: после шести проверенных Khmer24-алиасов 53→59/69 сопоставлений и 51→57/69 видимых карточек, уникальных canonical объектов по-прежнему 51; семантические URL-совпадения неизменно 62/69. Изолированная репетиция: `reports/phase6a-khmer24-alias-rehearsal-v2-20261014.json`. Рабочая БД не менялась.
- [ ] Исследовать 10 оставшихся Facebook ID (1, 2, 4, 5, 156, 157, 159, 160, 164, 165): точный post ID отсутствует в `source_items` изолированного снимка. Для 2 география недостаточно определена; у 165 **конфликт** между автоматически сгенерированным заголовком (Phnom Penh) и исходным текстом (ориентиры Siem Reap / Pub Street), поэтому старое `INTENTIONALLY_EXCLUDED` нельзя считать окончательным. Восемь остальных имеют подсказки о Siem Reap, но требуют проверки источника, свежести и дубликатов. Khmer24 197 подтверждён по adid, ранее привязанному sibling 182, совпадающим title/bedrooms и текущим canonical полям; алиас отрепетирован офлайн.
- [ ] Закрыть исторические исключения source identity: 22/19/12 уже проверены в изолированном ремонте алиасов; 2 требует географического подтверждения, 165 — проверки противоречивого источника, восемь Facebook ID — ручного source triage. Отдельно проверить канонические уведомления, совпадение подписок и deep-links на реальных Telegram canary.
- [ ] Тесты производительности, пользовательский canary и сбор ошибок/расхождений.
- [ ] Ручная проверка отката и утверждение глобального `LISTING_READ_PATH=canonical`.

### Ворота C: клиенты и свежесть данных
- [ ] Публичный Web App независимо от Telegram: загрузка, карточки, контакты, избранное/авторизация, внешние ссылки.
- [x] Первый этап code splitting: `MapView` загружается при открытии карты; PostHog вынесен в отдельный асинхронный модуль. Стартовый JS chunk сокращён с **737.90 КБ (223.58 КБ gzip)** до **308.51 КБ (87.81 КБ gzip)** без ключа аналитики, либо **308.76 КБ (87.95 КБ gzip)** с ним. С PostHog отдельный chunk **271.88 КБ (90.23 КБ gzip)**; карта отдельно **158.44 КБ (46.38 КБ gzip)**. События аналитики протестированы офлайн.
- [ ] Измерение медленной первой загрузки Telegram Mini App на реальном устройстве: p50/p95 до первой карточки, network waterfall, JS download/parse и API, проверка доставки аналитических событий при настроенном ключе; затем нагрузочный тест при измеряемой конкурентности.
- [ ] После cutover и отдельного решения — архивирование старых объявлений, безопасная выборочная очистка inventory и последовательный запуск источников.

**Затем:** вернуться к demand capture, Requests, Offers и агентскому пилоту из раздела 3.

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
| Кликают, но падают на Telegram | Уменьшить friction; Web App — независимое принятое направление |
| Telegram не мешает | Продолжать Web App в общем frontend/backend по согласованному плану |
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

- MacBook, Docker Compose, SQLite в режиме WAL на общем постоянном томе.
- Отдельные процессы API, Telegram bot и scraping; Cloudflare Tunnel для входящих HTTP-запросов.
- Facebook/Camoufox на закреплённой macOS-идентичности с прямым подключением через интернет хоста; при переезде на Linux — новый корректный профиль и ручная авторизация.
- Telegram Bot + Mini App; public Web App — следующее принятое направление.

### После стабилизации MVP

- Рассмотреть дешёвый постоянно работающий сервер с SSH и Docker Compose, достаточный для измеренной нагрузки; отдельная миграция на Postgres пока не согласована.
- Сохранить SQLite WAL на локальном постоянном томе; не размещать активную БД на ненадёжной общей сетевой файловой системе.
- Facebook при переезде с macOS на Linux требует нового OS-корректного fingerprint и ручной авторизации; бюджет/риски scraping оценить отдельно.

### Backup

- **MVP:** `src/database/backup.ts` делает `VACUUM INTO`, проверяет SQLite и внешние ключи, публикует snapshot атомарно и ротирует 21 локальную копию. `src/database/backup-worker.ts` **развёрнут в рабочем Compose 14.10.2026**, первый свежий snapshot проверен и восстановлен в отдельном окружении с реальным запущенным Docker API. Расписание — каждые 12 часов, повтор через 30 минут при ошибке; второй независимый цикл ещё ожидает проверки. Host LaunchAgent каждые 30 минут контролирует возраст снимка и здоровье worker, отправляет локальные уведомления о проблеме (18 ч предупреждение, 24 ч критический статус), но реальные аварийные уведомления пока не проверены. Полный остановленный Compose/WAL rollback остаётся открытым.
- Перед canonical canary и любым удалением inventory: проверить актуальную локальную резервную копию, отрепетировать восстановление из неё и сохранить отдельную защищённую от ротации контрольную точку. Ориентир по потерям данных — **не более 24 часов**, но без непрерывно работающего MacBook, свободного диска и мониторинга это не гарантия.
- **После MVP:** добавить зашифрованное S3-хранилище проверенных snapshot-файлов, отдельно продумать хранение ключей и удалённую репетицию восстановления. R2/аналог — кандидат, стоимость/лимиты проверить перед выбором. Снимки на том же MacBook не защищают от потери самого диска.

### Домашнее подключение / Facebook scraping

- Использовать прямое интернет-подключение MacBook/Docker, затем домашнего сервера за CGNAT.
- Сохранять существующие фильтры ресурсов `attachTrafficGuard`, закреплённую Camoufox-сессию, ручную авторизацию и safety lock.
- Не менять способ доступа в сеть и инфраструктуру скраперов без обсуждения с владельцем. Если Camoufox перестанет работать, сначала выяснить причину.

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
- [ ] Миллионы scraped listings
- [ ] Сложный semantic vector search
- [ ] Автоматический Facebook demand outreach без human review
- [ ] Public Web App без данных об отвале Telegram

---

## 10. Связанные файлы

- `AGENTS.md` — правила работы с Camoufox, скрапингом и harness-процессом.
- `MONETIZATION.md` — существующий черновик монетизации (будет дополняться).
- `HOMEASY_LOG.md` — лог реализации этого плана.
- `next steps` — исходная переписка с GPT.

---

*Последнее обновление: 2026-10-06*
