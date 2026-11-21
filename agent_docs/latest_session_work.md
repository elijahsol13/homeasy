# Homeasy — active handoff (2026-11-21)

## Stage 3 — public Facebook photos and local cover-order regression

- Public API `https://api.rustycat.cc/api/v1/properties?city=siem_reap&type=rent` paged 5 times at limit 100. All **207 distinct current published listings** were retrieved. Of those, **132 Facebook CDN covers returned HTTP 403/text/plain** on direct GET with `Range: bytes=0-31`; the **75 Khmer24 covers returned HTTP 206/image** (61 JPEG / 14 WebP). This explains the prior browser first-page 32 HTTP 403 *requests*, which were not 32 distinct listings.
- The first two *additional* saved photos on the 132 Facebook cards were probed as well: **260 distinct backup URLs, all HTTP 403**. None of the Facebook cards had a working cover in these first three photo attempts. Remaining gallery positions were not checked, and this HTTP experiment does not measure actual mobile WebView rendering.
- On **24 current public Facebook posts** sampled from page order (first five plus evenly spaced across all 132, de-duplicated), existing anonymous `inspectFacebookOgPhoto()` yielded **20 verified-known-image proofs / 4 unverified**. Unverified public listing IDs: **16856, 16822, 16679, 16727**. Proof checks same post/group, one redirect at most, matching saved image pathname, and live image signature. It obtains at most one image per post, and the CDN may expire again. No Facebook login, paid collection, or production mutation.
- Root cause of local renewal regression: the savepoint-scoped media-only update inserts a new linked `media_assets` row with higher `id`, while `CanonicalListingRepository.projectionSql()` previously sorted linked photos by asset ID. Result was the second gallery image promoted to thumbnail after a successful cover renewal. Reproduced RED in `tests/facebook-og-media-refresh.test.ts` against isolated SQLite, then fixed by projecting linked URLs in original source-payload photo order, falling back to asset ID when absent. Tests cover public list/detail, thumbnail/full gallery, existing renewed asset, and cross-source associations. No schema change.
- Read-only local historical SQLite query bench after fix (`data/homeasy.db`, 24 matching public listings) ran four 20-item list reads in **74.3 ms cold / 15.5–16.5 ms warm**; this is not a VPS timing or benchmark of 207 listings.

## Stage 3 — Web/TMA map optimization

- `webapp/src/components/MapView.tsx` now dynamically loads `openFreeMapBasemap.ts`. The initial Leaflet map and marker API work independently of the large MapLibre/OpenFreeMap renderer. The imported module is only attached to the still-mounted map; failed background initialization leaves markers usable.
- A cancellable zero-delay initial fetch prevents duplicate HTTP map requests during React StrictMode effect replay. In-flight responses are invalidated on filter change, city-map replacement or unmount; panning retains the 300ms debounce.
- `webapp/src/components/MapView.test.tsx` covers exactly one StrictMode initial request, marker independence, out-of-order responses, filter change, unmount, and basemap failure. `tests/mini-app-browser-smoke.cjs` checks map request count, real mouse drag, viewport bounds, district cluster navigation, filtering, and error recovery in desktop Chrome. The drag starts on an actual uncovered Leaflet region, avoiding the fixed footer overlay.
- Web/TMA bundle comparison, minified JS with gzip in parentheses. Prior MapView **1,211.61 kB (332.58 kB)**. Current MapView **159.47 kB (46.69 kB)**, separate basemap **1,052.21 kB (286.46 kB)**, separate basemap CSS **71.33 kB (10.25 kB)**; worker **517.45 kB** remains. Code splitting was verified, real device latency was not measured.

## Fresh verification

- `npm --prefix webapp run test -- --run` — PASS, 14 files / 192 tests; MapView 9 tests.
- `npm test -- --runInBand --forceExit --silent` — PASS, 100 suites / 1134 tests after the additional Facebook photo-order regression; Jest warns about existing open handles.
- `npm run typecheck`, `npm run lint`, `npm --prefix webapp run lint` — exit 0. Frontend lint retains existing React warnings.
- `npm --prefix webapp run build:web` and `npm --prefix webapp run build:tma` — PASS. Vite warns about the >500-kB independently loaded basemap chunk.
- `node tests/mini-app-browser-smoke.cjs` — PASS again in real Chrome against isolated HTTP + SQLite fixture: initial filtered API, map single request, panning, cluster-to-list, HTTP 500 and network failure recovery, no uncaught page JS errors. Offline fixture deliberately blocks external OpenFreeMap tiles, resulting in expected MapLibre console fetch errors.
- Independent reviewer `01a1feb2-5452-76a0-a777-d254fc45aa59` ended with `stream disconnected before completion`. No independent sign-off was obtained. Manual diff review found no additional scoped changes to make.
- Previous handoff archived byte-identically as `agent_docs/history/session_work_2026-11-21_before_stage3_map_handoff.md`, SHA-256 `cd0719e214668e9c868af9b361a3cac9c4fb95b2adc00c7c963a1ce437f474a5`.

## Public Web read-only check

- On 2026-11-21, `https://homeasy.rustycat.cc/` returned HTTP 200 and showed 207 rentals, first page 20 cards. Browser network logged 32 Facebook CDN HTTP 403 requests. The full cohort and source-level checks above supersede the earlier first-page-only uncertainty.

## Remaining Stage 3 / operational gates

1. Current public broken-cover cohort and sampled source renewability are now measured. Before production repair, prepare a controlled renewal plan backed by a verified recent production snapshot and rollback. Production image update, repeated CDN expiry, and full-gallery recovery require separate authorization and a supported storage/re-refresh approach.
2. Real Android/iOS Telegram WebView map/contact QA, mobile startup/panning timing and full user-facing acceptance still require devices/access. `adb` was unavailable on the Mac. Desktop smoke does not establish phone performance.
3. Catalog pilot, production release with pinned images/artifacts and rollback, and Stage 2 live notifications/ingestion checks remain open under `agent_docs/modernization_plan.md`.

All operations in this checkpoint were local code, tests, browser loopback, read-only public Web GET requests and documentation. No production SQLite writes, scrapers, paid calls, Facebook account operation, GitHub push or deployment. Stage 3 changes are committed locally on `develop` for a clean working tree. Current status lives in `project_progress.md`; accepted scope in `decisions.md`.
