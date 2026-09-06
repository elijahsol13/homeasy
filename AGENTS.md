# 🤖 Project Rules & Inviolable Principles for AI Agents & Developers

## 🛡️ IRONCLAD RULE: AGGRESSIVE TRAFFIC CONSERVATION ON RESIDENTIAL PROXIES

> **CRITICAL MANDATE**: Residential proxy bandwidth is metered and expensive ($2 - $10+ per Gigabyte).
> **EVERY AGENT AND DEVELOPER MUST ACTIVELY SEEK, PROPOSE, AND ENFORCE TRAFFIC REDUCTIONS IN ALL PROXY-ROUTED CODE.**
> Wasting proxy bandwidth on binary data or unneeded telemetry is treated as a critical regression.

---

### 1. The 5 Zero-Tolerance Proxy Invariants

1. **NO UNFILTERED BROWSER CONTEXTS**:
   - **NEVER** launch a Playwright or Puppeteer browser/context with a proxy and call `page.goto()` without an active route interception filter.
   - You MUST attach resource blocking (`page.route` or `attachTrafficGuard`) **before** any navigation happens.

2. **ABORT 100% OF BINARY IMAGES & MEDIA**:
   - Photo URLs, albums, and CDN links are extracted as **string URLs** from JSON API payloads (GraphQL Relay, REST) or HTML DOM attributes (`src`, `data-src`, `image.uri`).
   - The browser worker **NEVER** needs to download or render the binary image blobs (`.jpg`, `.png`, `.webp`, `scontent*`, `fbcdn.net`, `khmer24.com/photos`).
   - Aborting images, videos, audio, and animations saves **85% to 95%** of page weight.

3. **ABORT FONTS, STYLESHEETS & NON-ESSENTIALS**:
   - Headless scraping agents do not look at layouts or fonts.
   - Abort resource types: `['image', 'media', 'font', 'stylesheet', 'other']`.
   - Only allow stylesheets if interactive human visual login (e.g. Remote Browser) is strictly taking place.

4. **ABORT TELEMETRY, ANALYTICS & LOGGING BEACONS**:
   - Facebook, Khmer24, and third-party sites stream megabytes of telemetry:
     - `facebook.com/ajax/bz`, `facebook.com/tr/`, `connect.facebook.net/signals`
     - `graph.facebook.com/logging_client_events`
     - `google-analytics.com`, `googletagmanager.com`, `doubleclick.net`, `onesignal`
   - Abort these unconditionally.

5. **PREFER TEXT-ONLY / DIRECT API / MOBILE OVER DESKTOP BROWSERS**:
   - Always evaluate and propose text-only endpoints:
     - Direct HTTP JSON requests with session cookies instead of spinning up Chromium.
     - Mobile versions (`m.facebook.com`, `mbasic.facebook.com`) which transfer ~50 KB compared to 15 MB on desktop Facebook (a **99% reduction**).
   - Only route domains that strictly require proxying / bypass geo-blocking. Never route Telegram API, AI API, or internal services through residential proxies.

---

## 🛠️ Implementation Standard

Use `attachTrafficGuard(page)` from `src/modules/parser/traffic-guard.ts` across all scrapers, test helpers, and maintenance scripts.
