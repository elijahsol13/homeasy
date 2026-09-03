# 🏡 HomEasy — Cambodia Real Estate Aggregator & Telegram Bot

> A production-grade Telegram bot for discovering and tracking rental and sale listings in **Siem Reap** and **Phnom Penh**, Cambodia.

Built with **TypeScript · Node.js 22+ · grammY · node:sqlite (native) · Playwright (Stealth) · Google Gemini 3.5 Flash · Jimp (pHash) · Zod**

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔔 Smart Alerts | 8-step wizard: Type, Category, City, Sangkats, Budget, Bedrooms, Pool, Lease Term |
| 🧠 Matching Engine | Instantly matches new listings against all active user search filters |
| 🤖 Multilingual AI Extractor | Uses **Google Gemini 3.5 Flash Lite** (Free Tier) to translate Khmer, extract structured JSON, and generate bullet points |
| 🚫 Anti-Spam Gateway | Silently drops non-real-estate items (second-hand goods, vehicles) and land sales |
| 🚩 Community Moderation | Users can report fake or rented listings with 1 click; 3 reports automatically deactivates the listing |
| ⏸ Pause & Resume Alerts | Users can pause notifications anytime without blocking the bot |
| 🤖 Automated Scrapers | Headless Playwright (Stealth) scrapers for Facebook Groups & Khmer24 |
| ⏰ Background Cron | Runs every 20 minutes via `node-cron` (`*/20 * * * *`) with concurrency locks |
| 🖼️ Multi-Image pHash | Computes 64-bit pHash for up to 3 images; triggers duplicate on >= 2 matches (<= 5 distance) |
| ⚖️ Weighted Similarity Scoring | Scores candidates (0-90 pts) across price (±5%), beds/baths, phone, and category (threshold >= 75) |
| ⭐ Favorites | Save listings with pagination, remove anytime |
| 🚦 Rate Limiting | 1 msg/sec per user queue — respects Telegram API limits |
| 👑 Admin Commands | `/ingest_json` for bulk import, `/stats` for metrics dashboard |

---

## 🗂 Project Structure

```
src/
├── config/
│   ├── env.ts               # Zod-validated environment variables
│   └── settings.ts          # Siem Reap Sangkats, Phnom Penh districts, constants
├── database/
│   ├── db.ts                # Singleton DatabaseSync instance (node:sqlite, WAL mode)
│   ├── migrate.ts           # Append-only migration runner (v1–v7)
│   └── repositories/
│       ├── users.repo.ts
│       ├── filters.repo.ts
│       ├── properties.repo.ts
│       └── favorites.repo.ts
├── modules/
│   ├── bot/
│   │   ├── bot.ts           # Bot factory + middleware stack
│   │   ├── session.ts       # SessionData types + 8-step wizard state
│   │   ├── handlers/
│   │   │   ├── start.handler.ts
│   │   │   ├── filters.handler.ts   # 8-step filter wizard
│   │   │   ├── favorites.handler.ts
│   │   │   ├── admin.handler.ts
│   │   │   └── callbacks.handler.ts # Central callback router
│   │   └── keyboards/
│   │       ├── main.keyboard.ts
│   │       ├── filter.keyboard.ts
│   │       └── listing.keyboard.ts
│   ├── matcher/
│   │   └── matcher.ts       # Matching engine (type, city, category, pool, lease, price, beds)
│   └── parser/
│       ├── schemas.ts       # Zod schemas (raw + clean)
│       ├── normalizer.ts    # Text/price/phone utilities
│       ├── extractor.ts     # Multilingual Gemini AI & Regex heuristics
│       ├── phash.ts         # Perceptual image hashing & Hamming distance
│       ├── fb-login.ts      # One-time manual Facebook login session saver
│       ├── facebook.scraper.ts # Stealth Facebook Group scraper
│       ├── khmer24.scraper.ts  # Playwright Stealth headless Khmer24 scraper
│       └── ingestor.ts      # ingestRawListing() with multi-signal dedup
└── services/
    ├── notifier.ts          # Rate-limited photo notification dispatcher
    └── scheduler.ts         # 20-minute cron scheduler for automated scraping
```

---

## 🚀 Local Setup

### Prerequisites

- **Node.js 22+** (uses native `node:sqlite`) — [nodejs.org](https://nodejs.org)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))
- A Google Gemini API Key (100% Free Tier from [Google AI Studio](https://aistudio.google.com/))

### Step 1 — Clone & Install

```bash
git clone <your-repo-url> homeasy
cd homeasy
npm install
npx playwright install chromium
```

### Step 2 — Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
ADMIN_IDS=123456789          # Your Telegram user ID
GEMINI_API_KEY=AIzaSy...     # Free tier key from Google AI Studio
DATABASE_PATH=./data/homeasy.db
NODE_ENV=development
```

### Step 3 — Run in Development Mode

```bash
npm run dev
```

The bot will:
1. Apply database migrations automatically (v1–v7)
2. Register bot command hints in Telegram
3. Start the background scraping cron (runs every 20 mins)
4. Start long-polling for updates
5. Hot-reload on any `.ts` file change (via nodemon)

---

## 🛠 Manual Scraper Execution

### 1. Facebook Group Scraper
1. **Save Facebook Session (one-time setup):**
   ```bash
   npm run fb:login
   ```
2. **Run Facebook Scraper:**
   ```bash
   npm run scrape:fb
   ```

### 2. Khmer24 API Scraper
Run the automated headless Khmer24 scraper on-demand:
```bash
npm run scrape:khmer24
```

---

## 🧪 Running Tests

HomEasy includes automated integration and unit test suites:

```bash
npm test
```
