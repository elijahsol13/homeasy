# Homeasy — active handoff (2026-11-21)

## Stage 3 — bounded Facebook cover renewal

- Implemented a read-only anonymous original-post Open Graph proof in `src/modules/parser/facebook-og-media-refresh.ts`. Facebook post/group identity is validated against the saved source, with at most one same-post/same-group 3xx redirect. Unique `og:url` and `og:image` metadata and exact known Facebook CDN pathname are required. The image must be reachable and have a compatible JPEG/PNG/WebP signature. HTML limit is 2 MiB (observed public pages ~1.28 MiB); image reads take at most a 64-byte prefix even when CDN ignores `Range`. Unsafe redirects, unknown images and mismatched posts are rejected.
- `knownFacebookMediaUrls` in `src/modules/parser/media-identity.ts` reuses the existing stable media identity and recognizes legacy payloads. `applyFacebookOgPhotoRenewal` provides a separately gated, savepoint-protected update of a verified single image URL in source raw payload and relevant media asset associations. It preserves unrelated gallery URLs, shared source associations and all source/listing freshness metadata and versions. No live apply has been executed.
- Added `scripts/facebook-og-media-dry-run.ts` and npm script `media:facebook-og:dry-run`. Its SQLite connection is `readOnly: true` and `PRAGMA query_only=ON`; it prints only source IDs, photo counts and proof results. On historical local `data/homeasy.db`, approved anonymous network dry-run `--limit 5` verified 4/5 posts (4611, 4605, 4604, 4602). Source item 4613 is intentionally unverified because current OG image pathname does not match any of the five stored photo paths, despite HTTP 302→200, matching post ID and an available image. Without network DNS permission, the same command yields 0/5 and therefore cannot assess proof.
- `tests/facebook-og-media-refresh.test.ts` covers read-only proof, large HTML, 200 full-image responses, duplicate/conflicting tags, unsafe redirects, numeric-vs-slug groups, shared media, renewed asset reuse, identity guards, idempotency and freshness/version invariants. Failure of new >512-KiB HTML regression was directly observed before fixing the limit.

## Verification on `develop`

- `npm test -- --runInBand --forceExit --silent` — PASS, 100 suites / 1133 tests. Existing Jest open-handle warning under `--forceExit`.
- `npm --prefix webapp run test -- --run` — PASS, 14 files / 188 tests (jsdom navigation/open warnings).
- Root `npm run typecheck`, `npm run lint`, `npm run build`, `git diff --check` — PASS.
- Webapp lint and both `build:web` / `build:tma` — PASS, with preexisting React lint warnings. Map chunk remains 1,211.61 kB minified / 332.58 kB gzip plus 517.45 kB worker. No real-phone WebView acceptance performed.
- Previous Stage 3 checkpoint is archived byte-identically in `agent_docs/history/session_work_2026-11-21_before_stage3_og_handoff.md` (SHA-256 `2aa6a24ffff718f2263c355ae820a3a4336b3d3de87ffc64471be72526893ad8`).

## Remaining authorized gates

1. Evaluate **current public** broken-cover cohort against original Facebook posts through a bounded read-only method. Local SQLite is historical and the 4/5 sample must not be extrapolated to 32 live failures. A production mutation, new collection, paid call, GitHub push, or release requires its own authorization.
2. Profile map startup/panning/filter/marker/contact behavior, optimize the actual bottleneck while preserving functionality. Measure on real Android and iOS Telegram WebViews when devices are available. The current local build has no production performance evidence.
3. Run catalog pilot/acceptance only after relevant operational approvals. Stage 1 production image pin and rollback and Stage 2 notification/ingestion verification remain open.

Canonical current priority and verified status in `project_progress.md`; agreed stage criteria in `modernization_plan.md`; standing decisions in `decisions.md`.
