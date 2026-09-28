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

5. **PREFER TEXT-ONLY / DIRECT HTTP OVER BROWSERS**:
   - Always evaluate direct HTTP HTML/JSON extraction before launching a browser.
   - Never use mobile Facebook hosts or spoof a mobile UA: Camoufox supports desktop fingerprints only.
   - Facebook connects directly from the Cambodian scraper host by default. Proxying is explicit opt-in and must never affect Khmer24, Telegram, AI APIs, or internal services.

---

## 🛠️ Implementation Standard

Use `attachTrafficGuard(page)` from `src/modules/parser/traffic-guard.ts` across all scrapers, test helpers, and maintenance scripts.

---

## 🦊 Camoufox engine — Facebook scraping runs on patched Firefox, not Chromium

**Architecture:** the TypeScript pipeline owns ALL logic (traffic guard, GraphQL
interception, LLM batching, dedup, ingest). The browser is Camoufox — a patched
Firefox — spawned as a Playwright websocket server by
`scripts/camoufox/serve.py` and driven from Node via `firefox.connect()`
(`src/modules/parser/camoufox-server.ts`). Both sides speak Playwright 1.62.
Do NOT write a second scraper/extractor in Python or elsewhere: one
implementation of each rule, always.

### Setup

```bash
python3 -m venv .venv-camoufox
.venv-camoufox/bin/pip install -r scripts/camoufox/requirements.txt
.venv-camoufox/bin/camoufox fetch          # patched Firefox + GeoLite2 + uBO
```

### Run

```bash
# One-time visual login: a headed Camoufox window opens, YOU type the
# password/2FA, the script only waits for the c_user cookie and saves
# storage_state to data/fb_session.json.
npm run fb:login                  # direct local IP by default; use --proxy explicitly

# One-group smoke cycle, then the normal headless cycle
npm run scrape:fb:smoke -- --group=0
npm run scrape:fb
```

### Hard-won constraints (verified on this machine, do not "simplify" away)

1. **Device identity is pinned — never rotate it.** Camoufox re-rolls
   canvas/audio/font noise seeds and picks a fresh fingerprint on EVERY launch
   (daijro/camoufox#442): same cookies + new hardware fingerprint reads as
   session hijacking. `serve.py` pins a real in-the-wild fingerprint preset +
   the three noise seeds in `data/fb_device.json` (generated once per account,
   never committed). Do not pass `userAgent`/`viewport`/`locale` overrides on
   the client context — they desync navigator.* from spoofed WebGL/screen.
2. **No persistent context over the websocket** (daijro/camoufox#253 —
   Playwright limitation). Sessions are carried by `storageState`
   (`data/fb_session.json`), saved back at the end of every run. Cold HTTP
   cache each run is the accepted cost; `enable_cache` is on within a run.
3. **`humanize=True` stays OFF** — on macOS beta.30 the first humanized
   trajectory departs from the tracked pointer (0,0), can emit a point on
   x==0/y==0, and wedges the process-global input chain (daijro/camoufox#751).
   Measured: 10/10 cold-start hangs to a near-corner target, 1/10 even to a
   distant interior one. The scraper scrolls via JS `scrollBy` (no input
   dispatch) and only makes rare interior `mouse.move` hops — safe.
4. **Never spoof a mobile UA / `m.facebook.com`.** Camoufox removed mobile OS
   fingerprints — only `windows`/`macos`/`linux` exist. A mobile UA over a
   desktop fingerprint is a guaranteed mismatch.
5. **`os` is pinned in `data/fb_device.json`** (macOS today). If this project
   moves to a Linux mini-PC, regenerate the device file (`--os linux`) instead
   of keeping a macOS fingerprint on a Linux host.
6. **`page.evaluate` runs in an isolated world since beta.29** — page-script
   globals are invisible without `main_world_eval=True` + the `mw:` prefix.
   DOM state (`window.scrollY`) is shared and unaffected.
7. **Authentication is never automated.** `fb:login` waits for a human;
   credentials never enter code, terminal input, or files.
8. **camoufox-js (npm) is deliberately NOT used** — it pins playwright-core
   <1.61 and fetches its own browser builds. `serve.py` launches the venv
   install so browser + protocol versions have a single source of truth.
9. **Facebook automation is fail-closed.** `data/fb_runtime.lock` prevents concurrent login/scrape processes. A detected challenge writes `data/fb_safety_state.json`; only a successful attended `npm run fb:login` may clear it.
10. **One account stays on one host identity.** Never copy a macOS `fb_device.json` to Linux. A host migration requires a new OS-correct device file and an attended login before scraping resumes.
