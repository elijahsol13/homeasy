# 🏡 HomEasy — Cambodia Real Estate Aggregator, Telegram Bot & Mini App

> Enterprise-grade real estate aggregator, notification bot, and interactive Telegram Mini App (TMA) for **Siem Reap** and **Phnom Penh**, Cambodia.
>
> Built with **TypeScript · Node.js 22+ (Native SQLite WAL) · grammY · Fastify · React / Vite · Playwright Stealth · Google Gemini · Sharp (pHash) · Cloudflare Zero Trust · Docker Compose**.
>
> 🇷🇺 *Русская версия документации доступна в [README.ru.md](README.ru.md).*

---

## 🏛️ High-Level Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │          Cloudflare Quick Tunnel             │
                       │    (Free SSL, Persistent, No Domain Needed)  │
                       └──────────────────────┬───────────────────────┘
                                              │ WSS / HTTPS
                     ┌────────────────────────┴────────────────────────┐
                     │                                                 │
                     ▼                                                 ▼
      ┌─────────────────────────────┐                  ┌──────────────────────────────┐
      │      Telegram Bot UI        │                  │      Fastify API & Admin     │
      │        (homeasy-bot)        │                  │        (homeasy-api)         │
      │  grammY · Filters · Alerts  │                  │  REST API · WSS Screencast   │
      └──────────────┬──────────────┘                  └──────────────┬───────────────┘
                     │                                                │
                     │          ┌──────────────────────────┐          │
                     ├─────────►│  Shared SQLite Database  │◄─────────┤
                     │          │   (data/homeasy.db WAL)  │          │
                     │          └─────────────▲────────────┘          │
                     │                        │                       │
                     │          ┌─────────────┴────────────┐          │
                     └─────────►│ Playwright Scraper Worker│◄─────────┘
                                │    (homeasy-scraper)     │
                                │ GraphQL Relay · Stealth  │
                                └─────────────┬────────────┘
                                              │ Proxy Tunnel
                                              ▼
                                ┌──────────────────────────┐
                                │ Cambodian Resident Proxy │
                                │   (FB_PROXY / K24 Proxy) │
                                └──────────────────────────┘
```

---

## 🛡️ Core Engineering Highlights

### 0. ⚡ IRONCLAD RULE: RESIDENTIAL PROXY BANDWIDTH PRESERVATION
> ⚠️ **CRITICAL INVARIANT**: Residential proxy bandwidth is metered and costly ($2–$10+/GB).  
> **ALWAYS ACTIVELY SEEK, PROPOSE, AND IMPLEMENT BANDWIDTH-SAVING STRATEGIES ACROSS ALL PROXY CODE.**  
> Wasting proxy bandwidth on media downloads or unfiltered page contexts is treated as a critical regression.
>
> 1. **No Unfiltered Contexts**: Never initialize Chromium and navigate (`page.goto`) without active route interception (`page.route` / `attachTrafficGuard`).
> 2. **100% Binary Media Blocking**: Photo URLs are parsed as strings from GraphQL/REST JSON or DOM attributes. The browser **must NEVER download binary images or videos** over the proxy (saving 85%–95% of bandwidth).
> 3. **Block Fonts, Styles & Telemetry**: Stylesheets, web fonts, and tracking beacons (`facebook.com/ajax/bz`, `pixel`, analytics, falco, speed telemetry) must be aborted unconditionally.
> 4. **Persistent Disk Cache**: Browser cache (`data/browser_cache/http_cache`) persists immutable CDN JS bundles across runs, reducing warm group visits to as little as ~350 KB.
> 5. **Round-Robin Group Rotation**: Scrapes a sliding window of 5 groups per cycle (tracked via `data/scraper_state.json`) with an extended 110-minute inter-cycle pause (~12 cycles/day).
> 6. **Intelligent Early Exit**: Chronologically halts pagination (`FB_EARLY_EXIT_THRESHOLD=3`) upon encountering consecutive posts already present in the database, with maximum 1 scroll per group (`FB_MAX_SCROLLS_PER_GROUP=1`).
> 7. **Selective Proxying**: Only proxy domains that are geo-restricted (Facebook). Khmer24, internal services, AI models, and Telegram API never pass through paid proxies.

### 1. Trio-Container Architecture
- **`homeasy-bot`**: Telegram Bot UI powered by `grammY`, natural language search (voice note / text query parsing with Gemini), interactive 8-step manual filter wizard, subscriptions, instant push alerts with multi-photo albums (up to 3 photos), and button-driven Admin Dashboard (`/admin`).
- **`homeasy-scraper`**: Autonomous cyclic worker (~110-minute pause), Playwright Stealth with persistent disk cache, round-robin Facebook group batching, session monitoring, circuit breakers, and automatic garbage collection (`--expose-gc`).
- **`homeasy-api`**: High-throughput Fastify HTTP/WebSocket server serving the Telegram Mini App (TMA), map markers, search endpoints, and remote browser streaming.
- **SQLite WAL**: Single unified database `data/homeasy.db` running in Write-Ahead Logging mode (14 automated migrations), enabling non-blocking concurrent reads and atomic transactional writes.

### 2. Facebook Scraping via GraphQL Relay Interception
- **Immunity to CSS obfuscation**: Does not rely on fragile HTML selectors that Facebook rotates weekly.
- **Network-level capture**: Intercepts internal `/api/graphql/` responses at the Playwright network stack to obtain:
  - Full untruncated post content (`node.comet_sections.content.story.message.text`), preventing `... See more` truncations.
  - 100% original full-resolution photo URLs from sub-attachments and albums (`all_subattachments`).
  - Exact author metadata and Unix timestamps.

### 3. Remote Visual Browser Authentication from Mobile
- **Anti-ban protection**: Headless automated credential submission on Facebook triggers immediate checkpoint blocks.
- **Interactive browser stream**: Admin generates a signed 15-minute HMAC-SHA256 session link (`/auth_fb` or via `/admin`).
- **Low-latency mobile streaming**:
  - Viewport optimized for mobile screens (`414x750`, iPhone Mobile Viewport).
  - 45% JPEG compression with frame downsampling (`everyNthFrame: 2`), reducing network overhead from 180 KB to ~15 KB per frame.
  - Client backpressure protection: automatically drops queued frames when the client connection lags.
  - Quick-focus buttons (`👤 Username`, `🔑 Password`, `🚀 Sign In`) for hassle-free entry from mobile virtual keyboards.
  - Session cookies persisted automatically to `data/fb_session.json` without container restarts.

### 4. Two-Tier Property Extractor (Regex Heuristics + 12-Model Gemini AI Cascade)
- **Tier 1 (Instant Heuristics)**: Zero-cost instant regex extraction:
  - Cambodian utility rates: Electricity (EDC ~$0.20/kWh, fixed `$0.25/kWh`, `1000៛/kWh`), Water (state rate ~1000៛/m³, `$5/person`, included), cleaning services, deposits.
  - Property restrictions: No Pets, No Smoking, Quiet Hours, No Subleasing.
  - Strict 3-Way Location Consensus: Cross-validates post text, GPS coordinates, and Sangkat landmarks. Protects against "borrowed prestige" clickbait (e.g., "5 mins to BKK1") by strictly separating actual districts (`location`) from promotional markers (`marketing_landmarks`).
- **Tier 2 (Resilient AI Model Cascade)**:
  - Micro-batching (5–8 properties per request) slashing token consumption by 85%.
  - 12-model cascade ordered from smartest to lightest:
    `gemini-3.8-flash` ➔ `gemini-3.7-flash` ➔ `gemini-3.6-flash` ➔ `gemini-3.5-flash` ➔ `gemini-3.5-flash-lite` ➔ `gemini-3.1-flash-lite` ➔ `gemini-3.1-flash-lite-preview` ➔ `gemini-3-flash-preview` ➔ `gemini-flash-lite-latest` ➔ `gemini-flash-latest` ➔ `gemini-pro-latest` ➔ `gemma-4-26b-a4b-it`.
  - **Circuit Breaker Engine**: Automatically trips 30-minute cooldown on HTTP `503` (High Demand) and `429` (Quota Exceeded / Resource Exhausted), seamlessly falling over to the next tier model without delay or stalls.
  - Extraction of extended amenities (backup generators, bathtubs, washing machines, western kitchens, elevators, security).

### 5. Telegram Mini App (TMA) & Interactive Map
- Single Page Application with seamless Telegram Dark/Light theme adaptation.
- **Deterministic Micro-Jitter Map**: Eliminates map pin overlapping/clustering issues. Properties without exact GPS coordinates are assigned a pseudo-random, deterministic offset (~330m) around their district centroid based on their `property.id`.
- Interactive Leaflet map with clustering and coordinate Bounding Box filtering (+20% overscan buffer for smooth panning).
- Full-screen photo gallery with native mobile touch-swipe carousel displaying all captured listing photos.
- Granular search filters: city (Siem Reap / Phnom Penh), district, category (apartment, house, villa, room, hotel), budget range, swimming pool, and pet-friendly.
- One-click agent contact actions (direct phone call, Telegram handle).

---

## 🗂 Repository Structure

```
homeasy/
├── src/
│   ├── config/              # Environment variables (Zod schema), geo-zones, landmarks
│   │   ├── env.ts           # Strict configuration validation
│   │   ├── locations.ts     # City & district coordinates and 3-way consensus
│   │   └── landmarks.ts     # Curated landmark database (Siem Reap & Phnom Penh)
│   ├── database/            # SQLite setup and migrations (v1 - v12)
│   │   ├── db.ts            # SQLite WAL connection singleton (node:sqlite)
│   │   ├── migrate.ts       # Database migrations (utility specs, landmarks, metrics)
│   │   ├── backup.ts        # Automated SQLite snapshot creation & retention pruning
│   │   ├── enrich-properties.ts # Heuristic backfill and spam cleanup script
│   │   └── repositories/    # Data access layer (Properties, Users, Metrics, Analytics)
│   ├── modules/
│   │   ├── api/             # Fastify REST API for Mini App & WebSocket Screencast
│   │   ├── bot/             # Telegram bot (grammY): NL search, wizard, alerts, admin panel
│   │   ├── matcher/         # Subscription scoring and matching engine
│   │   └── parser/          # Scrapers (GraphQL FB, Khmer24 Stealth), extractors, proxy
│   └── services/
│       ├── alert.service.ts # In-App Admin Alerting Service (Telegram delivery)
│       ├── nl-search.service.ts # Natural language query parsing via Gemini
│       ├── remote-browser.service.ts # Playwright CDP screencast streaming engine
│       ├── scheduler.ts     # Cyclic scheduler (Khmer24 -> FB -> GC -> Maintenance)
│       └── notifier.ts      # Push notification formatter and album dispatcher
├── scripts/
│   ├── reparse-listings.ts  # Background reparser with AI enrichment
│   └── pack-codebase.js     # Codebase repomix packager
├── webapp/                  # Telegram Mini App source (React + Vite + Tailwind CSS)
├── tests/                   # Test suites (23 suites, 267 unit and integration tests)
├── docker-compose.yml       # 3-container microservices definition with memory limits
├── package.json
└── README.md
```

---

## 🚀 Development & Operational Commands

```bash
# Compile TypeScript
npm run build

# Run unit and integration tests (Jest)
npm test

# Verify TypeScript types
npm run typecheck

# Build Telegram Mini App (Vite)
npm --prefix webapp run build

# Safe background re-parsing and enrichment
npm run reparse:listings -- --ai         # LLM enrichment with evaluation report
npm run reparse:listings -- --fb         # Smooth Facebook crawl with anti-throttling delay
npm run reparse:listings -- --khmer24    # Update Khmer24 listings with all full-res photos

# Local manual Facebook login through residential proxy
npm run fb:login

# Telegram Webhook Management (with secret_token protection)
npm run webhook:info                     # Check current webhook URL, error state & pending updates
npm run webhook:set -- <url> [secret]    # Register webhook with X-Telegram-Bot-Api-Secret-Token
npm run webhook:delete                  # Clear webhook and revert to long-polling mode

# Start all services with Docker Compose
docker compose up -d --build
```

---

## 🔒 Security & Reliability
1. **Token Authentication**: Remote browser session tokens are cryptographically signed using HMAC-SHA256 with the bot token secret and have a strict 15-minute validity window.
2. **RAM Guardrails**: `docker-compose.yml` enforces strict memory constraints (API: 150M, Bot: 200M, Scraper: 750M) to guarantee stability on 1 GB RAM servers (such as AWS t3.micro).
3. **Scraper Safety**: Upon detecting checkpoints, CAPTCHA challenges, or session invalidation, the scraper halts execution immediately and delivers an actionable alert to administrators.
4. **Webhook `secret_token` Invariant**: When running in webhook mode, the endpoint (`/api/v1/telegram/webhook`) enforces timing-safe verification of the `X-Telegram-Bot-Api-Secret-Token` header configured during `setWebhook`. Any request lacking this header or carrying an invalid token is aborted with `401 Unauthorized` before body parsing or bot handler execution, neutralizing spoofed JSON payloads.
