# Phase 6A integration branch validation

Date: 2026-10-09

## Scope

The local branch `integration/phase6a-current` consolidates the accepted Phase 6A work on top of the current Mini App production source commit `c97f84cbee1b02e2dae6c2248cc1ad6ae81b5c8f`.

Included:

- canonical ingestion, extraction, deduplication, media identity, freshness, and AI provider routing;
- canonical list/detail/map/filter/favorite read paths with opaque listing identity;
- tracking gateway and `start_param` attribution;
- Mini App canonical DTO/UI wiring and contact actions;
- acceptance scripts, regression tests, and the manually curated golden corpus;
- Phase 4–6A decision and acceptance documentation.

Explicitly excluded:

- every database, WAL/SHM file, backup, browser profile, and forensic artifact under `data/`;
- generated Phase 6 audit JSON files, except the curated `canonical-cross-source-golden-v1.json` fixture;
- temporary extraction scratch code, the raw `next steps` transcript, and the one-off pre-second restore script;
- the temporary contact diagnostic panel, direct bridge test button, debug-copy actions, and canary console diagnostics.

No production deploy, API rebuild, scraper, AI request, Bright Data request, canary configuration change, or global read-path change was performed.

## Integration commits

1. `644b42b` — canonical ingestion pipeline
2. `5e12c8f` — canonical API read path
3. `8d999bd` — listing identity tracking
4. `eded3af` — canonical Mini App UI
5. `5261dfc` — removal of temporary contact diagnostics
6. `06b7d40` — Phase 6A documentation
7. `089135b` — integration fixes for coordinate persistence and aligned tests
8. `052f128` — whitespace cleanup required by `git diff --check`

## Integration fixes found by the full gate

- Canonical latitude/longitude values were present in listing facts but were not persisted into `canonical_properties`. The integration fix now stores them during materialization and incremental reconciliation, preserving exact map markers.
- The canonical photo projection deliberately merges canonical media assets with additional unique source payload photos. Its regression expectation now reflects that contract.
- The tracking-open regression now supplies the Telegram deep-link configuration required by link creation.
- Notifier tests now assert the accepted compact notification-card contract instead of the removed rich legacy caption.

## Verification

- Root Jest: **49 suites, 417 tests passed**.
- API TypeScript typecheck: passed.
- API build: passed.
- Mini App Vitest: **3 files, 33 tests passed**.
- Mini App production build: passed. Vite's existing chunk-size advisory remains (`736.89 kB`, gzip `223.32 kB`).
- `git diff c97f84c..HEAD --check`: passed after whitespace cleanup.
- SQLite validation was run on copies in `/private/tmp`; the source databases were not mutated.
- Current database copy: `integrity_check=ok`, foreign-key violations `0`.
- Legacy snapshot: `390` stored rows, digest `59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272` (unchanged).
- Canonical checkpoint: `1,257` source items, `1,939` versions, `465` properties, `465` listings, `733` current occurrences.

## API behavior parity

The matrix was reproduced through the actual Fastify routes on a copy of the current database. Global `LISTING_READ_PATH` stayed `legacy`; only the test request for Telegram ID `299321244` used the canonical allowlist.

| Query | Legacy | Canary canonical |
|---|---:|---:|
| Broad Siem Reap rent | 69 | 169 |
| Apartment | 32 | 94 |
| House | 26 | 61 |
| 1 bedroom | 26 | 82 |
| 2 bedrooms | 23 | 71 |
| Up to $300 | 26 | 79 |
| Map markers | 7 | 10 |

The immutable pre-canary checkpoint contains 174 visible canonical rows. The current database contains 169 because five later explicit moderation decisions removed known anomalies; this matches the final Phase 6A.4 acceptance record.

## Product and known-bug boundary

The next product flow is browse/search-first: **I'm interested** records a lead and creates a lightweight `Request → Match/Offer → ContactGrant` chain; Chat and Call are revealed after the grant. This target flow is documented but is not implemented by this integration.

Telegram account resolution from Cambodian phone numbers remains a known contact bug. A real short local number resolved through a manually opened `t.me` URL while the Mini App bridge produced different behavior. The current formatter and regression coverage remain in the branch; no new phone heuristic or bridge workaround was added during consolidation.

## Release state

This branch is local and ready for review. It has not been pushed, merged, or deployed. Production API/canary settings remain unchanged and the global read path remains `legacy`.
