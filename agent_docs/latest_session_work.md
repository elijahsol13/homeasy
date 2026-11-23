# Homeasy — active handoff (2026-11-23)

## Objective

Implement durable, source-verified Facebook photos from the existing VPS disk. Source capture stays on the pinned Mac Camoufox session, converting selected photos to WebP with a durable upload outbox. The owner approved cleanup eligibility 90 days after leaving the public catalog, or 90 days after upload for never-public/Pending photos. All media bytes remain only on VPS with no separate media backup. No live Facebook run, release, data mutation or paid call was authorized.

## Implemented locally

- Migration v59, SHA-256 content-addressed `data/media` file store, SQLite hosted galleries and references, authenticated upload/public GET routes, Mac photo capture/convert/queue, canonical photo projection and browser fallback. GC hooks into the existing 12-hour SQLite backup worker. Detailed paths are in `docs/superpowers/plans/2026-11-23-vps-photo-storage.md`.
- GC deactivates a gallery at day 90, purges gallery links after a 14-day hold and 21-snapshot rotation (normally day 104+), and deletes orphaned bytes after another 14-day hold and rotation (normally day 118+). The spec and plan were corrected from an earlier physical-delete estimate of 104 days.
- Real-browser smoke was corrected to disable HTTP cache and accept multiple placeholder elements after both hosted files disappear. The local Chrome run passed with a hosted WebP cover, two full-size photos, next-photo fallback and eventual placeholder.

## Fresh local verification — 2026-11-23

- `npm test -- --runInBand --silent` — 105/105 Jest suites, 1185/1185 tests passed, with a Jest open-handles warning.
- `npm --prefix webapp test -- --run` — 15/15 Vitest files, 194/194 tests passed, with jsdom navigation/window.open warnings.
- `npm run typecheck && npm run lint && npm run build` — passed.
- `npx tsc -p tsconfig.brightdata.json` — passed (the in-flight process from the previous checkpoint exited 0 on resume).
- `npm --prefix webapp run build && npm --prefix webapp run lint` — passed, with chunk-size and React lint warnings.
- Focused GC/outbox/media API Jest — 3/3 suites, 27/27 tests passed. Analytics SQLite lock warnings appeared only in fixtures.
- `node tests/mini-app-browser-smoke.cjs` — Chrome local HTTP/SQLite flow passed. Offline map-tile fetch errors and deliberate 500/network fault injections were expected in the run.

## Remaining gates

- An independent parallel code reviewer could not be started due to the agent thread limit. A targeted local source inspection of API/gallery/GC found no confirmed blocker; full independent review remains pending.
- Representative real WebP sizing, VPS free-disk/persistent media volume verification, source-verified full-gallery pilot, real Mac-to-VPS delivery and rollback rehearsal remain pending. A read-only 2026-11-23 public snapshot showed 132 Facebook listings/645 photo URLs and 60 Khmer24 listings/415 URLs. The counts do not prove recoverable historical bytes.
- Planning-only photo footprint for the observed 645 Facebook URLs is roughly 130–325 MB if full WebP plus thumbnail average 0.2–0.5 MB per distinct image. This is an assumed range, not an observed conversion result; real gallery counts, deduplication, retention overlap and VPS free space still need measurement.
- No live Facebook scrape, deployment, production DB write, paid call or GitHub push occurred. Preserve all dirty `develop` changes, `data/`, WAL/SHM, session and device identity. Media release requirements are documented in `agent_docs/release_process.md`.

## Exact continuation

After separate authorization of a production pilot/release, inspect actual VPS disk space and mount persistence, capture a small source-verified gallery through the pinned Mac identity, measure full+thumb bytes, verify hosted public photo URLs and controlled fallback, and rehearse SQLite/metadata rollback. Keep source-backed full-gallery completeness and approved release SHA as explicit gates.
