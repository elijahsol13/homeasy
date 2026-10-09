# HomEasy — Реестр источников: Siem Reap

> Живой документ. Объединяет текущий конфиг (`src/config/settings.ts`), новые группы от владельца и рекомендации GPT.
> Цель: единый source registry с ролями, приоритетами, статусом и схемой сбора статистики.

---

## Легенда

### Роль источника (source_role)

| Роль | Описание |
|---|---|
| `supply` | Преимущественно объявления о сдаче/продаже (listings). |
| `demand` | Преимущественно посты «ищу жильё» (DemandCandidate). |
| `mixed` | И supply, и demand; классифицировать оба. |
| `community` | Общий expat/community чат; парсить только housing-сигналы. |
| `watch` | Интересный, но нужна проверка активности. |
| `ignore` | Не housing-источник; не парсить. |

### Приоритет

| Приоритет | Когда парсить |
|---|---|
| **A** | Сразу, основной источник пилота. |
| **B** | Включить в пилот, но держать под наблюдением. |
| **C** | Проверить руками 2–4 недели, решить по данным. |
| **D** | Не парсить сейчас / игнорировать. |

### Статус

| Статус | Описание |
|---|---|
| `active` | Уже в `settings.ts`, скрейпер ходит. |
| `pending_join` | Запрос на вступление отправлен, но не одобрен. |
| `ready` | Есть доступ, но ещё не добавлен в скрейпер. |
| `test` | Нужен тест на public/private + активность. |
| `duplicate` | Вероятный дубликат другой группы. |
| `suspicious_url` | URL slug не соответствует названию — возможно, группа переименована. |
| `ignore` | Не housing-источник. |

---

## Facebook Groups

### A-приоритет (основа пилота)

| # | Название | URL / ID | Роль | Статус | Примечания |
|---|---|---|---|---|---|
| A1 | Expats and locals living in Siem Reap, Cambodia | `900185676717876` | mixed | active | Уже в `settings.ts`; demand + supply. |
| A2 | Siem Reap Expats & Locals | `SiemReapExpatsLocals` | mixed | active | Уже в `settings.ts`; demand + supply. |
| A3 | Real Estate in Siem Reap | `495676670504992` | mixed | ready | Новый от владельца; property marketplace. |
| A4 | SIEM REAP 🇰🇭 Rent a House, Villa, Apartment, Flat, Condo, Room, Bedspace | `201561753758474` | mixed | active | Уже в `settings.ts` как «SIEM REAP - Rent House...». |
| A5 | Siem Reap Real Estate | `siemreaprealestate` | mixed | active | Уже в `settings.ts`; supply + demand. |
| A6 | Rental & Sale Siem Reap | `385053483002145` | mixed | ready | Новый от владельца. |
| A7 | Cheap Rent Siem Reap | `cheaprentsiemreap` | mixed | active | Уже в `settings.ts`; budget supply, дубликаты вероятны. |

### B-приоритет (дополнительные)

| # | Название | URL / ID | Роль | Статус | Примечания |
|---|---|---|---|---|---|
| B1 | Expats & Locals Living in SiemReap, Cambodia | `handstandcalisthenics` | mixed | pending_join + suspicious_url | Запрос на вступление отправлен. URL slug не соответствует названию — группа переименована. Нужно уточнить numeric group ID. |
| B2 | Locals and Expats Living in Siem Reap, Cambodia | `366920920387861` | mixed | ready | Новый от владельца. |
| B3 | SIEM REAP EXPAT CONNECTIONS | `binleangheng` | community | ready + suspicious_url | URL slug личный/старое имя. Возможно, переименованная группа. |
| B4 | Siem Reap Expat Connection | `SiemReapExpatConnection` | community | ready | Новый от владельца. |
| B5 | Siem Reap Expats | `392548891350210` | community | ready | Новый от владельца. |
| B6 | Siem Reap Community | `siemreapcommunity` | demand | test | Рекомендация GPT; general community, housing intent. |
| B7 | Siem Reap Buy and Sell | `1979336498978784` | supply | test | Новый от владельца. Не путать с `youthfitness2014` (#C4). |
| B8 | Anything for Sale or Rent in Siem Reap | `408946849297703` | mixed | test | Рекомендация GPT; высокий noise. |
| B9 | Камбоджа - все там будем! | `cambodiana` | mixed | test | Русскоязычная; demand по SR + occasional supply. |

### C-приоритет (проверить)

| # | Название | URL / ID | Роль | Статус | Примечания |
|---|---|---|---|---|---|
| C1 | Siem Reap Rent, Sell and Buy properties (សៀមរាប ជួល លក់ និងទិញ) | `527059360763438` | supply | active | Уже в `settings.ts`; можно оставить. |
| C2 | Siem Reap Real Estate (Group 1435) | `1435004449876640` | supply | active | Уже в `settings.ts`. |
| C3 | Siem Reap Real Estate & Rentals (Group 1449) | `1449080965124368` | supply | active | Уже в `settings.ts`. |
| C4 | Siem Reap Buy and Sell | `youthfitness2014` | supply | active + suspicious_url | Уже в `settings.ts`. URL slug явно не соответствует названию — группа переименована. Возможный дубликат #B7. |
| C5 | Apartments & Houses In Siem Reap for Rent or Sale | `templecityrealestate` | supply | active | Уже в `settings.ts`. |
| C6 | Siem Reap Open Forum | `SiemReapOpenForum` | demand | test | Рекомендация GPT. |
| C7 | Siem Reap Residents | `233923189986441` | community | test | Рекомендация GPT. |
| C8 | Events & Activities in Siem Reap \| Cambodia | `493840595946947` | community | test | Новый от владельца; только housing-demand сигналы. |
| C9 | Ex-Pats and Locals In Siem Reap | `270186473437566` | community | test | Рекомендация GPT. |
| C10 | Siem Reap Ex-Pat Truly Open Group | `598569030200616` | community | test | Рекомендация GPT. |

### D-приоритет / агентские / специальные

| # | Название | URL / ID | Роль | Статус | Примечания |
|---|---|---|---|---|---|
| D1 | Siem Reap Brother Property Service | `524937017713486` | supply | active | Уже в `settings.ts`; возможно, группа одного агентства. Подумать: превращать в агента, а не парсить как группу? |
| D2 | Siem Reap Real Estate S R | `632004323920718` | supply | active | Уже в `settings.ts`; нужна проверка активности. |
| D3 | Siem Reap Real Estate Unique | `534172030116578` | supply | active | Уже в `settings.ts`; нужна проверка активности. |
| D4 | Sell and Buy Everything in Siem Reap | `2033812786836267` | supply | active | Уже в `settings.ts`; высокий noise. |
| D5 | Vibe Coding is Life | `vibecodinglife` | ignore | ignore | Не housing-источник. |

### Потенциальные дубликаты (требуют проверки)

| Группы | Почему похожи | Действие |
|---|---|---|
| `900185676717876` vs `siemreap` vs `366920920387861` vs `handstandcalisthenics` | Похожие названия «Expats and locals living in Siem Reap» | Проверить numeric ID и участников; возможно, одна и та же группа с разными slug/переименования. |
| `SiemReapExpatsLocals` vs `SiemReapExpatConnection` vs `binleangheng` | Похожие названия expat connections | Проверить, не одна ли группа. |
| `youthfitness2014` vs `1979336498978784` | Обе называются «Siem Reap Buy and Sell» | Проверить, разные ли это группы. |
| `siemreaprealestate` vs `1435004449876640` vs `1449080965124368` vs `495676670504992` vs `632004323920718` vs `534172030116578` | Множество «Siem Reap Real Estate» групп | Проверить активность и уникальность; часть может быть мёртвой. |

---

## Bright Data Eligibility

Bright Data Facebook Groups scraper работает **только с public groups**. Private/closed groups — через наш Camoufox-аккаунт. Free tier: **5 000 успешно полученных records/мес**; failed deliveries не тарифицируются.

### Оценки публичности (предварительные)

| # | Группа | URL/ID | Оценка публичности | BD статус | Заметки |
|---|---|---|---|---|---|
| 1 | Real Estate in Siem Reap | `495676670504992` | ✅ Public подтверждено | `bd_test_first` | Индексируются свежие rental-посты. |
| 2 | SIEM REAP Rent a House… | `201561753758474` | 🟢 Очень вероятно public | `bd_test_first` | Индексируются свежие квартиры. |
| 3 | Siem Reap Real Estate | `siemreaprealestate` | 🟢 Очень вероятно public | `bd_test_first` | И supply, и demand посты видны. |
| 4 | Rental & Sale Siem Reap | `385053483002145` | 🟢 Очень вероятно public | `bd_test_first` | Видны real demand-посты с бюджетом/условиями. |
| 5 | siem reap buy and sell | `youthfitness2014` | 🟢 Очень вероятно public | `bd_test_first` | Подозрительный slug — вероятно переименована. |
| 6 | Siem Reap Buy and Sell | `1979336498978784` | 🟢 Очень вероятно public | `bd_test_first` | Вторая buy/sell группа, проверить дубликат #5. |
| 7 | Locals and Expats Living in Siem Reap | `366920920387861` | 🟢 Очень вероятно public | `bd_test_demand` | Хороший demand source. |
| 8 | SIEM REAP EXPAT CONNECTIONS | `binleangheng` | 🟢 Очень вероятно public | `bd_test_demand` | Подозрительный slug — переименована. |
| 9 | Expats and locals… | `900185676717876` | 🟢 Очень вероятно public | `bd_test_demand` | Уже в `settings.ts`. |
| 10 | Siem Reap Expats & Locals | `SiemReapExpatsLocals` | ✅ Public, хорошее подтверждение | `bd_test_demand_first` | ~50.8K members, лучший demand source. |
| 11 | Siem Reap Expats | `392548891350210` | 🟢 Очень вероятно public | `bd_test_demand` | Demand-focused. |
| 12 | Events & Activities in Siem Reap | `493840595946947` | ✅ Public | `bd_test_optional` | Housing demand только инцидентально. |
| 13 | Siem Reap Ex-Pat Truly Open Group | `598569030200616` | 🟢 Очень вероятно public | `bd_test_optional` | Название намекает на public. |
| 14 | Ex-Pats and Locals In Siem Reap | `270186473437566` | 🟡 Вероятно / не подтверждено | `bd_test_try` | Попробовать, но не предполагать. |
| 15 | Cheap Rent Siem Reap | `cheaprentsiemreap` | 🟡 Не подтверждено public | `bd_test_try` | Живая/известная, но нет прямого подтверждения. |
| 16 | Siem Reap Community | `siemreapcommunity` | 🟡 Не подтверждено public | `bd_test_try` | Community source, privacy неизвестна. |
| 17 | Siem Reap Open Forum | `SiemReapOpenForum` | 🟡 Не подтверждено public | `bd_test_try` | Существует давно, но статус неясен. |
| 18 | Siem Reap Expat Connection | `SiemReapExpatConnection` | 🟡 Public страница, посты неясны | `bd_test_try` | Проверить BD. |
| 19 | Anything for Sale or Rent in Siem Reap | `408946849297703` | 🟡 URL подтверждён, посты неясны | `bd_test_try` | Высокий noise. |
| 20 | Expats & Locals Living in SiemReap | `handstandcalisthenics` | 🟡 Подтверждение затруднено | `bd_test_try` | Slug устарел, поисковики путают с калистеникой. |
| 21 | Камбоджа — все там будем! | `cambodiana` | 🟡 Не подтверждено | `bd_test_try` | Широкий Cambodia source. |
| 22 | Expats and locals living… | `siemreap` | 🟠 Likely private | `camoufox_only` | Старая информация указывает private, ~64k members. |
| 23 | Siem Reap Residents | `233923189986441` | 🟠 Contradictory / likely private | `camoufox_first` | Встречается label "Siem Reap Private", но индекс видит посты. Тест обязателен. |

### Стратегия использования free tier

1. **Сначала demand-группы**, а не supply. Supply уже покрыт Camoufox + Khmer24.
2. **Первыми тестировать:** `SiemReapExpatsLocals`, `900185676717876`, `495676670504992`, `385053483002145`, `siemreaprealestate`, `201561753758474`.
3. **Batch test:** все 20–22 URL по 1–3 поста за последние 2–3 дня. Bright Data не списывает quota за failed delivery.
4. После теста каждой группе проставить фактический статус:
   - `bd_scrapable: true/false`
   - `bd_last_test_at`
   - `bd_test_result: success / empty / failed / private`

---

## Другие источники

| Платформа | Название | URL | Роль | Приоритет | Статус | Примечания |
|---|---|---|---|---|---|---|
| Web | Khmer24 — Apartment for Rent (Siem Reap) | `khmer24.com/...` | supply | A | active | Core supply source #1. |
| Web | realestate.com.kh — Siem Reap rentals | `realestate.com.kh/rent/siem-reap` | supply | B | test | ~1,639 listings. Нужен анализ пересечения с Khmer24/FB. |
| Web | IPS Cambodia — Siem Reap rentals | `ips-cambodia.com/locations/siem-reap-province` | supply | C | watch | Возможен статус «rented»; потенциальный партнёр/агент. |
| Web | FazWaz Cambodia | `fazwaz-kh.com/...` | supply | C | watch | ~54 listings в SR; пока мало. |

---

## Source tracking schema

Каждый проход scraper'а создаёт запись `SourceScanRun`:

```
source_scan_run
  - id
  - source_type       (facebook, khmer24, realestate_com_kh, ips, agent)
  - source_id         (group_id / site section / agent_id)
  - source_url
  - started_at
  - finished_at
  - duration_seconds
  - posts_seen
  - posts_new
  - listing_candidates
  - demand_candidates
  - irrelevant_count
  - duplicate_count
  - parse_failures
  - errors
  - created_at
```

### Source quality dimensions

Для каждого источника считаем:

1. **Content value** — что scraper нашёл:
   - `unique_listings`
   - `unique_demand`
   - `duplicate_supply_rate`
   - `parse_failure_rate`
   - `first_seen_credit` — сколько объектов появились здесь первыми.

2. **Business value** — что это дало продукту:
   - `outreach_sent`
   - `link_clicks`
   - `requests_confirmed`
   - `contact_requests`
   - `agent_offers`
   - `rentals_attributed`

3. **Composite scores** (выводятся из данных, не придумываются):
   - Supply Score
   - Demand Score
   - Acquisition Score
   - Uniqueness Score
   - Freshness Score

### Скан-стратегия по данным

Не «все группы каждый час», а:

```
Group A: 18 unique useful items/day  → scan relatively often
Group B: 2 unique items/day          → scan less often
Group C: 95% duplicated supply       → once/day
Group D: 1 qualified renter/2 days   → demand priority
Group E: nothing useful for 3 weeks  → disable
```

---

## Пример founder daily digest

```
Siem Reap — 2026-10-06

Facebook: 487 posts scanned
- housing posts: 74
- unique new listings: 31
- demand candidates: 8

Khmer24: +24 unique listings
realestate.com.kh: not yet scanned

🔥 Best supply source: Cheap Rent — 12 unique listings
🎯 Best demand source: Expats & Locals — 4 qualified requests
📉 Duplicates across FB groups: 46%
💬 Outreach: 5
🔗 Links opened: 3
✅ Requests confirmed: 2
⚠️ 3 requests currently have <3 good matches
```

---

## Рекомендуемые следующие шаги

1. **Проверить дубликаты:** открыть Facebook и сравнить участников/посты в группах с похожими названиями.
2. **Уточнить suspicious URL:** проверить `handstandcalisthenics`, `binleangheng`, `youthfitness2014` — у них явно устаревшие slug.
3. **Проверить статус public/private:** для Bright Data test нужны public группы. Приватные останутся только для Camoufox.
4. **Добавить в `settings.ts`:** группы со статусом `ready` после проверки.
5. **Реализовать `SourceScanRun`:** начать собирать статистику по источникам.
6. **A/B-priorities:** запустить сканирование всех A + B групп на 2 недели, затем пересмотреть приоритеты по данным.

---

---

## Приложение: Bright Data batch test payload

Файл готов для первого теста через `POST /datasets/v3/scrape` (dataset ID `gd_lz11l67o2cb3r0lkj3`) или `/trigger`.
Рекомендуемые настройки: `start_date` = 2–3 дня назад, limit = 1–3 posts per group, чтобы не сжечь квоту.

### JSON-массив URL (demand-first)

```json
[
  { "url": "https://www.facebook.com/groups/SiemReapExpatsLocals" },
  { "url": "https://www.facebook.com/groups/900185676717876" },
  { "url": "https://www.facebook.com/groups/495676670504992" },
  { "url": "https://www.facebook.com/groups/385053483002145" },
  { "url": "https://www.facebook.com/groups/siemreaprealestate" },
  { "url": "https://www.facebook.com/groups/201561753758474" },
  { "url": "https://www.facebook.com/groups/366920920387861" },
  { "url": "https://www.facebook.com/groups/binleangheng" },
  { "url": "https://www.facebook.com/groups/392548891350210" },
  { "url": "https://www.facebook.com/groups/youthfitness2014" },
  { "url": "https://www.facebook.com/groups/1979336498978784" },
  { "url": "https://www.facebook.com/groups/493840595946947" },
  { "url": "https://www.facebook.com/groups/598569030200616" },
  { "url": "https://www.facebook.com/groups/270186473437566" },
  { "url": "https://www.facebook.com/groups/siemreapcommunity" },
  { "url": "https://www.facebook.com/groups/SiemReapOpenForum" },
  { "url": "https://www.facebook.com/groups/SiemReapExpatConnection" },
  { "url": "https://www.facebook.com/groups/408946849297703" },
  { "url": "https://www.facebook.com/groups/cheaprentsiemreap" },
  { "url": "https://www.facebook.com/groups/handstandcalisthenics" },
  { "url": "https://www.facebook.com/groups/cambodiana" }
]
```

### Likely private (только для Camoufox / BD test на fail)

```json
[
  { "url": "https://www.facebook.com/groups/siemreap" },
  { "url": "https://www.facebook.com/groups/233923189986441" }
]
```

### Ожидаемые результаты для записи в реестр

После теста для каждого URL заполнить:

```
- bd_scrapable: true / false
- bd_last_test_at: ISO timestamp
- bd_test_result: success / empty / failed / private
- bd_test_records_returned: N
- bd_test_notes: "..."
```

---

## Pilot test results (2026-10-06)

Запущен `BRIGHTDATA_PILOT=true npm run brightdata:test:groups`.

| # | Группа | URL/ID | Статус | HTTP | Записей | Примечание |
|---|---|---|---|---|---|---|
| 1 | Siem Reap Expats & Locals | `SiemReapExpatsLocals` | `account_inactive` | 400 | 0 | "Customer is not active" — аккаунт Bright Data требует активации. |
| 2 | Real Estate in Siem Reap | `495676670504992` | `account_inactive` | 400 | 0 | "Customer is not active" — аккаунт Bright Data требует активации. |
| 3 | Expats and locals living in Siem Reap (likely private) | `siemreap` | `unsupported_or_private` | 200 | 0 | "Private group: Only members can see who's in the group and what they post." — private, для Camoufox. |

### Выводы

- Private-группа определена корректно. Bright Data не может её собирать без членства.
- Две public-группы не вернули записи из-за **неактивированного аккаунта Bright Data**, а не из-за публичности.
- Необходимо активировать аккаунт / привязать способ оплаты (даже для free tier).
- После активации — повторить pilot, затем полный прогон.

### Артефакты

- Raw + summary: `tmp/brightdata-test/2026-10-06T03-17-13_*`

---

## Full run results (2026-10-06)

После активации аккаунта запущен полный прогон: `npm run brightdata:test:groups`.

**Параметры:**
- Date window: `2026-10-05` → `2026-10-06`
- Всего групп: 23
- Результатов: ~783 records (успешно полученных)
- Итог: 11 success / 1 no_records / 5 private / 2 snapshot_timeout / 4 fetch failed

| # | Группа | URL/ID | Статус | Records | HTTP | Примечание |
|---|---|---|---|---|---|---|
| 1 | Siem Reap Expats & Locals | `SiemReapExpatsLocals` | `success` | 149 | 202 | Public, много записей. |
| 2 | Real Estate in Siem Reap | `495676670504992` | `success` | 61 | 202 | Public. |
| 3 | Expats and locals living in Siem Reap, Cambodia | `900185676717876` | `snapshot_timeout` | 0 | 202 | Snapshot не дождался за 5 минут. Нужен retry с большим timeout. |
| 4 | Rental & Sale Siem Reap | `385053483002145` | `success` | 38 | 202 | Public. |
| 5 | Siem Reap Real Estate | `siemreaprealestate` | `success` | 73 | 202 | Public. |
| 6 | SIEM REAP Rent House, Villa, Apartment... | `201561753758474` | `success` | 57 | 202 | Public. |
| 7 | Locals and Expats Living in Siem Reap | `366920920387861` | `snapshot_timeout` | 0 | 202 | Snapshot не дождался за 5 минут. Нужен retry. |
| 8 | Siem Reap Expats | `392548891350210` | `success` | 8 | 200 | Public, мало записей за окно. |
| 9 | SIEM REAP EXPAT CONNECTIONS | `binleangheng` | `unknown` | 0 | 0 | Fetch failed — вероятно transient network error. Нужен retry. |
| 10 | siem reap buy and sell | `youthfitness2014` | `success` | 238 | 202 | Public, много записей. |
| 11 | Siem Reap Buy and Sell | `1979336498978784` | `unknown` | 0 | 0 | Fetch failed — transient. |
| 12 | Events & Activities in Siem Reap | `493840595946947` | `unknown` | 0 | 0 | Fetch failed — transient. |
| 13 | Siem Reap Ex-Pat Truly Open Group | `598569030200616` | `success` | 37 | 202 | Public. |
| 14 | Ex-Pats and Locals In Siem Reap | `270186473437566` | `unknown` | 0 | 0 | Fetch failed — transient. |
| 15 | Siem Reap Community | `siemreapcommunity` | `unsupported_or_private` | 0 | 200 | Private group. |
| 16 | Siem Reap Open Forum | `SiemReapOpenForum` | `no_records` | 0 | 202 | "This content isn't available right now" — группа или контент недоступен. |
| 17 | Siem Reap Expat Connection | `SiemReapExpatConnection` | `success` | 20 | 200 | Public. |
| 18 | Anything for Sale or Rent in Siem Reap | `408946849297703` | `unsupported_or_private` | 0 | 200 | Private group. |
| 19 | Cheap Rent Siem Reap | `cheaprentsiemreap` | `success` | 101 | 202 | Public, много записей. |
| 20 | Expats & Locals Living in SiemReap | `handstandcalisthenics` | `unsupported_or_private` | 0 | 200 | Private group (outdated slug). |
| 21 | Камбоджа — все там будем! | `cambodiana` | `success` | 1 | 202 | Public, но почти нет housing-контента. |
| 22 | Expats and locals living in Siem Reap (likely private) | `siemreap` | `unsupported_or_private` | 0 | 200 | Private group. |
| 23 | Siem Reap Residents (likely private) | `233923189986441` | `unsupported_or_private` | 0 | 200 | Private group. |

### Интерпретация

- **Public + scrapable через Bright Data:** 11 групп.
- **Private / unsupported:** 5 групп (для Camoufox).
- **Нужен retry:** 4 группы с `fetch failed` (HTTP 0) + 2 с `snapshot_timeout`.
- **Сомнительная / недоступная:** Siem Reap Open Forum — контент недоступен.

### Топ источников по количеству записей (raw)

1. `siem reap buy and sell` (`youthfitness2014`) — 238
2. `Siem Reap Expats & Locals` — 149
3. `Cheap Rent Siem Reap` — 101
4. `Siem Reap Real Estate` — 73
5. `Real Estate in Siem Reap` — 61

### Артефакты

- Raw + summary: `tmp/brightdata-test/2026-10-06T03-29-44_*`

### Следующие шаги

1. Retry `snapshot_timeout` и `fetch failed` групп с большими timeout/задержками.
2. Проверить качество записей: сколько из них реально housing supply / demand.
3. Запустить AI classifier на полученных постах.
4. Обновить `src/config/settings.ts` и scheduler: public-группы через Bright Data, private — через Camoufox.

---

## Classification report (2026-10-06)

Прогон `npm run brightdata:classify` по 872 raw-записям из full run.

Классификация: `HOUSING_SUPPLY` | `HOUSING_DEMAND` | `HOUSING_ADJACENT` | `IRRELEVANT`.
Дедупликация supply: по структурированным полям, если есть extraction, иначе по нормализованному контенту + автор.
Дедупликация demand: по структурированным полям, если есть extraction, иначе по нормализованному контенту + автор.

### Итоговая таблица по группам

| # | Группа | Raw | Supply | Demand | Adj | Irr | Unique Supply | Unique Demand | DupSupply | DupDemand | Supply % | Demand % |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | Siem Reap Expats & Locals | 83 | 5 | 1 | 4 | 73 | 5 | 1 | 0 | 0 | 6.0 | 1.2 |
| 2 | Expats and locals living in Siem Reap, Cambodia | 186 | 77 | 0 | 2 | 107 | 76 | 0 | 1 | 0 | 41.4 | 0 |
| 3 | Cheap Rent Siem Reap | 101 | 78 | 0 | 0 | 23 | 72 | 0 | 6 | 0 | 77.2 | 0 |
| 4 | Real Estate in Siem Reap | 55 | 46 | 0 | 0 | 9 | 46 | 0 | 0 | 0 | 83.6 | 0 |
| 5 | Siem Reap Buy and Sell | 131 | 51 | 0 | 0 | 80 | 45 | 0 | 6 | 0 | 38.9 | 0 |
| 6 | SIEM REAP Rent House, Villa, Apartment... | 57 | 47 | 0 | 0 | 10 | 43 | 0 | 4 | 0 | 82.5 | 0 |
| 7 | Siem Reap Real Estate | 45 | 38 | 0 | 0 | 7 | 35 | 0 | 3 | 0 | 84.4 | 0 |
| 8 | SIEM REAP EXPAT CONNECTIONS | 49 | 37 | 0 | 0 | 12 | 33 | 0 | 4 | 0 | 75.5 | 0 |
| 9 | Rental & Sale Siem Reap | 27 | 19 | 0 | 0 | 8 | 19 | 0 | 0 | 0 | 70.4 | 0 |
| 10 | Locals and Expats Living in Siem Reap | 77 | 10 | 0 | 2 | 65 | 10 | 0 | 0 | 0 | 13.0 | 0 |
| 11 | Siem Reap Expat Truly Open Group | 24 | 4 | 0 | 0 | 20 | 4 | 0 | 0 | 0 | 16.7 | 0 |
| 12 | Events & Activities in Siem Reap | 18 | 0 | 0 | 0 | 18 | 0 | 0 | 0 | 0 | 0 | 0 |
| 13 | Siem Reap Expat Connection | 11 | 0 | 0 | 0 | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| 14 | Siem Reap Expats | 7 | 0 | 0 | 0 | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| 15 | Камбоджа — все там будем! | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

### Глобальные итоги

- **Total raw:** 872
- **HOUSING_SUPPLY:** 412 (47.2%)
- **HOUSING_DEMAND:** 1 (0.1%)
- **HOUSING_ADJACENT:** 8 (0.9%)
- **IRRELEVANT:** 451 (51.7%)
- **Unique supply:** 388
- **Unique demand:** 1
- **Cross-group duplicate supply:** 24 (~5.8% от supply)

### Ключевые выводы

- **Public-группы Facebook преимущественно supply.** Даже community/expat-группы дают в основном объявления агентов/владельцев, а не запросы от renter'ов.
- **Единственный demand-источник:** `Siem Reap Expats & Locals` — 1 unique demand из 83 raw.
- **Высокая доля irrelevant:** ~52% постов — taxi, tours, food, events, general buy/sell, job, spam.
- **Duplicate rate низкий:** всего ~24 supply-поста дублируются между группами. Это потому что каждая группа имеет свой контент.
- **Лучшие supply-источники по raw и качеству:** `Siem Reap Real Estate` (84.4% supply), `Real Estate in Siem Reap` (83.6%), `SIEM REAP Rent...` (82.5%), `Cheap Rent Siem Reap` (77.2%).
- **`siem reap buy and sell`** — самый большой raw volume (238), но низкий supply rate (38.9%) и много шума.

### Ограничения

- Structured extraction (LLM) было пропущено в этом прогоне из-за Gemini rate limits; дедупликация supply основана на контенте.
- Retry `snapshot_timeout`/`fetch failed` групп ещё не делался.
- 1 demand — очень мало; нужно либо расширить окно дат, либо искать demand в других каналах (private expat-группы через Camoufox, Khmer24).

### Артефакты

- Classified posts: `tmp/brightdata-test/2026-10-06T04-50-37_classified.json`
- Group report: `tmp/brightdata-test/2026-10-06T04-50-37_group_report.json`

---

*Последнее обновление: 2026-10-06*

---

## Canonical replay: source-value review (2026-10-06)

> Этот раздел заменяет выводы старого Classification report выше для решения о
> приоритетах. Старый отчёт сохранён как исторический: он был только
> классификацией и использовал другую дедупликацию. Ниже — полный повторный
> прогон того же корпуса с canonical extraction и межгрупповой дедупликацией.

### Что записано по каждой публикации

Каждая из 872 строк в `replay-2026-10-06-0825_classified.json` хранит `id`,
`groupId`, `groupName`, `groupUrl`, URL публикации, дату, текст, автора/URL
автора (когда источник их отдал), классификацию и короткую причину. Для supply
также сохранены canonical facts и `extractedBy` (провайдер, модель, глубина
fallback). Это позволяет вернуться от любой цифры в отчёте к конкретному посту
и группе без повторного скрейпинга.

### Методика

- **Raw** — число полученных постов группы в окне данных.
- **Supply** — посты, классифицированные как предложение жилья до extraction.
- **First supply** — сколько supply-кластеров впервые встретились именно в этой
  группе после глобальной дедупликации по коду объекта либо
  автору+контактам+нормализованному тексту. Это главный показатель добавочной
  ценности группы.
- **Dup** — остальные supply-посты группы, уже встреченные в другом месте.
  Высокий Dup не значит «плохая группа»: он полезен для охвата и резервирования,
  но не оправдывает частый отдельный scan.
- **Accepted occurrences** — сколько supply-постов прошли canonical extractor.
  Это occurrences, а не число уникальных объектов; его нельзя подменять
  First supply.

### Результат по группам

| Группа | Raw | Supply | First supply | Dup | Accepted occurrences | Demand | Вывод |
|---|---:|---:|---:|---:|---:|---:|---|
| Cheap Rent Siem Reap | 101 | 73 | **46** | 27 (37%) | 71 | 0 | Главный supply-источник: много нового и мало повторов. |
| Expats and locals living in Siem Reap, Cambodia | 186 | 69 | **22** | 47 (68%) | 67 | 0 | Оставить в основном наборе: высокий абсолютный вклад, но много репостов. |
| Siem Reap Buy and Sell | 131 | 54 | **12** | 42 (78%) | 47 | 0 | Полезный широкий supply-канал; сканировать реже основных. |
| Real Estate in Siem Reap | 55 | 38 | **6** | 32 (84%) | 36 | 0 | Качественный, но в основном пересекается с первыми тремя. |
| SIEM REAP Rent a House, Villa, Apartment… | 57 | 36 | **5** | 31 (86%) | 34 | 0 | Поддерживающий supply-источник; не нужен частый отдельный scan. |
| Siem Reap Real Estate | 45 | 33 | **4** | 29 (88%) | 30 | 0 | Поддерживающий, сильное пересечение. |
| Siem Reap Expats & Locals | 83 | 4 | **3** | 1 (25%) | 1 | **1** | Низкий supply, но единственный найденный demand; держать для demand-наблюдения. |
| Rental & Sale Siem Reap | 27 | 19 | **2** | 17 (89%) | 19 | 0 | Резервный канал, сканировать редко. |
| SIEM REAP EXPAT CONNECTIONS | 49 | 26 | **1** | 25 (96%) | 25 | 0 | Почти полностью повторяет остальные supply-группы. |
| Locals and Expats Living in Siem Reap, Cambodia | 77 | 10 | **1** | 9 (90%) | 10 | 0 | Низкий добавочный supply; оставить на периодическую проверку. |
| Siem Reap Expat Truly Open Group | 24 | 3 | **1** | 2 (67%) | 3 | 0 | Слабый резервный источник. |
| Events & Activities / Siem Reap Expat Connection / Siem Reap Expats / Камбоджа — все там будем! | 37 | 0 | **0** | 0 | 0 | 0 | Для supply выключить; community-каналы можно проверять отдельно только при новой гипотезе о demand. |

### Решение по приоритетам на следующую итерацию

1. **Supply A:** Cheap Rent Siem Reap; Expats and locals living in Siem Reap,
   Cambodia; Siem Reap Buy and Sell.
2. **Supply B (реже):** Real Estate in Siem Reap; SIEM REAP Rent a House…;
   Siem Reap Real Estate.
3. **Demand watch:** Siem Reap Expats & Locals. Один demand за одно короткое
   окно не доказывает, что это лучший demand-канал, но это единственный
   подтверждённый сигнал в корпусе. Его нужно оценивать отдельной серией
   запусков по demand, а не по supply-метрике.
4. **Резерв / низкая частота:** Rental & Sale; Expat Connections; Locals and
   Expats; Truly Open.
5. **Остановить для supply:** четыре группы с нулём housing-сигналов выше —
   до новой причины их проверять.

### Ограничения и следующий замер

- Это один корпус за короткое окно, не недельная статистика. Приоритеты —
  рабочая гипотеза, а не окончательный blacklist.
- `First supply` зависит от дат публикации и качества правила дедупликации.
  Его нужно повторить за несколько независимых окон.
- 22 принятых кластеров не называют город явно; они допустимы по правилу
  «не отклонять без положительного доказательства другого города», но нуждаются
  в выборочном review до публикации.
- Следующий полезный шаг — сохранять эти же метрики в `SourceScanRun` на каждом
  рабочем скане и пересматривать приоритеты после 2–4 недель, а не по одному
  прогону.

### Артефакты

- Полный результат: `tmp/brightdata-test/replay-2026-10-06-0825_classified.json`
- Машинный отчёт: `tmp/brightdata-test/replay-2026-10-06-0825_group_report.json`
