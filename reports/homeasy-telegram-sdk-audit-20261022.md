# Homeasy Telegram SDK provenance and integration audit — 2026-10-22

## Evidence and cause

- `webapp/index.html` already included the Telegram-owned script `https://telegram.org/js/telegram-web-app.js` ahead of the React application entry point. The official Telegram Mini Apps documentation recommends this script and the `window.Telegram.WebApp` API (current documented cache key: `?64`).
- `webapp/src/services/telegram.ts` additionally imported `@twa-dev/sdk` 8.0.2. This independently published npm package is **not** an official Telegram-maintained SDK. Its installed `src/telegram-web-apps.js` and `dist/telegram-web-apps.js` bundle a copy of Telegram's JavaScript WebApp bridge; `dist/sdk.js` imports that copy and exports `window.Telegram.WebApp`. Consequently the Vite application loaded two bridge implementations, and the vendored one reassigned `window.Telegram.WebApp` after the external script.
- The previous local production bundle `webapp/dist/assets/index-CtpilrpY.js` contained `window.Telegram.WebApp=i` (vendored bridge) and `E.default.ready()` (Homeasy initialization). Its CommonJS-to-ESM wrapper constructed `E.default` from a module namespace `{default: WebApp}`, making `E.default.ready` undefined. This accounts for the desktop Telegram QA error `E.default.ready is not a function`; other code paths already used the actual `window.Telegram.WebApp` object, helping explain why login/Saved worked.
- The old package's local JavaScript was inspected for fetch/XHR/beacon/WebSocket/eval usage and outbound URL constants; none of those network APIs were present. Its bridge used `postMessage` with the Telegram iframe/parent and local `__telegram__*` sessionStorage entries for launch/theme state. No evidence of an extra telemetry or credential-exfiltration integration was found in this static inspection. **This is not a security certification or a byte-for-byte proof against the Telegram source.** A direct attempt to download the official script for diffing failed with `curl: (6) Could not resolve host: telegram.org` in the local runtime. The vendored package is also older than current Telegram documentation and cannot be assumed to implement newer APIs.

## Local correction (not published)

- Kept exactly one runtime bridge, served from Telegram's script in `webapp/index.html` with the documented `?64` cache key.
- Removed `@twa-dev/sdk` and its `@twa-dev/types` dependency from `webapp/package.json` / `package-lock.json` through offline npm uninstall.
- Reworked `webapp/src/services/telegram.ts` to read `window.Telegram.WebApp` directly using a small local TypeScript interface. `ready` and `expand` are required methods; a malformed bridge is logged, not silently treated as initialized. Preserved theme, haptics, initData/start parameter, contact-link handling and optional analytics behavior.
- Added regression tests for official-bridge initialization, absent/malformed bridge and haptic calls in `webapp/src/services/telegram.test.ts`. These tests exposed the mismatch before the fix (2 failed), and passed after the fix.

## Verification and limits

- Final checks after the required-method assertion: **19/19 targeted Telegram tests** and **64/64 frontend tests** passed (6 test files). The targeted run must execute from `webapp/` to use its browser test environment; invoking Vitest from the repository root without that config incorrectly uses Node and fails on `window is not defined`.
- Vite production build passed; resulting `index-BzAVyBMf.js` is approximately **258 kB** versus previous local `index-CtpilrpY.js` approximately **311 kB**. The new JS has neither `@twa-dev/sdk` nor the embedded `web_app_request_safe_area` bridge string; `dist/index.html` references the Telegram-owned script with `?64`.
- Frontend lint exited 0 with seven pre-existing warnings in App/MapView; no new lint errors. `git diff --check` passed. Vite reported only its size warning for the separate MapView chunk.
- Does **not** establish what the official script returned over the network in a live Telegram client after this local fix. No Telegram Chrome/WebView QA, production release, DB mutation, scraper, commit or push occurred in this task. Next acceptance: run the existing authenticated Telegram Web QA on the deployed fixed build, then device QA when available.

## Separate existing integration

`webapp/src/services/analytics.ts` separately uses PostHog for optional frontend analytics, including `identifyTelegramUser` on SDK user identity when a PostHog API key is configured. This comes from Homeasy code, not `@twa-dev/sdk`; its existing behavior was preserved and was not audited or changed here.
