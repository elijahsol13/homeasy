# 🏡 HomEasy — Cambodia Real Estate Aggregator, Telegram Bot & Mini App

> Enterprise-grade real estate aggregator, notification bot, and interactive Telegram Mini App (TMA) for **Siem Reap** and **Phnom Penh**, Cambodia.
>
> Built with **TypeScript · Node.js 22+ (Native SQLite WAL) · grammY · Fastify · React / Vite · Camoufox driven by Playwright · Google Gemini · Sharp (pHash) · Cloudflare Zero Trust · Docker Compose**.
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
                                              │ Direct host internet
                                              ▼
                                ┌──────────────────────────┐
                                │  Residential connection  │
                                │ MacBook → home CGNAT host │
                                └──────────────────────────┘
```

---

## 🛡️ Core Engineering Highlights

### 0. Scraper runtime and efficiency

- Scrapers use the host's ordinary residential internet connection, on MacBook/Docker now and a home server behind CGNAT later.
- Install `attachTrafficGuard` before browser navigation; extract photo URLs from GraphQL/REST/DOM without downloading unnecessary image/media/font binaries or telemetry in headless scraping. Attended visual login can load required resources.
- Facebook uses a pinned host-specific Camoufox fingerprint and saved session; authentication remains manual, with session and concurrency safety locks.
- The existing Facebook scheduler rotates groups, defaults to a 110-minute cycle pause, and exits early on previously seen posts. Do not change scraping cadence without a separate reason.

### 1. Trio-Container Architecture
- **`homeasy-bot`**: Telegram Bot UI powered by `grammY`, natural language search (voice note / text query parsing with Gemini), interactive 8-step manual filter wizard, subscriptions, instant push alerts with multi-photo albums (up to 3 photos), and button-driven Admin Dashboard (`/admin`).
- **`homeasy-scraper`**: Sequential worker with HTTP-first Khmer24 extraction and pinned Camoufox Facebook sessions, round-robin group batching, persistent checkpoint safety lock, and automatic garbage collection (`--expose-gc`).
- **`homeasy-api`**: High-throughput Fastify HTTP/WebSocket server serving the Telegram Mini App (TMA), map markers, search endpoints, and remote browser streaming.
- **SQLite WAL**: Single unified database `data/homeasy.db` running in Write-Ahead Logging mode (14 automated migrations), enabling non-blocking concurrent reads and atomic transactional writes.

### 2. Facebook Scraping via GraphQL Relay Interception
- **Immunity to CSS obfuscation**: Does not rely on fragile HTML selectors that Facebook rotates weekly.
- **Network-level capture**: Intercepts internal `/api/graphql/` responses at the Playwright network stack to obtain:
  - Full untruncated post content (`node.comet_sections.content.story.message.text`), preventing `... See more` truncations.
  - 100% original full-resolution photo URLs from sub-attachments and albums (`all_subattachments`).
  - Exact author metadata and Unix timestamps.

### 3. Attended Local Authentication and Fail-Closed Safety
- Facebook credentials and 2FA are entered only by a human in a headed Camoufox window on the scraper host.
- Login and scraping share the same pinned `data/fb_device.json` and `data/fb_session.json` identity.
- `data/fb_runtime.lock` prevents concurrent login and scraper processes.
- Checkpoint, login, recovery, or identity-confirmation pages persist a safety lock and stop future scheduled attempts.
- Only a successful attended `npm run fb:login` clears the safety lock; Telegram credential entry, session upload, and remote browser streaming are not exposed.

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
│   │   └── parser/          # Scrapers (GraphQL FB, Khmer24), extractors and traffic guard
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

# Local manual Facebook login on the direct Cambodian connection
npm run fb:login

# One-group, one-scroll smoke run that does not advance round-robin state
npm run scrape:fb:smoke -- --group=0

# Telegram Webhook Management (with secret_token protection)
npm run webhook:info                     # Check current webhook URL, error state & pending updates
npm run webhook:set -- <url> [secret]    # Register webhook with X-Telegram-Bot-Api-Secret-Token
npm run webhook:delete                  # Clear webhook and revert to long-polling mode

# Start all services with Docker Compose
docker compose up -d --build
```

---

## 🔒 Security & Reliability
1. **Local Authentication Only**: Facebook credentials, 2FA, and storage state are never accepted through Telegram or an HTTP endpoint.
2. **RAM Guardrails**: `docker-compose.yml` enforces strict memory constraints (Bot: 200M, Scraper: 750M, API: 350M).
3. **Scraper Safety**: Checkpoints and session invalidation persist a fail-closed lock; scheduled scraping remains stopped until a successful attended local login.
4. **Webhook `secret_token` Invariant**: When running in webhook mode, the endpoint (`/api/v1/telegram/webhook`) enforces timing-safe verification of the `X-Telegram-Bot-Api-Secret-Token` header configured during `setWebhook`. Any request lacking this header or carrying an invalid token is aborted with `401 Unauthorized` before body parsing or bot handler execution, neutralizing spoofed JSON payloads.
