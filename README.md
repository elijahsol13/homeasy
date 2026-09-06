# 🏡 HomEasy — Cambodia Real Estate Aggregator & Telegram Bot

> Production-grade real estate aggregator and Telegram bot for **Siem Reap** and **Phnom Penh**, Cambodia.

Built with **TypeScript · Node.js 22+ · grammY · native SQLite (WAL) · Playwright Stealth · Google Gemini 2.5 Flash · Sharp (pHash) · Docker Compose**.

---

## ✨ Features

- **Dual-Container Architecture:** Separate `bot` (Telegram polling & user UI) and `scraper` (Playwright worker with circuit breakers and session monitoring) containers sharing a persistent SQLite volume in WAL mode.
- **Smart Notification Cards:** Dynamic cards featuring property type (`Flat House`, `Private Villa`, `Condo`, `Apartment`, `Hotel Room`), 3-way location cross-validation (`📍 Sala Kamreuk ↗`), and clickable golden landmarks (`🚩 Landmark: Pub Street / Old Market ↗`).
- **Cambodian Utilities & Specs:** Auto-extracts electricity (`⚡ EDC ~$0.20/kWh` or fixed rates) and water (`💧 Included`, `State Rate ~1000៛/m³`, or `$5/person`), cleaning frequencies, and house rules/restrictions (`🚫 No Pets`, `🚭 No Smoking`).
- **Geo-Sanity & Consensus Engine:** Validates coordinates against city boundaries, rejects pins inside water bodies (Lake Tonle Sap), and enforces a 2-against-1 majority consensus across coordinates, listing text, and category dropdowns.
- **Multi-Image Deduplication:** Computes 64-bit dHash perceptual image hashes with Sharp across multiple photos alongside weighted attribute scoring (price ±5%, rooms, phone, category).
- **Resilient AI Extraction Cascade:** Cascades through `gemini-2.5-flash` ➔ `gemini-2.5-flash-lite` ➔ `gpt-4o-mini` ➔ regex heuristics, featuring batching (5–10 items) to conserve API quotas.
- **Scraper Circuit Breaker:** Isolated scraping loops with automatic error handling, exponential backoff, and Telegram admin alerts for expired cookies (Facebook and Khmer24).
- **Persistent Scraper Metrics & Analytics:** Long-term historical database tracking (`scraper_metrics`, `usage_events`) with hourly Telegram Heartbeat reports.
- **Remote Visual Browser Streaming:** Mobile-friendly interactive CDP browser screencast for 100% human-driven Facebook (proxied) and Khmer24 authentication.

---

## 🛡️ Critical Architectural Principle: Facebook Scraping & Authentication

> ⚠️ **Критический архитектурный закон HomEasy**:  
> **Вход в Facebook через консольные скрипты или headless-автоматизацию ввода паролей — это верный путь к мгновенному чекпоинту или блокировке аккаунта.**  
> В связи с этим в проекте HomEasy строго зафиксировано:
> 1. **Обязательный резидентный прокси:** Любые сетевые обращения к Facebook (парсинг и авторизация) маршрутизируются исключительно через резидентный камбоджийский прокси (`FB_PROXY`). Запуск без прокси заблокирован на уровне кода с алертом админу.
> 2. **Исключительно визуальный вход человеком:** Авторизация Facebook ДОЛЖНА осуществляться человеком через реальный графический интерфейс (с живыми интервалами ввода, решением 2FA и чекпоинтов безопасности). Любой программный headless-ввод учетных данных запрещен.
> 3. **Удаленная авторизация с телефона (Remote Browser Streaming):** Для удобного входа с мобильного телефона в Telegram реализован веб-интерфейс (`/auth_fb`): сервер запускает Chromium через прокси и транслирует живой экран (CDP Screencast) на телефон. Вы пальцем вводите пароль и 2FA в реальном окне Facebook, а сессия автоматически сохраняется в `data/fb_session.json`.

---

## 🗂 Architecture & Code Structure

```
src/
├── config/
│   ├── env.ts               # Zod-validated environment config
│   ├── settings.ts          # Districts, sangkats, rates & thresholds
│   ├── locations.ts         # Geo-bounds, Haversine distance, 3-way consensus
│   └── landmarks.ts         # Golden landmarks dictionary & text extractor
├── database/
│   ├── db.ts                # node:sqlite singleton in WAL mode
│   ├── migrate.ts           # Append-only migrations
│   └── repositories/        # users, filters, properties, favorites
├── modules/
│   ├── bot/                 # grammY bot, 8-step wizard, interactive keyboards
│   ├── matcher/             # User filter matching engine
│   └── parser/              # Facebook & Khmer24 scrapers, LLM extractors, Sharp pHash
└── services/
    ├── notifier.ts          # Rate-limited Telegram card dispatcher
    ├── scheduler.ts         # ScraperWorker daemon loop & cron
    └── backup.ts            # Daily automated SQLite backups
```

---

## 🚀 Deployment & Quickstart

### 1. Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Key environment variables:

```env
BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
ADMIN_IDS=123456789
GEMINI_API_KEY=AIzaSy...
DATABASE_PATH=/app/data/homeasy.db
BACKUP_PATH=/app/backups
NODE_ENV=production
```

### 2. Docker Compose (Production)

Run the dual-container setup:

```bash
docker compose up -d --build
```

- **Bot Container:** Handles real-time Telegram interactions, instant notifications, and alerts.
- **Scraper Container:** Executes Playwright headless scraping for Khmer24 and Facebook with 20-minute intervals and session health checks.

### 3. Local Development & Testing

```bash
# Install dependencies & browsers
npm install
npx playwright install chromium

# Run automated test suites (169+ tests)
npm test

# Build TypeScript
npm run build
```

---

## 🛠 Manual Scraper Commands

```bash
# Manual Facebook login session bootstrap
npm run fb:login

# Run one-off scrapers
npm run scrape:fb
npm run scrape:khmer24
```
