# Homeasy — active handoff (2026-11-21)

## Stage 3 — catalog geography and cover-photo fallback

- Source-verified projection updated in `src/database/repositories/canonical-listing.repo.ts` and `src/modules/parser/source-map-location.ts`. Exact coordinates require source-backed Khmer24 location or explicit author-labelled Facebook property Maps URL. AI-only coordinates, camera views, known Khmer24 administrative centres and promotional proximity do not become exact map markers. Strict verified sangkat keys replace unverified location aliases. Added coverage in `tests/canonical-listing.repo.test.ts` and `tests/api.test.ts` across public list, detail and map, including original Facebook source title.
- `webapp/src/components/PhotoWithFallback.tsx` and `PropertyCard.tsx` retry up to two distinct existing later photo URLs for a broken cover before the accessible placeholder. The rest of the carousel is unchanged. Added three accessibility/UI regressions in `PropertyCard.accessibility.test.tsx`, including duplicate URL handling. This is a UI mitigation: stale CDN URLs remain stale until renewed from their original posts.
- **Live VPS read-only analysis**, performed by a delegated agent with SSH and SQLite `-readonly`/`PRAGMA query_only=ON`, reconciled November 12 public **264** to November 21 04:40 UTC **219**. All 45 omitted approvals exceeded the 30-day original-publication cutoff (Khmer24 35, Facebook 10). `canonical_listings=591` unchanged, `approved=399`, `pending=185`, `rejected=7`; age exclusions rose 135→180. An additional later November 21 sample counted 208 eligible as records aged further. Most recent `source_items` ingestion: 2026-11-12 07:18:51 UTC. `freshness_jobs=0`; two old `processing_runs` rows still say `running`, which does not prove active processes. **No data mutation or new scrape.**
- **Read-only Facebook image research:** public Web first page showed 32 `Photo unavailable` failures and HTTP 403 CDN responses. In a historical 2026-10-22 batch, 511 of 551 saved URLs had expired `oe` parameters and 20/20 blind replacements failed. Anonymous original-post HTTP returned 25/25 successful GETs, 22 `og:image` tags, 21 of 22 matching expected CDN path; two fresh images supported bounded Range GET. These samples demonstrate an HTTP renewal hypothesis for covers, **not** current verification of all 32 public posts or their galleries. Source-post identity and `og:url` must be checked before using any renewed URL.
- Web `MapView` is already lazily imported from `App.tsx`. Local `build:web` reports a **1,211.61 kB** map JS chunk (**332.58 kB gzip**) and separate **517.45 kB** MapLibre worker. Map engine replacement is pending a behavior/visual parity approach and real-device measurements.

## Verification

- Backend `npm test -- --runInBand --forceExit --silent` **99 suites / 1111 tests passed**. Jest reports preexisting open handles under forced exit. Root `npm run typecheck`, `npm run lint`, `npm run build` exited 0.
- Final frontend rerun `npm --prefix webapp run test` **14 files / 188 tests passed**. New duplicate-cover URL case was observed failing and passing after deduplication. Frontend `npm --prefix webapp run lint`, `npm --prefix webapp run build:web` and `npm --prefix webapp run build:tma` exited 0 on the final code. Existing lint warnings in `MapView` and `App` and the large MapView chunk warning remain.
- Frontend worker's tool stream disconnected after saving its three-file diff. Integrator inspected and copied the diff from the isolated worktree to `develop`, then ran tests there. Independent worker sign-off is unavailable. Root `git diff --check` passed.
- Stage 2 handoff archived byte-identically in `agent_docs/history/session_work_2026-11-21_before_stage3_handoff.md` (SHA-256 `4bf02d9338f78583b480fc13a169b34934e8e8b763b1e5dc517536a6f39bc8c6`).

## Remaining gates

1. Verify and implement bounded anonymous original-post cover URL refresh, preserving post identity and provenance, then check affected current Facebook listings. Do not presume full gallery recovery. No paid requests or live data changes authorized.
2. Profile map start and interactions on Android/iOS Telegram WebView, optimize rendering without losing map/marker/contact behavior, and measure initial-load latency. Browser-only tests do not satisfy the physical-device gate.
3. Stage 1 production image pin/rollback and Stage 2 operational notification/ingestion acceptance remain open for a separately approved production release. No GitHub push, Cloudflare publish, live database write, Docker restart or automated source collection occurred here.

Canonical current state and gates live in `project_progress.md`, accepted policies in `decisions.md`, and stage criteria in `modernization_plan.md`.
