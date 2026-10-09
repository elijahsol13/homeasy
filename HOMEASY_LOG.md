# HomEasy — Лог реализации плана

> Это living document. Каждая сессия работы по плану из `HOMEASY_ROADMAP.md` фиксируется здесь.
> Формат записи см. в шаблоне ниже.

---

## Как вести лог

Каждая запись содержит:

- **Дата:** YYYY-MM-DD
- **Стадия / эпик:** например, «Стадия 1: SourceAdapter»
- **Что сделано:** кратко, с ссылками на коммиты/файлы, если есть
- **Решения:** важные architectural/product решения
- **Блокеры / риски:** что остановило или замедлило
- **Метрики / наблюдения:** цифры, конверсии, отклики агентов
- **Следующие шаги:** конкретные задачи на следующую сессию

---

## Записи

### 2026-10-06 — Полный повторный проход 872 сохранённых Bright Data постов

- **Стадия:** corpus-review канонических промтов и AI-каскада; без новых запросов к Bright Data и без записи в рабочую БД.
- **Что сделано:** Bright Data replay читает локальный `posts`-корпус, очищает прежние результаты, сохраняет прогресс классификации/supply/demand по пачкам и возобновляется по `BRIGHTDATA_RUN_ID`. Supply-путь использует тот же canonical prompt и batch-валидатор, что и production extraction. После явного разрешения пользователя выполнен полный прогон через Groq/Gemini/Cloudflare. Исправлено ложное срабатывание счётчика «вне региона» на неоднозначное название 7 Makara / Prampi Makara; итог пересчитан из сохранённого прогресса без повторных API-вызовов.
- **Метрики:** 872/872 классифицированы, `UNCLASSIFIED=0`; 365 supply, 1 demand, 5 adjacent, 501 irrelevant. Из 365 supply-публикаций выделены 103 кластера репостов; 103/103 извлечены, 93 приняты фильтром каталога, 10 отклонены, 22 приняты без явно указанного города; 1/1 demand извлечён с actionable criteria. Простая сигнатура фактов даёт 89 уникальных объектов среди 93 принятых кластеров (не считать доказанной точной дедупликацией). 0 подтверждённых out-of-area supply после исправления эвристики.
- **Сравнение:** предыдущий прогон того же корпуса дал 412 supply / 1 demand / 8 adjacent / 451 irrelevant, но не извлекал детали полного корпуса. Изменились 60 классификаций: 51 supply→irrelevant, 4 adjacent→irrelevant, 4 irrelevant→supply, 1 irrelevant→adjacent. Выборочная проверка 51 пониженной записи нашла продажи, краткосрочный отель и районы Phnom Penh; четыре повышения до supply были отклонены последующим extractor. Снижение числа supply само по себе не метрика точности без ручной разметки. Старые 388 «уникальных supply» и новые 103 кластера напрямую не сравнивать: изменились правила дедупликации.
- **Каскад:** валидный ответ для классификации дали Gemini 3.5 Flash-Lite (832 поста), 3.1 Flash-Lite (20), 3.5 Flash (20); для извлечения supply+demand — Gemini 3.5 Flash-Lite (341 пост) и 3.5 Flash (25). Groq иногда возвращал невалидный batch; отдельные Gemini отвечали 503 или неполным JSON, fallback довёл прогон до конца. Это статистика успешных ответов, а не всех попыток/потраченных квот.
- **Проверка:** typecheck, lint, полный `npm test -- --runInBand` (exit 0). Файлы результата: `tmp/brightdata-test/replay-2026-10-06-0825_classified.json` и `..._group_report.json`. Тесты в sandbox выводили ошибки отправки PostHog (`ENOTFOUND`), но завершились успешно.
- **Остаточные риски:** 22 принятых кластера без явно указанного города требуют ручной проверки; классификатор допускает ложные supply, хотя extractor их отсекает. 93 принятых — кандидаты для review, не автоматически опубликованные карточки. Не запускать массовый `reparse --apply` или ingest без отдельной проверки результата и резервной копии БД.
- **Source analytics:** per-post group metadata и per-group отчёт сохранены в результате; в `SIEM_REAP_SOURCES.md` добавлена понятная сводка ценности групп и временная стратегия частоты сканирования. Это обновляет старый classification-only отчёт, который нельзя было напрямую сравнивать с canonical replay.

### 2026-10-06 — Единый каскад AI и отказ от OpenAI

- **Стадия:** извлечение объявлений / лимиты AI.
- **Что сделано:** живые Facebook/Khmer24 сценарии переключены на каноническое извлечение без feature flag; удалён OpenAI fallback и его зависимости. Bright Data и регрессионные сценарии используют тот же каскад Groq → шесть Gemini-моделей с Free Tier → Cloudflare; NL-поиск разделяет Gemini-квоты каскада. Добавлены отдельные RPM/RPD/TPM/TPD-бюджеты и cooldown по каждой паре провайдер/модель, обработка 429 и ограничение длины ответа. Настройка описана в `AI_MODEL_LIMITS.md`.
- **Решение (обновлено после снимка AI Studio):** для Gemini 3.5/3.1 Flash-Lite — 15 RPM / 250K input TPM / 500 RPD; для Gemini 3.8/3.7/3.6/3.5 Flash — 5 RPM / 250K input TPM / 20 RPD. Числа до `/` в присланной таблице — текущий расход, в код внесены пределы после `/`. RPD и daily 429 сбрасываются по тихоокеанской полуночи; 429 уточняет cooldown на лету.
- **Риски:** счётчики пока общие только внутри одного Node-процесса; параллельные scraper/CLI процессы могут суммарно превысить квоту. Cloudflare измеряет бесплатный лимит в neurons; локальный предсчёт по опубликованным коэффициентам приблизителен, поэтому оставлен запас до 10 000. Платный Google-проект может тарифицировать вызовы даже для моделей с Free Tier.
- **Проверка:** typecheck, lint и 329 unit tests (34 набора) без расходования API-квот.
- **Следующий шаг:** при параллельных фоновых процессах добавить межпроцессный координатор квот; после изменения tier обновить `GEMINI_PROJECT_LIMITS` или `AI_MODEL_LIMITS_JSON`.


### 2026-10-06 — Создание плана и первичная структуризация

- **Стадия:** Подготовка
- **Что сделано:**
  - Прочитана и проанализирована переписка с GPT (`next steps`).
  - Сформированы ключевые выводы и принятые/отвергнутые идеи.
  - Создан пошаговый план: `HOMEASY_ROADMAP.md`.
  - Создан файл лога: `HOMEASY_LOG.md`.
- **Решения:**
  - Продукт позиционируется как housing matching backend с Telegram client, а не как «Telegram-бот с объявлениями».
  - Ingestion абстрагируется через `SourceAdapter`.
  - Вводятся сущности `DemandCandidate`, `Request`, `Offer`, `ListingSourceOccurrence`.
  - Domain tracking gateway поднимается как часть базовой архитектуры.
  - Analytics и admin notifications делаются сразу, а не «потом».
  - Telegram-first остаётся; WhatsApp и public Web App — в бэклог до данных.
  - Ранний агентский пилот — 3 invite-only агента после появления первых confirmed Requests.
  - Монетизация начинается с Agent Pro / pay-per-qualified-lead, не с commission.
- **Блокеры:**
  - Имена `PLAN.md` и `PLAN_LOG.md` попадают под паттерны `.gitignore` (`*plan*.md`), поэтому использованы `HOMEASY_ROADMAP.md` и `HOMEASY_LOG.md`.
- **Следующие шаги:**
  - [ ] Согласовать приоритеты и внести правки в `HOMEASY_ROADMAP.md` при необходимости.
  - [ ] Начать Стадию 1: определить интерфейс `SourceAdapter` и оценить текущие scraper'ы.
  - [ ] Уточнить домен для tracking gateway.

### 2026-10-06 — Исследование Bright Data Facebook Groups Scraper

- **Стадия:** Стадия 1 (backup ingestion)
- **Что сделано:**
  - Проверена страница Bright Data Facebook Scraper API.
  - Найден dedicated endpoint «Facebook - Posts by group URL» (dataset ID `gd_lz11l67o2cb3r0lkj3`).
  - Изучены цены и условия free tier.
- **Решения / наблюдения:**
  - **Free tier:** 5,000 records/month, no credit card required (≈$7.50 value), renews monthly.
  - **Pay-as-you-go:** $1.5 / 1,000 records. Scale tier: $499/mo за 384K records.
  - В цену включены: proxies, unblocking, CAPTCHA, parsing, storage/egress.
  - **Критическое ограничение:** Bright Data явно пишет, что собирает только publicly available data и **не обходит private/login-gated content**.
  - Следовательно, для **публичных** Facebook groups может работать без нашего аккаунта; для **приватных** групп — нет, нужен логин/куки.
  - Output fields: post URL, post_id, content, date_posted, group_name, group_id, group_url, group_category («Public group»), user_url, username, num_comments, num_shares, attachments.
  - API: `POST /datasets/v3/scrape` sync (до 20 URLs), `/trigger` async (batch).
  - Это может быть backup/commodity ingestion, если Camoufox перестанет работать, но не заменит private-группы без аутентификации.
- **Блокеры / риски:**
  - Неизвестно, какие именно из наших целевых групп публичные, а какие приватные.
  - ToS/data risk остаётся даже при переносе технической борьбы на поставщика.
  - Бесплатный лимит мал для полноценного скрейпинга, но достаточен для теста.
- **Метрики / наблюдения:**
  - Пример ответа из документации: `group_category: "Public group"`, `content: null` (возможно, depends on parsing).
- **Следующие шаги:**
  - [ ] Проверить, какие из наших целевых Facebook groups public vs private.
  - [ ] Зарегистрировать free Bright Data account и сделать тестовый запрос по 1–2 public группам.
  - [ ] Сравнить качество/полноту с Camoufox на тех же группах.
  - [ ] Решить, стоит ли писать `FacebookBrightDataAdapter` под `SourceAdapter` сразу или держать как аварийный fallback.

### 2026-10-06 — Реестр Facebook-групп Siem Reap

- **Стадия:** Стадия 1 (source registry + ingestion strategy)
- **Что сделано:**
  - Собран список групп от владельца (17 групп на втором аккаунте + 1 pending join).
  - Добавлены рекомендации GPT по дополнительным группам.
  - Сведён с текущим конфигом в `src/config/settings.ts`.
  - Создан единый реестр источников: `SIEM_REAP_SOURCES.md`.
  - Определены роли (`supply` / `demand` / `mixed` / `community` / `ignore`), приоритеты (A/B/C/D) и статусы (active / ready / pending_join / test / suspicious_url / duplicate).
- **Решения:**
  - Всего уникальных FB-групп: ~25–30, из которых A-приоритет (основа пилота) — 7, B — 9, C — 10, D/специальные — 5.
  - Обнаружены подозрительные URL-имена (`handstandcalisthenics`, `binleangheng`, `youthfitness2014`), которые не соответствуют названиям — скорее всего, группы переименованы. Их нужно уточнить по numeric ID.
  - Выявлены вероятные дубликаты по названию: несколько «Expats and locals living in Siem Reap», несколько «Siem Reap Real Estate», несколько «Siem Reap Buy and Sell». Требуется ручная проверка.
  - `Vibe Coding is Life` — не housing-источник, игнорировать.
  - Введена схема `SourceScanRun` для сбора статистики по каждому источнику: posts_seen, unique_listings, unique_demand, duplicates, parse_failures, first_seen_credit.
  - Для разных групп будет разная частота сканирования на основе фактической пользы, а не равномерный polling всех 17+ групп.
- **Блокеры / риски:**
  - Неизвестно, какие группы public vs private. Для Bright Data test нужны public.
  - Некоторые группы находятся на другом FB-аккаунте; для Camoufox может потребоваться отдельная сессия/устройство или использовать основной аккаунт, если группы пересекаются.
  - Pending join (`handstandcalisthenics`) — пока не одобрят, не получится парсить.
- **Метрики / наблюдения:**
  - Текущий конфиг: 14 FB-групп.
  - Новых от владельца: 17 групп (часть дублирует текущий конфиг).
  - Рекомендаций GPT: +6 групп.
  - Примерное количество уникальных источников после дедупликации: ~25–30.
- **Следующие шаги:**
  - [ ] Проверить дубликаты вручную через Facebook (участники, последние посты).
  - [ ] Уточнить suspicious URLs: найти numeric ID групп `handstandcalisthenics`, `binleangheng`, `youthfitness2014`.
  - [ ] Проверить public/private статус групп для Bright Data.
  - [ ] После проверки обновить `src/config/settings.ts` группами со статусом `ready`.
  - [ ] Начать сбор `SourceScanRun` статистики по A-приоритетным группам.

### 2026-10-06 — Bright Data eligibility: public/private статус групп

- **Стадия:** Стадия 1 (source ingestion / backup scraping)
- **Что сделано:**
  - Проанализированы предварительные оценки публичности для объединённого пула ~22–23 Facebook-групп.
  - В реестр `SIEM_REAP_SOURCES.md` добавлен раздел «Bright Data Eligibility» с колонками: группа, URL/ID, оценка публичности, BD статус, заметки.
  - Сформулирована стратегия расходования free tier: сначала demand-группы, потом mixed, supply через Bright Data — низкий приоритет (уже есть Camoufox + Khmer24).
- **Решения / наблюдения:**
  - Bright Data free tier: 5 000 успешно доставленных records/мес, failed deliveries не тарифицируются.
  - Лучшие кандидаты для первого BD batch test (demand-first): `SiemReapExpatsLocals`, `900185676717876`, `495676670504992`, `385053483002145`, `siemreaprealestate`, `201561753758474`.
  - Подтверждённые/очень вероятно public: ~14 групп.
  - Likely private / contradictory: `siemreap` (большая expat-группа, ~64k) и `233923189986441` (Siem Reap Residents) — оставить для Camoufox, BD test только для проверки.
  - Batch test должен быть минимальным: 1–3 поста за последние 2–3 дня по всем ~20 URL, чтобы не сжечь квоту.
  - После BD test каждой группе проставить фактические флаги: `bd_scrapable`, `bd_last_test_at`, `bd_test_result`.
- **Блокеры / риски:**
  - Оценки публичности основаны на поисковой индексации и сторонних источниках; финальный арбитр — сам запрос к Bright Data.
  - Некоторые группы могли сменить privacy недавно.
  - `handstandcalisthenics` — устаревший slug мешает поисковой проверке, только прямой BD/FB тест.
- **Метрики / наблюдения:**
  - ~22–23 уникальных FB-групп в объединённом пуле.
  - ~14 из них имеют хорошие признаки public.
  - 2 группы отмечены как likely private.
- **Следующие шаги:**
  - [ ] Зарегистрировать free Bright Data account и получить API token.
  - [ ] Подготовить JSON-массив из ~20 group URL для batch test.
  - [ ] Запустить минимальный `/datasets/v3/scrape` или `/trigger` запрос (limit 1–3 recent posts per group).
  - [ ] Зафиксировать результаты в `SIEM_REAP_SOURCES.md`: success / empty / failed / private.
  - [ ] На основе результатов решить: писать ли `FacebookBrightDataAdapter` сразу или держать BD как fallback.

### 2026-10-06 — Скрипт тестового batch-прогона Bright Data + перемещение API-ключа

- **Стадия:** Стадия 1 (backup ingestion / source testing)
- **Что сделано:**
  - API-ключ Bright Data удалён из `SIEM_REAP_SOURCES.md` и сохранён в `.env` под именем `BRIGHTDATA_API_KEY`.
  - Попытка загрузки ключа в Devin Cloud secrets — CLI требует `devin auth login` (не выполнено).
  - Изучена документация Bright Data API: endpoint `POST /datasets/v3/scrape`, dataset ID `gd_lz11l67o2cb3r0lkj3`.
  - Написан TypeScript-скрипт `scripts/brightdata-batch-test.ts`.
  - Добавлена переменная `BRIGHTDATA_API_KEY` в `src/config/env.ts`.
  - Добавлен npm-скрипт: `npm run brightdata:test:groups`.
  - Запущен `npm run typecheck` — ошибок нет.
- **Решения / наблюдения:**
  - Скрипт отправляет группы батчами по 10 URL, использует sync endpoint `/scrape`.
  - Результаты сохраняются в `tmp/brightdata-test/`: raw-ответы и `summary.json`.
  - Скрипт выводит сводку: сколько групп scrapable, empty, error, private.
  - Группы взяты demand-first: A-приоритет первыми, likely private — последними для подтверждения fail.
  - Free tier расходуется только на успешно доставленные records; failed не тарифицируются.
- **Блокеры / риски:**
  - Скрипт ещё не запущен, чтобы не тратить квоту без явного согласия.
  - Неизвестно, вернёт ли sync endpoint массив записей или snapshot_id; скрипт обрабатывает оба случая.
  - Devin Cloud secrets требует авторизации CLI.
- **Следующие шаги:**
  - [ ] Запустить `npm run brightdata:test:groups` (сожжёт часть free tier).
  - [ ] По результатам обновить `SIEM_REAP_SOURCES.md`: проставить `bd_scrapable`, `bd_test_result`.
  - [ ] Если sync endpoint не справляется с 10 URL — перейти на async `/trigger` + polling.
  - [ ] По желанию: выполнить `devin auth login` и загрузить ключ в Devin Cloud secrets.

### 2026-10-06 — Исправление скрипта Bright Data после ревью

- **Стадия:** Стадия 1 (source ingestion / backup scraping)
- **Что сделано:**
  - Переписан `scripts/brightdata-batch-test.ts` с учётом обратной связи.
  - Убран импорт `env` из `src/config/env.ts` — скрипт теперь читает `process.env.BRIGHTDATA_API_KEY` напрямую, чтобы не валидировать все переменные приложения.
  - `BATCH_SIZE` изменён с 10 на **1**: один URL = один запрос, исключаем неопределённость с `group_url`.
  - Добавлено ограничение по датам (`start_date`/`end_date`) — по умолчанию последние 1–2 дня; переопределяется через `BRIGHTDATA_START_DATE`/`BRIGHTDATA_END_DATE`.
  - Добавлен `format=json` в URL.
  - Обработка HTTP 202 + `snapshot_id`: polling `/datasets/v3/progress/{id}` и download `/datasets/v3/snapshot/{id}?format=json`.
  - Статусы приведены к реалистичным: `success`, `no_records`, `unsupported_or_private`, `api_error`, `snapshot_timeout`, `unknown`.
  - Добавлен `BRIGHTDATA_PILOT=true`: запускает только 3 группы (2 public + 1 likely private) для калибровки.
  - Raw-ответы теперь сохраняются по одному файлу на группу.
  - `npm run typecheck` проходит.
- **Решения / наблюдения:**
  - `no_records` ≠ public; 0 записей может означать private, unsupported, отсутствие постов, transient failure или проблему canonical URL.
  - `group_url` в ответе Bright Data не гарантирован, поэтому attribution делам через `BATCH_SIZE = 1`.
  - Private-статус нельзя выводить автоматически, если API явно не сообщает об этом; используем `unsupported_or_private` как неопределённый fail.
  - Sync `/scrape` может вернуть 202 и `snapshot_id`; обязательно нужен polling.
- **Блокеры / риски:**
  - Ещё не запущен, чтобы не тратить квоту без согласия.
  - Параметры `start_date`/`end_date` и `user_to_not_include` взяты из рекомендаций; реальная поддержка зависит от Bright Data dataset — проверим на первом запуске.
- **Следующие шаги:**
  - [ ] Запустить pilot: `BRIGHTDATA_PILOT=true npm run brightdata:test:groups` (3 группы, минимальная квота).
  - [ ] Посмотреть `tmp/brightdata-test/*_raw.json` — уточнить реальную схему ответа.
  - [ ] Если pilot успешен — запустить полный прогон всех групп.
  - [ ] По результатам обновить `SIEM_REAP_SOURCES.md`: `bd_scrapable`, `bd_test_result`, `bd_test_date`.

### 2026-10-06 — Запуск pilot Bright Data

- **Стадия:** Стадия 1 (source ingestion / backup scraping)
- **Что сделано:**
  - Добавлена фильтрация error-records внутри успешного ответа (`include_errors=true` мог добавлять error-записи).
  - Убран вывод частичного API-ключа в консоль.
  - Добавлен `RUN_ID` и timestamp в имена raw-файлов и summary.
  - Запущен pilot: `BRIGHTDATA_PILOT=true npm run brightdata:test:groups`.
- **Решения / наблюдения:**
  - **Siem Reap Expats & Locals** — HTTP 400, error: "Customer is not active" → статус `account_inactive`.
  - **Real Estate in Siem Reap** — HTTP 400, error: "Customer is not active" → статус `account_inactive`.
  - **Expats and locals living in Siem Reap (likely private)** — HTTP 200, error: "Private group: Only members can see who's in the group and what they post." → статус `unsupported_or_private`.
  - Скрипт корректно определил private-группу.
  - Две public-группы не вернули записи не из-за privacy, а из-за неактивированного аккаунта Bright Data.
- **Блокеры / риски:**
  - **Bright Data account требует активации.** Судя по ошибке "Customer is not active", новый аккаунт не активирован или не привязан billing/payment method (даже для free tier).
  - До активации нельзя проверить реальную выдачу по public-группам.
- **Метрики / наблюдения:**
  - Запущено: 3 группы.
  - 0 успешных записей, 2 `account_inactive`, 1 `unsupported_or_private`.
  - Raw + summary сохранены в `tmp/brightdata-test/2026-10-06T03-17-13_*`.
- **Следующие шаги:**
  - [ ] Войти в Bright Data dashboard, активировать аккаунт / привязать способ оплаты (free tier всё равно требует активации).
  - [ ] После активации повторно запустить pilot: `BRIGHTDATA_PILOT=true npm run brightdata:test:groups`.
  - [ ] Если pilot проходит — запустить полный прогон.
  - [ ] Обновить `SIEM_REAP_SOURCES.md` на основе фактических результатов.

### 2026-10-06 — Full run Bright Data: результаты по 23 группам

- **Стадия:** Стадия 1 (source ingestion / backup scraping)
- **Что сделано:**
  - Аккаунт Bright Data активирован; кредиты доступны без дополнительных запросов.
  - Повторно запущен pilot — 2 public-группы вернули 149 + 60 records, private определена корректно.
  - Запущен полный прогон всех 23 групп: `npm run brightdata:test:groups`.
  - Обновлён `SIEM_REAP_SOURCES.md` таблицей с фактическими результатами.
- **Решения / наблюдения:**
  - **Public + scrapable:** 11 групп (Siem Reap Expats & Locals, Real Estate in Siem Reap, Rental & Sale, Siem Reap Real Estate, SIEM REAP Rent..., Siem Reap Expats, siem reap buy and sell, Siem Reap Ex-Pat Truly Open Group, Siem Reap Expat Connection, Cheap Rent Siem Reap, Камбоджа — все там будем!).
  - **Private / unsupported:** 5 групп (Siem Reap Community, Anything for Sale or Rent, handstandcalisthenics, siemreap, Siem Reap Residents).
  - **Snapshot timeout:** 2 группы (900185676717876, 366920920387861) — запрос ушёл в snapshot, polling превысил 5 минут.
  - **Fetch failed (HTTP 0):** 4 группы (binleangheng, 1979336498978784, Events & Activities, 270186473437566) — transient network errors.
  - **No records / unavailable:** Siem Reap Open Forum — "This content isn't available right now".
  - Общее количество raw records: ~783.
  - Реальная схема ответа подтверждена: `url`, `post_id`, `content`, `date_posted`, `group_id`, `group_url`, `group_category`, `group_members`, `user_url`, `user_username_raw`, `attachments`, `input`.
  - `group_url` и `group_id` присутствуют, но batch size 1 всё ещё оправдан для прозрачности и простоты.
- **Блокеры / риски:**
  - 6 групп требуют retry (2 timeout + 4 fetch failed).
  - Snapshot polling timeout = 5 минут может быть недостаточно для медленных групп.
  - Нужно оценить качество: сколько из 783 записей реально housing supply/demand, а не spam/ads/tourism.
- **Метрики / наблюдения:**
  - 23 групп протестировано.
  - ~783 records получено.
  - Топ по raw count: siem reap buy and sell (238), Cheap Rent Siem Reap (101), Siem Reap Expats & Locals (149).
- **Следующие шаги:**
  - [ ] Retry timeout/failed групп с увеличенным `SNAPSHOT_MAX_POLL_MS` и более длинной задержкой между запросами.
  - [ ] Запустить AI classifier на полученных raw-записях: разделить `housing_supply`, `housing_demand`, `irrelevant`.
  - [ ] Посчитать unique listings / demand candidates per source.
  - [ ] Обновить `src/config/settings.ts`: публичные группы — через Bright Data, private — через Camoufox.
  - [ ] Подумать, нужен ли `FacebookBrightDataAdapter` в рамках `SourceAdapter`.

### 2026-10-06 — Классификация Bright Data records: supply/demand report

- **Стадия:** Стадия 1 (source ingestion / analytics)
- **Что сделано:**
  - Написан скрипт `scripts/brightdata-classify.ts`:
    - загружает raw Bright Data records;
    - скачивает snapshot-данные по `snapshot_id` (без дополнительного расхода квоты);
    - классифицирует посты: `HOUSING_SUPPLY`, `HOUSING_DEMAND`, `HOUSING_ADJACENT`, `IRRELEVANT`;
    - извлекает structured demand fields;
    - считает dedupe с `first_seen_credit`;
    - выводит per-group report.
  - Добавлен npm-скрипт: `npm run brightdata:classify`.
  - Исправлена модельная каскада: в скрипте используется fallback по нескольким Gemini-моделям, чтобы обойти RPM-лимиты.
  - Запущена классификация 872 raw-записей из full run (snapshot-данные уже сгенерированы, скачивание бесплатно).
- **Решения / наблюдения:**
  - **872 raw records** → **412 supply**, **1 demand**, **8 adjacent**, **451 irrelevant**.
  - **Unique supply:** 388; **unique demand:** 1.
  - **Public Facebook-группы оказались supply-heavy:** даже expat/community-группы в основном содержат объявления агентов/владельцев.
  - **Единственный demand** нашёлся в `Siem Reap Expats & Locals`.
  - **Лучшие supply-источники:** `Siem Reap Real Estate` (84.4% supply), `Real Estate in Siem Reap` (83.6%), `SIEM REAP Rent...` (82.5%).
  - **Высокий noise:** ~52% записей — taxi, tours, food, events, general buy/sell, job, spam.
  - **Duplicate rate низкий:** всего ~24 supply-поста дублируются между группами.
  - Gemini rate limits привели к необходимости fallback-моделей; structured extraction supply было пропущено в финальном отчёте, дедупликация сделана по контенту.
- **Блокеры / риски:**
  - Gemini RPM/TPM ограничения замедляют structured extraction.
  - Demand в public-группах оказался крайне редким. Основной demand, вероятно, сидит в private/expat-группах (Camoufox) или в Khmer24.
- **Метрики / наблюдения:**
  - 872 raw records, 388 unique supply, 1 unique demand.
  - Топ по raw: `siem reap buy and sell` (238), `Siem Reap Expats & Locals` (149), `Cheap Rent Siem Reap` (101).
- **Следующие шаги:**
  - [ ] Дождаться сброса Gemini rate limits и запустить structured extraction для supply/demand.
  - [ ] Retry 6 неопределённых групп (`snapshot_timeout` / `fetch failed`), особенно `900185676717876` и `366920920387861`.
  - [ ] Проверить private-группы через Camoufox на предмет demand.
  - [ ] Обновить `src/config/settings.ts` и scheduler: public-группы → Bright Data, private → Camoufox.

### 2026-10-06 — AI Router: Groq primary, Gemini fallback

- **Стадия:** Stage 0 — инфраструктура AI routing
- **Что сделано:**
  - Сверился с доками:
    - Groq: OpenAI-compatible endpoint `https://api.groq.com/openai/v1/chat/completions`, модели `qwen/qwen3.8-27b` (free: 30 RPM, 1,000 RPD, 8K TPM, 200K TPD), заголовки `x-ratelimit-*`.
    - Cloudflare: OpenAI-compatible endpoint `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions`, free 10,000 neurons/day.
  - Создан модуль `src/modules/ai`:
    - `types.ts` — единый интерфейс `AiProvider` и `AiRouter`.
    - `groq.provider.ts` — Groq через OpenAI-compatible endpoint, `response_format: { type: 'json_object' }`, логирование rate-limit headers.
    - `gemini.provider.ts` — wrapper над Google Generative AI.
    - `cloudflare.provider.ts` — готов, но пока не включён в router.
    - `router.ts` — последовательный fallback по провайдерам, JSON/schema validation, metrics callback.
  - Обновлён `scripts/brightdata-classify.ts`:
    - Использует `AiRouter(Groq → Gemini)`.
    - Добавлен `CLASSIFY_LIMIT` для тестовых прогонов.
    - Убраны попытки навязать Groq strict JSON schema (Groq strict mode требует top-level object, не array, и не поддерживает nullable/oneOf).
    - Prompt'ы теперь явно требуют JSON object с `items`.
- **Решения:**
  - Groq — primary, Gemini — fallback #1. Cloudflare оставлен отдельным, добавим как fallback #2 после стабилизации.
  - `INTER_BATCH_DELAY_MS = 3000` → ~20 RPM, вписывается в лимит Groq 30 RPM.
  - Classification batch 60 posts → ~15 requests, укладывается в 1,000 RPD.
- **Тест:**
  - `CLASSIFY_LIMIT=3` — Groq вернул корректный JSON, классификация прошла успешно.
- **Блокеры:** нет.
- **Следующие шаги:**
  - [ ] Полный прогон классификации 872 постов через Groq.
  - [ ] Добавить Cloudflare как fallback #3 после проверки Groq+Gemini в бою.
  - [ ] Перенести structured supply extraction на AiRouter.

### 2026-10-06 — Аудит AI-каскада (Groq → Gemini → Cloudflare): найденные ошибки и исправления

- **Ошибки в предыдущей записи / коде:**
  - Заявлено, что batch=60 и delay 3s «влезают в лимиты Groq». Неверно: у `qwen/qwen3.8-27b` на free лимит по токенам (ITPM 7,000 / TPM 8K / TPD 200K), и batch из 60 постов по 2000 символов давал HTTP 413. Учитывался только RPM/RPD.
  - Cloudflare не работал: код читал `CLOUDFLARE_ACCOUNT_ID`, а в `.env` переменная называется `CLOUDFLARE_ACC_ID` (теперь поддерживаются оба имени); ответ парсился из `result.choices`, а OpenAI-compatible endpoint отдаёт `choices` на верхнем уровне (теперь поддерживаются оба формата); модель `@cf/meta/llama-3.1-8b-instruct` отдаёт HTTP 410 (deprecated) — дефолт заменён на `@cf/meta/llama-3.1-8b-instruct-fp8`.
  - Ошибки Gemini/Cloudflare не попадали в метрики и не ставили cooldown. Теперь все провайдеры бросают `ProviderError` (в `types.ts`), router держит per-provider cooldown (Groq: `retry-after` при 429; Gemini/Cloudflare: 60s при 429/503).
  - Валидация классификации проверяла только тип `id`. Теперь требуется: все id из batch присутствуют и `class` из 4 допустимых значений, иначе fallback на следующий провайдер.
  - Предупреждение про `x-ratelimit-remaining-tokens` называлось «tokens remaining today», хотя по доке это TPM (в минуту).
- **Параметры под лимиты Groq:** batch 25 постов × 400 символов (~3.7K input tokens), пауза 30s между batch (env: `CLASSIFY_BATCH_SIZE`, `CLASSIFY_TEXT_CHARS`, `CLASSIFY_BATCH_DELAY_MS`). Оценка для 872 постов: ~35 запросов, ~17 минут, ~165K токенов из 200K TPD — запас небольшой, дальше срабатывает fallback.
- **Проверено реально:** smoke-тест каждого провайдера (1–2 поста): Groq OK, Gemini OK, Cloudflare fp8 OK (`llama-3.2-3b` пропустил один id — валидатор это ловит). Прогон `CLASSIFY_LIMIT=40`: 40/40 классифицированы через Groq, UNCLASSIFIED=0, fallback не потребовался.
- **Сделано следом:**
  - Prompt `HOUSING_ADJACENT` ужесточён (только жильё: аренда/агенты/соседи/коммуналка/район; товары, услуги, общие вопросы экспата -> `IRRELEVANT`; при сомнении `IRRELEVANT`). Проверка на 8 прежних ADJACENT-постах: 3 остались ADJACENT (2 реферала агента + вопрос про электричество), 5 шумовых (тостер, осанка, скутер, контакты, выпечка) ушли в `IRRELEVANT`; единственный demand-пост остался `HOUSING_DEMAND`.
  - Supply extraction переведён на `AiRouter` (prompt и `sanitizeLlmResult` те же, что в production-парсере; экспортированы из `extractor.ts`). Сначала репосты кластеризуются (property code / автор+контакты+текст), в LLM уходит только первый пост кластера, остальные члены наследуют extraction (SourceOccurrence не удаляются). В отчёт добавлен `supplyStats` (кластеры, is_real_estate, отклонено экстрактором, уникальные объекты).
  - Demand extraction: явный формат ответа в prompt и проверка, что результат есть для каждого id.
  - Тест на 25 постах: 16 supply -> 16 кластеров -> 16/16 извлечены, 15 is_real_estate, 14 уникальных объектов; fallback реально сработал (Groq 429 по TPM, затем невалидный ответ -> следующий провайдер).
- **Ограничение:** extraction-batch (~6–7K токенов с prompt в ~2.5K) почти целиком занимает TPM Groq (8K), поэтому по Groq идёт ~1 запрос в минуту (`SUPPLY_BATCH_DELAY_MS`, по умолчанию 45s), а суточные 200K TPD не покрывают и classification, и extraction за один день — часть extraction уйдёт на Gemini/Cloudflare. Провайдер, выполнивший supply extraction, пока не пишется в результат (только `classifiedBy` для классификации).
- **Не сделано:** полный прогон 872 постов; проверка fallback при полном отказе Groq.

### 2026-10-06 — Ревизия промтов: Prompt 1 (classification) и Prompt 2 (supply extraction)

- **Prompt 1:** переписан по ревью: demand определяется по actionable intent («полезно ли показать подходящие объекты»), а не по формулировке «looking for»; другой город -> `IRRELEVANT`; защита от prompt injection; текст поста = голова 500 + хвост 300 символов вместо префикса 400; batch 20. Проверка: 4 из 4 demand-фраз без слов «looking for» -> `HOUSING_DEMAND`, 3 из 3 adjacent-примеров -> `HOUSING_ADJACENT`, Phnom Penh -> `IRRELEVANT`.
- **Prompt 2:** новый canonical-модуль `src/modules/parser/listing-extraction.ts` (prompt + `ListingFacts` + sanitizer + детерминированные хелперы). Изменения: поля nullable там, где факт может быть неизвестен; `is_real_estate` -> `is_supported_listing`; `category` только apartment/house/room/hotel; добавлен `city` (политика «только Siem Reap» применяется в коде, не в модели); `sangkat` только если назван явно, `explicit_location` и `marketing_landmarks` отдельно, никаких догадок по расстоянию до ориентира; `min_lease_months` + `lease_term_text` вместо «long term = 6»; `electricity_type/rate`, `water_type/rate` без выдуманных тарифов; телефоны, Google Maps и Telegram парсятся regex, а не LLM; названия санкатов нормализует `findCanonicalLocation`; список санкатов из prompt убран; «100% English» заменено на «переводи описания, имена собственные сохраняй». Prompt сократился примерно с 2.5K до ~1.1K токенов.
- **Баг Khmer24:** `KHMER24_EXTRACTION_HINTS` заменял основной prompt. Теперь `SYSTEM_INSTRUCTIONS + SOURCE-SPECIFIC NOTES + hints` (правка на месте вызова в `khmer24.scraper.ts`, чтобы не затронуть reparse, где custom-промты намеренно полные).
- **Проверка:** синтетический тест (4 поста): Siem Reap-аренда принята; Phnom Penh отклонён по `city`; продажа отклонена; инъекция «Ignore previous instructions» проигнорирована; `long term` -> `lease_term_text`, `min_lease_months=null`; телефон, maps и t.me найдены regex. Прогон на 25 постах: 15 supply -> 15 кластеров -> 15/15 извлечены, 15 принято.
- **Найдено:** у Groq на этом аккаунте отдельный лимит OTPM = 1,000 выходных токенов в минуту (в доке: ITPM/OTPM могут отличаться от TPM). Один листинг ~300 выходных токенов, поэтому supply-batch теперь 3, пауза 60s; для классификации reason ограничен 8 словами, пауза 35s. 429 без `retry-after` теперь даёт cooldown Groq 60s (лимиты поминутные).
- **Не сделано:** миграция production-скраперов (Facebook, Khmer24, reparse) и БД на `ListingFacts` (сейчас canonical-схема используется только в Bright Data pipeline; в проекте по-прежнему 3 разные схемы); строгий JSON Schema на уровне провайдеров (Groq strict требует object-root и без nullable, у Gemini и Cloudflare другой диалект; пока контракт держит sanitizer); алиасы санкатов («Kork Chork» -> «Kouk Chak» не нормализуется).

### 2026-10-06 — Доработка Prompt 2 перед заморозкой (geography, utilities regression, provenance)

- **Geography:** `city = null` не приводит к отказу. Добавлен `geographyStatus()`: `siem_reap` | `out_of_area` | `unknown_city`. Отклонение только при положительном указании другого города из списка камбоджийских городов; строка вроде «Cambodia» -> `unknown_city`. Prompt поправлен: пост без города из siem-reap группы допустим, город оставляется `null`. В `supplyStats` добавлен `acceptedUnknownCity`.
- **Regression test:** `npm run test:listing-extraction` (`scripts/listing-extraction-regression.ts`): 12 синтетических постов (electricity: EDC/government -> `state_rate` без ставки, `$0.25/kWh` и `1000 riel/kWh` -> `fixed`, free -> `included`, не указано -> `null`; water: included / state / per-person / не указано; geography: без города принят, Phnom Penh отклонён) + 7 детерминированных проверок `geographyStatus`. Результат: ALL PASSED (батчи отработали и на Groq, и на Gemini fallback; Cloudflare в этом тесте не участвовал).
- **Provenance:** `AiRouter` возвращает `fallbackDepth` (индекс победившего провайдера). В результат пишутся `classifiedBy` и `extractedBy` = `{provider, model, fallbackDepth}` для классификации, supply и demand extraction (члены кластера репостов наследуют `extractedBy` представителя). Проверка на 25 постах: classifiedBy gemini(1)=20 / groq(0)=5; extractedBy gemini(1)=12 / groq(0)=3.
- **Наблюдение:** в одном прогоне Groq вернул HTTP 400 (причину не разбирал; вероятно невалидный JSON в `json_object` режиме). Если повторится на большом корпусе, посмотреть текст ошибки.
- **Prompt 2 заморожен.** Не делали: миграцию production-схем на `ListingFacts`, строгий JSON Schema по провайдерам, словарь алиасов санкатов.

### 2026-10-06 — Prompt 3 (demand extraction): новая canonical-схема

- **Модуль:** `src/modules/parser/demand-extraction.ts` (prompt, `DemandFacts`, sanitizer, `detectLanguage`, `hasActionableCriteria`). Старые `DEMAND_SYSTEM_INSTRUCTION` и `DemandExtraction` в `brightdata-classify.ts` удалены.
- **Бюджет:** `budget_min` / `budget_max` / `budget_target` / `budget_is_approximate`. «around $350» -> target=350, approximate=true, min=max=null (раньше min=max=350, что отсекало бы $340 и $370). Sanitizer дополнительно страхует: approximate + min==max превращается в target; min>max меняются местами; валюта без бюджета отбрасывается.
- **Даты:** `move_in_date` (только валидный ISO) + `move_in_text`. Относительные даты считаются от `posted_at` самого поста (в user-сообщение каждому посту передаётся дата публикации), а не от «сегодня».
- **Срок:** `duration_min/max_months` + `duration_text`; «long term» и «a few months» не превращаются в числа.
- **Типы жилья:** тот же canonical enum, что и в supply (`Room, Studio, Apartment, Condo, Private House, Private Villa, Flat House, Hotel Room`), массив `property_types`; алиасы house/villa -> Private House/Private Villa; английское «flat» = Apartment (модель сначала вернула Flat House на реальном посте, правило добавлено).
- **Спальни:** `bedrooms_min/max`. **Предпочтения:** `must_haves` / `nice_to_haves` по лингвистическим маркерам, плюс `exclude_features`, `areas` / `exclude_areas`. **Питомцы:** `has_pets` + `pet_types` (без «false = не нужны»). **Люди:** только люди, питомцы не считаются (на Groq «my wife and I and our dog» дал 3, добавлено явное правило).
- **Убрано из LLM:** `language` (определяется кодом: km/ru/en) и self-reported `confidence`; вместо порога по confidence в статистику добавлен `demandStats.withActionableCriteria`.
- **Batch demand:** 10 -> 4 (редкий и ценный класс, качество важнее числа вызовов; также укладывается в Groq OTPM 1,000).
- **Regression:** `npm run test:demand-extraction` (17 live-кейсов: бюджет, срок, спальни, must/nice, exclude, питомцы/люди, flat, даты + 13 детерминированных проверок sanitizer). ALL PASSED (батчи на Groq и Gemini fallback). `REGRESSION_ONLY=id1,id2` для точечного перезапуска.
- **Реальный demand-пост** (две соседки, 2BR flat, до $450, дольше года): budget_max=450 USD, duration_min=12 + `duration_text`, bedrooms 2/2, people_count=2, Siem Reap.
- **Не сделано:** извлечение через production-пути (`reparse`, scrapers) не затрагивалось; demand-схема пока живёт только в Bright Data pipeline.

### 2026-10-06 — Prompt 4 (batch wrappers): единый контракт результатов

- **Что сделано:**
  - Добавлен общий validator `src/modules/ai/batch-contract.ts` для ответа `{ "items": [...] }`.
  - Bright Data classification, supply extraction и demand extraction теперь принимают только полный набор ожидаемых `id`: один результат на входной `id`, без дубликатов и посторонних `id`; порядок не важен.
  - Те же правила добавлены в live regression scripts для supply и demand.
  - Prompts classification, supply и demand явно запрещают переносить факты между элементами батча, дублировать/пропускать `id` и добавлять markdown либо лишние ключи.
  - Добавлены 6 unit-тестов контракта: допускается другой порядок; отклоняются пропуск, дубль, неизвестный или некорректный `id` и неверный envelope.
- **Решения:**
  - Неполный/некорректный LLM batch теперь считается ошибкой domain validation и запускает существующий fallback `Groq → Gemini → Cloudflare`.
  - Legacy production wrapper в `extractor.ts` намеренно не мигрировался: он остаётся на отдельном Gemini schema-contract до плановой миграции production-схем.
- **Проверка:**
  - `npm run typecheck` — успешно.
  - `npx jest tests/ai-batch-contract.test.ts --runInBand` — 6/6 успешно.

### 2026-10-06 — Prompt 8 (AI search): зафиксирован MVP scope

- **Решение:** AI search MVP ограничен только долгосрочной/месячной арендой в Siem Reap. Phnom Penh и sale остаются техническими возможностями БД/ручных фильтров, но не предлагаются AI search.
- **Что сделано:**
  - Prompt и schema `NLSearchService` приведены к Siem Reap monthly rentals; убраны противоречивые упоминания Phnom Penh, покупки и sale-цен.
  - Telegram карточка критериев всегда показывает Siem Reap / Monthly Rent; ответ при отклонённом запросе больше не рекламирует Phnom Penh и sale.
  - Старое сообщение-карточка для Phnom Penh или sale не восстанавливает session draft, чтобы не вернуть пользователя в неподдерживаемый поток.
  - «Around $X» больше не выдумывает жёсткий диапазон: пока в фильтрах нет `budget_target`, сумма сохраняется только в summary, а не исключает объявления ошибочным `min/max`.
- **Проверка:** `npm run typecheck` и `npx jest tests/nl-search.test.ts --runInBand` — успешно, 6/6.
- **Следующий долг:** для мягких запросов (approximate budget, preferred pool, 2+ bedrooms) нужно добавить отдельные preference/target-поля и ранжирование — не подменять ими обязательные фильтры.

### 2026-10-06 — Аудит Prompt 5–7: legacy reparse и production extraction

- **Карта prompt'ов:** Prompt 5 = reparse rental normalization, Prompt 6 = reparse classification, Prompt 7 = legacy production `SYSTEM_INSTRUCTIONS`, Prompt 8 = AI search. Ранее AI search по ошибке был назван Prompt 6; запись исправлена.
- **Prompt 5 (reparse normalization):** не мигрирован. Он противоречит canonical `ListingFacts`: требует старый JSON array / порядок, выводит legacy `location`, превращает vague `long term` в число, допускает вывод сангката из ориентиров и требует переводить имена собственные. Не переписывать изолированно: заменить его при плановой миграции reparse на canonical extraction + адаптер записи в legacy БД.
- **Prompt 6 (reparse classification):** классификация разумно разделяет rent/sale/commercial/daily/unclear, но не содержит защиты от prompt injection и использует legacy batch contract. Самый серьёзный риск находится в caller: любой класс кроме `rental` и `unclear` деактивирует запись и записывает `type='sale'`, включая daily/commercial/not_property. До следующего запуска reparse нужен отдельный безопасный admission policy: причина деактивации, корректный enum статуса и ручной review для неоднозначных случаев. Сейчас не запускать массовый reparse.
- **Prompt 7 (legacy production extractor):** дублирует устаревшую supply-схему и семантически расходится с canonical extraction: `long term -> 6`, EDC получает выдуманную ставку, локация выводится из landmark, proper nouns принудительно переводятся. Его нельзя менять точечно, пока Facebook/Khmer24/БД ожидают legacy-поля. Целевой путь: сначала адаптер `ListingFacts -> RawListing/Property`, затем переключение production sources и удаление дубля.
- **Решение:** Prompt 5–7 помечены как один общий production-migration эпик, а не три независимые prompt-правки. Это исключает ситуацию, в которой один и тот же листинг нормализуется по разным правилам в разных путях.

### 2026-10-06 — Production-адаптер canonical ListingFacts (этап внедрения)

- **Стадия:** реализовано и проверено локально; рабочие скраперы пока оставлены на legacy extractor до smoke-проверки реальных постов.
- **Что сделано:** общий canonical batch extractor через AiRouter и полный batch-контракт; адаптер `ListingFacts` в legacy-поля без подстановки срока, тарифа, адреса и валюты; FB/Khmer24 сохраняют полный JSON фактов; миграция v23 добавляет `properties.listing_facts_json`, включая повторные публикации/слияния; нормализатор не восстанавливает неизвестные canonical-факты догадками.
- **Reparse:** режим `--ai` теперь использует canonical extraction по сохранённому тексту только для Siem Reap. Без `--apply` показывает итог и не изменяет строки; с `--apply` сохраняет факты и обновляет только поддерживаемые объявления. Отклонённые/неясные не превращаются в `sale` и не деактивируются автоматически. Старый небезопасный AI-путь оставлен в файле для сравнения, но больше не вызывается из CLI.
- **Трафик:** Khmer24 reparse больше не получает residential proxy автоматически; перед браузерной навигацией установлен общий `attachTrafficGuard`.
- **Проверка:** `npm run typecheck`; 48 тестов из canonical adapter, безопасного reparse, Facebook scraper/batching, Khmer24 enrichment и AI batch-контракта прошли. Миграция v23 и запись JSON проверены на in-memory SQLite. Реальные scrape/reparse и внешние AI-вызовы не выполнялись.
- **Историческая запись (заменена обновлением выше):** ранее планировалось включить каноническое извлечение через `CANONICAL_LISTING_EXTRACTION=true`; теперь оно работает всегда. Для reparse по-прежнему сначала `npm run reparse -- --ai --limit=...` (preview), только после просмотра — `--apply` и резервная копия БД.
- **Остаточные риски:** legacy-колонки не выражают все факты; полная семантика в `listing_facts_json`. Нужны живой corpus-review и тест точности/стоимости каскада перед production-включением. Старые данные не мигрированы автоматически.

### 2026-10-06 — Полный аудит кода vs роадмап (см. `HOMEASY_AUDIT.md`)

- **Стадия:** верификация состояния — лог vs фактический код.
- **Ключевые расхождения с логом:**
  - Canonical extraction **уже live** в обоих скраперах: `extractor.ts` делегирует в `canonical-listing-extractor` + адаптер без флага; legacy `SYSTEM_INSTRUCTIONS` удалён из `src/`. Запись «скраперы на legacy до smoke» устарела.
  - Dedupe pipeline, matcher, freshness sweep, listing review UI (bot + Mini App), локальный SQLite backup — **уже реализованы**, лог их не фиксировал.
  - `runGeminiEnrichment` и legacy-промты в `reparse-listings.ts` — **dead code** (не вызывается); комментарий на строке 410 устарел.
- **Подтверждено отсутствующим:** `listing_source_occurrences`, `demand_candidates`, `requests`, `offers`, `contact_grants`, `matches`, `agents`; роли только `user|admin`; tracking gateway `/r/:slug` и `start_param` не используются; нет внешнего backup, price history, freshness score в ранжировании; live-скраперы не классифицируют demand; колонок `source`/`external_id` у `properties` нет.
- **Найденные проблемы:** polling-бот удаляет webhook, который регистрирует API (конфликт деплоя); `tma_request` events в production без telegram_id; `findByPostId` работает через `LIKE '%id%'` по URL.
- **Файл с деталями:** `HOMEASY_AUDIT.md` (матрица роадмап→код + список остатка недель 1–4).

### 2026-10-06 — Facebook freshness sweep + вынос dead code из reparse

- **Facebook freshness (два механизма):**
  - *Feed-seen marking*: в `scrapeFacebookGroup` посты, перехваченные в фиде и совпавшие с существующими листингами (по numeric post id / clean URL), помечаются `markVerified` — бесплатное подтверждение «живости» без лишних переходов. Отсутствие в фиде **не** трактуется как удаление (скроллим ~1 страницу).
  - *`runFacebookFreshnessSweep`* (`npm run scrape:fb:freshness`, флаги `--dry-run`, `--freshness-limit=N`): аутентифицированная проверка пермалинков через Camoufox + `attachTrafficGuard`, по образцу Khmer24 sweep. Берёт только записи, просроченные по smart-queue каденции (12h/72h/7d). Деактивирует только при явных tombstone-маркерах; challenge → `blockFacebookAutomation` (fail-closed). Закрывает дыру: anonymous `checkFacebook` в `link-verifier` не видит приватные группы и всегда отвечал «alive».
- **Dead code:** `runGeminiEnrichment`, legacy-промты (`RENTAL_EXTRACTION_INSTRUCTIONS`, `CLASSIFICATION_INSTRUCTIONS`), checkpoint/eval-log/feature-discovery machinery вынесены из `scripts/reparse-listings.ts` в `scripts/reparse-legacy-enrichment.ts` (не вызывается; `scripts/_archive/` в gitignore, поэтому отдельный файл). Флаг `--reset` и неиспользуемые импорты удалены.
  - **TODO:** удалить `scripts/reparse-legacy-enrichment.ts` после успешного полного production-прогона canonical extraction. Заодно можно снести shim `classifyListingsBatchWithLLM` в `extractor.ts` — после архивации у него не осталось вызывающих.
- **Проверка:** `npm run typecheck`, `npm run lint`, jest (facebook.scraper, llm-batching, ingestion.dedup, canonical-reparse) — 54/54 passed. Живой прогон sweep не выполнялся (нужна fb_session и осторожность).
- **Примечание:** webhook/polling конфликт не исправлялся — зафиксирован в `HOMEASY_AUDIT.md` §4 как архитектурное решение на будущее.

### 2026-10-06 — Domain tracking gateway (`/r/:slug`) — MVP

- **Что сделано:** миграция v24 — таблица `tracked_links` (slug, kind miniapp|url, payload, source/campaign/group_id/post_id/request_id/listing_id/agent_id, metadata, clicks_count, last_clicked_at). Репозиторий `tracked-links.repo.ts` (base62 slug 8 chars, retry на коллизию). Роут `GET /r/:slug`: фиксирует `tracking_link_clicked` в `usage_events` + `clicks_count++`, затем 302 на `TELEGRAM_MINIAPP_URL?startapp=<payload>`; для `kind=url` — 302 на http(s)-payload (javascript:/data: отклонены). Fallback — HTML-лендинг с кнопкой. `POST /api/v1/links` — minting ссылок, только для админов. Новый env `TELEGRAM_MINIAPP_URL`.
- **Проверка:** `tests/tracking.test.ts` — 6/6 (404, minting+redirect+event+clicks_count, url-kind, 403/401, не-http payload отклонён). typecheck, lint — чисто.
- **Не сделано / настройка:** прописать в `.env`: `TRACKING_PUBLIC_URL=https://go.rustycat.cc`, `API_PUBLIC_URL=https://api.rustycat.cc` (или api.homeasy.asia, если оставить), `TELEGRAM_MINIAPP_URL=https://t.me/<BotUsername>/<AppShortName>` либо `TELEGRAM_BOT_USERNAME=<BotUsername>`; Mini App пока не читает `start_param` — следующий шаг, когда появятся demand-ссылки. Внешний сократитель не нужен: slug уже короткий, а лишний хоп теряет серверный event и увеличивает latency.
- **Инфраструктура:** добавлен `hostname: go.rustycat.cc` → `http://api:3000` в `deploy/cloudflared/config.yml`. DNS у пользователя уже настроен (CNAME DNS-only на `rustycat.cc`). После рестарта cloudflared go.rustycat.cc будет балансироваться на тот же API.
- **Изменения 2026-10-07:** добавлен `TELEGRAM_BOT_USERNAME` и fallback deep link `https://t.me/<bot_username>?startapp=<payload>`, если `TELEGRAM_MINIAPP_URL` не задан. Это избавляет от обязательного AppShortName на раннем этапе.
- **Изменения 2026-10-07 (polling/webhook):** добавлен `BOT_DELIVERY_MODE=polling|webhook`, default `polling`. В polling-режиме API не регистрирует webhook; бот явно логирует удаление оставшегося webhook и стартует long polling. В webhook-режиме бот не стартует polling, а API при старте вызывает `setWebhook` с `secret_token` и `allowed_updates`. Это убирает неявный конфликт, при котором polling-процесс мог молча снести production webhook.
- **Изменения 2026-10-07 (deploy):** локальный Docker Compose поднят с `api`, `bot`, `tunnel`; `scraper` не трогался. Публичный tracking-домен `go.rustycat.cc` настроен и отдаёт 302 на `https://t.me/Homeasy_kh_bot/HomEasyApp?startapp=<payload>`. WebApp (`homeasy.rustycat.cc`) обслуживается через Cloudflare Pages (SPA fallback 200 → index.html, `access-control-allow-origin: *`, `server: cloudflare`).
- **Изменения 2026-10-07 (tracking service):** вынесен `TrackingLinkService` (`src/services/tracking.service.ts`) — используется и API-роутом, и CLI. Добавлены dev/admin CLI: `npm run tracking:mint` и `npm run tracking:inspect`. CLI работают напрямую с БД/сервисом, не требуют Telegram initData.
- **Следующие шаги:** реальный E2E-тест: `tracking:mint` → открыть ссылку в Telegram → Mini App → `tracking:inspect`; генерация tracked links из реальных outbound-потоков (Facebook reply при demand outreach, share-кнопка в Mini App).

### 2026-10-09 — Консолидация Phase 6A и граница contact bug

- **Стадия:** принятые изменения canonical ingestion/read path, identity, tracking и Mini App собраны в отдельной локальной integration-ветке для воспроизводимой проверки; production merge/deploy не выполнялся.
- **Продуктовое решение:** основной путь остаётся browse/search-first. CTA «Мне интересно» должен создавать лёгкую цепочку `Request → Match/Offer → ContactGrant`, после которой раскрываются Chat и Call. Demand scraping остаётся дополнительным acquisition-каналом.
- **Известный баг:** разрешение Telegram-аккаунта по камбоджийскому телефонному номеру зависит от представления локального номера. Для реального короткого номера ручной `t.me` URL и Mini App bridge показывали разное поведение. Текущий Telegram formatter и regression tests сохранены, временный diagnostic UI удалён. Новые эвристики до отдельного воспроизводимого исследования не добавляются.
- **Граница релиза:** API, canary allowlist и глобальный `LISTING_READ_PATH=legacy` не меняются. Ветка сначала должна пройти полный test/build/integrity/parity gate и ревью состава файлов.

---

## Шаблон новой записи

```markdown
### YYYY-MM-DD — Краткое описание

- **Стадия:**
- **Что сделано:**
  - ...
- **Решения:**
  - ...
- **Блокеры / риски:**
  - ...
- **Метрики / наблюдения:**
  - ...
- **Следующие шаги:**
  - [ ] ...
```
