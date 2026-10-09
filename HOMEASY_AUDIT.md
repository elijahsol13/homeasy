# HomEasy — Аудит фактического состояния vs роадмап

> Дата аудита: 2026-10-06. Проверено по коду, не по логу.
> Цель: зафиксировать, что реально реализовано, независимо от записей в `HOMEASY_LOG.md`.

---

## 1. Главные расхождения с логом

| Лог говорил | Факт в коде |
|---|---|
| «Скраперы оставлены на legacy extractor до smoke-проверки» | **Canonical extraction уже live.** `extractor.ts:307-328` делегирует в `canonical-listing-extractor.ts` + адаптер. Флага нет, legacy `SYSTEM_INSTRUCTIONS` удалён из `src/` полностью. |
| «Admin notifications — нет» | **Частично есть:** real-time alerts в Telegram (`AlertService`, `notifyAdmins`), hourly heartbeat со статистикой, daily parse-issues report. Нет именно *daily digest* воронки. |
| «Backup — нет» | **Локальный backup есть** (`backup.ts`, VACUUM INTO, ротация 7 копий, `/backup` в админке, scheduled daily). Нет **внешней** выгрузки (R2/S3). |
| «Dedupe pipeline — не сделан» | **Есть и живой:** pHash по фото + взвешенный similarity score + SHA-256 content hash в `ingestor.ts`. Не хватает только per-occurrence `raw_hash` истории. |
| «DemandCandidate — нет» | Верно, но demand-*extraction* модуль (`demand-extraction.ts`) существует — используется только в Bright Data скрипте, пишет в `tmp/`, не в БД. |
| «Human review UI — нет» | Для **листингов** review UI есть (bot callbacks + Mini App approve/reject, `review_status` в БД). Для **demand-кандидатов** — нет. |
| «Matching engine — стадия 3» | Упрощённый matcher **уже есть**: `matcher.ts` сверяет новые листинги с `search_filters` и шлёт alerts. Нет persisted `Match` и scoring. |

---

## 2. Полная матрица роадмапа → код

### Стадия 0–1: фундамент данных

| Пункт | Статус | Где / чего не хватает |
|---|---|---|
| SourceAdapter интерфейс | ❌ | Нет интерфейса; скраперы — standalone раннеры в `scheduler.ts` |
| `listing_source_occurrences` | ❌ | Таблицы нет. Re-encounter через `bumpAndMerge` на `properties` — без истории появлений/цен |
| Dedupe pipeline | ✅ частично | `deduplicator.ts` + `phash.ts` + content hash в `ingestor.ts:570-674` |
| Freshness scoring | ⚠️ частично | `last_verified_at` + smart re-verify queue (12h/72h/7d) + Khmer24 sweep + **FB freshness** (2026-10-06): feed-seen marking в `scrapeFacebookGroup` + `runFacebookFreshnessSweep` (`scrape:fb:freshness`, Camoufox permalink check, fail-closed). Нет freshness-скора в ранжировании |
| Domain tracking gateway `/r/:slug` | ✅ MVP (2026-10-06) | `tracked_links` таблица (v24), `GET /r/:slug` → `tracking_link_clicked` + 302 на `TELEGRAM_MINIAPP_URL?startapp=<payload>`, admin-minting `POST /api/v1/links`. Нет потребителей ссылок (demand outreach не реализован) и `start_param` в Mini App пока никто не читает |
| Event analytics | ⚠️ частично | `usage_events` (v10) + PostHog dual-write; фронт шлёт `contact_lead_clicked`. Нет колонок source/request_id/listing_id, нет атрибуции |
| Admin notifications | ⚠️ частично | Alerts + hourly heartbeat + daily parse-issues. Нет daily digest воронки, нет hot-request alerts |
| Внешний backup БД | ⚠️ частично | Локальный `data/backups/` (7 копий). Нет выгрузки наружу |

### Стадия 2: захват спроса

| Пункт | Статус | Где / чего не хватает |
|---|---|---|
| Классификация LOOKING_FOR_RENT в live-скраперах | ❌ | Live-скраперы supply-only (`ingestor.ts:563` отсекает всё не-rent). Demand-классификация только в `brightdata-classify.ts` |
| `demand_candidates` таблица | ❌ | — |
| Human review loop для demand | ❌ | Review UI есть только для листингов |
| Персональные domain-ссылки + FB reply | ❌ | Зависит от tracking gateway |

### Стадия 3: Request lifecycle

Всё ❌: нет `requests`, `expires_at`, статусов, persisted matches, request-страниц в Mini App.
Ближайшее: `search_filters` (статичные фильтры) + `nl_search` (парсинг запроса, агрегат в `data/search_demand_report.json`).

### Стадия 4+: агенты, офферы, монетизация

Всё ❌: `users.role` только `user|admin`. Нет `agents`, `offers`, `contact_grants`, `matches`.

---

## 3. Архитектура ingestion/AI (факт)

- **Live путь:** `facebook.scraper` / `khmer24.scraper` → `extractor.ts` shim → `canonical-listing-extractor` (AiRouter: Groq → 6 Gemini → Cloudflare) → `canonical-listing-adapter` → legacy поля + `listing_facts_json` (v23).
- **Reparse:** `scripts/reparse-listings.ts --ai` → `canonical-reparse.ts`, preview by default, `--apply` пишет в БД. Старый `runGeminiEnrichment` — **dead code** (не вызывается), содержит небезопасные legacy-промты.
- **Bright Data:** скрипты пишут только в `tmp/brightdata-test/`, в основную БД не попадает.
- **Traffic guard:** `attachTrafficGuard` стоит перед всеми навигациями (fb, k24, login, touch, reparse). ✅
- **Dead/stub код:** `remote-browser.service.ts`, `remote-browser.routes.ts` — пустые `export {}`; `telegram-auth.service.ts` — пустой.
- **NL search:** через `createAiRouter(undefined, true)` — Gemini-only.

---

## 4. Технические несоответствия, найденные аудитом

1. ~~**Dead code с риском:** `runGeminiEnrichment` + legacy prompts~~ — **вынесен** в `scripts/reparse-legacy-enrichment.ts` (2026-10-06, не вызывается). **TODO: удалить файл после успешного полного production-прогона canonical extraction.**
2. ~~**Устаревший комментарий** `reparse-listings.ts`~~ — исправлен, header обновлён.
3. ~~**Polling vs webhook конфликт**~~ — **исправлен (2026-10-07):** добавлен `BOT_DELIVERY_MODE=polling|webhook`, default `polling`. В polling-режиме бот явно логирует удаление webhook; API не регистрирует webhook. В webhook-режиме бот не стартует polling, API вызывает `setWebhook` с `secret_token`.
4. **Атрибуция теряется:** `tma_request` events пишутся без telegram_id в production (dev-header only).
5. **`properties` без `source`/`external_id` колонок** — идентичность источника только в URL-строках; `findByPostId` делает `LIKE '%id%'`.
6. **Нет price history** — `bumpAndMerge` хранит только минимальную цену.

---

## 5. Что реально осталось из «недель 1–4» роадмапа

Ближайшие по ценности (большинство — чистая стадия 1):

- [ ] `listing_source_occurrences` + source/external_id колонки → price history, per-source freshness, first_seen_credit
- [x] Domain tracking gateway `/r/:slug` + `tracking_link_clicked` (MVP; осталось: выделить сабдомен на API → cloudflared, задать `TELEGRAM_MINIAPP_URL`, научить Mini App читать `start_param`)
- [ ] Расширить `usage_events` колонками (source, request_id, listing_id, agent_id) или новая `events` таблица
- [ ] `demand_candidates` таблица + classification в live FB-скрапере (модуль extraction уже есть)
- [ ] Demand review UI (переиспользовать существующий listing review flow)
- [ ] External backup upload (R2) поверх существующего `backup.ts`
- [ ] `SourceAdapter` интерфейс (есть смысл делать вместе с occurrences — adapter пишет occurrences)
- [ ] Request entity + lifecycle (стадия 3) — блокируется demand capture
- [x] Вынести dead code `runGeminiEnrichment` → `scripts/reparse-legacy-enrichment.ts` (TODO: удалить после успешного полного prod-прогона canonical extraction)
- [ ] Удалить dead code (`remote-browser` stubs, пустой `telegram-auth.service.ts`, неиспользуемый shim `classifyListingsBatchWithLLM` в `extractor.ts`)
- [ ] Устранить polling/webhook конфликт при деплое

*Составлено автоматическим аудитом кода; детали — в отчётах по файлам.*
