# Phase 6A — Canonical read parity (2026-10-07)

## State

The read-only checkpoint is `data/rebuild/phase6a-checkpoint-20261007.db`. Its SHA-256 matches the production DB at capture: `8fab74cb0d296fe29ed22038a9a346d1b47fed04ee1b5c2d195e6700677db426`. The checkpoint passed `integrity_check`; `foreign_key_check` returned no rows. It was copied before parity work. The parity runner opens only that copy read-only.

Phase 5 counts remain unchanged: 390 legacy properties, 462 canonical properties/listings, 460 active listings, 730 current and 2 historical occurrences, 1,254 source items, 1,936 versions. Legacy digest is still `59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272`. Duplicate current bindings and duplicate canonical keys are both zero.

## Implemented

- Added `CanonicalListingRepository`, which projects current canonical supply listings into the existing `Property` model and applies the existing search filters. It joins only each listing's current primary source occurrence, uses canonical media assets and source facts, and filters inactive, rented, removed, and non-supply records.
- Added `LISTING_READ_PATH=legacy|canonical` (default `legacy`) and `LISTING_READ_SHADOW=false`.
- Shadow mode executes both reads, returns the legacy response, and emits structured parity counts and elapsed time to API logs.
- Added an offline parity runner: `npm run ingestion:phase6a-parity`. It uses the read-only checkpoint and saves detailed results to `reports/phase6a-canonical-read-parity-20261007.json`.
- No UI/API DTO contract was changed, and no production read-path switch was made.

## Results

The active real request is a broad Siem Reap rental search with no budget, bedroom, or district constraints. It returns 69 legacy listings and 221 canonical listings. The source URL/semantic matcher pairs 62 legacy results with canonical results (89.9% of legacy results); 7 legacy-only and 159 canonical-only remain for review. IDs are not used to claim entity identity.

| Query | Legacy | Canonical | Matched | Legacy-only | Canonical-only |
|---|---:|---:|---:|---:|---:|
| Cheap room, ≤ $300 | 10 | 13 | 8 | 2 | 5 |
| 1BR apartment | 16 | 60 | 16 | 0 | 44 |
| 2BR apartment | 12 | 29 | 9 | 3 | 20 |
| House | 26 | 96 | 24 | 2 | 72 |
| Budget ≤ $400 | 36 | 133 | 32 | 4 | 101 |
| Budget $400–$800 | 27 | 65 | 22 | 5 | 43 |
| Sala Kamreuk | 22 | 38 | 19 | 3 | 19 |
| Wat Bo | 0 | 21 | 0 | 0 | 21 |
| Svay Dangkum | 25 | 48 | 23 | 2 | 25 |
| Pet-friendly | 1 | 3 | 1 | 0 | 2 |
| Lease ≤ 12 months | 69 | 221 | 62 | 7 | 159 |

The last row also represents the current broad active request; its saved filter has no restrictive criteria. Per-query timings and the full top-result differences are in the JSON report. In this local read-only run, legacy reads were about 0.4–1.9 ms and canonical reads about 62–76 ms. The current canonical implementation loads and maps the candidate set before filtering, so its read latency needs optimization before cutover.

## Data and DTO review

For the 221 canonical results in the active request, the existing `Property` projection had: title 221/221, description 221/221, nonzero price 209/221, type/category 217/221, bedrooms 186/221, location 221/221, amenities 168/221, photos 220/221, source link 221/221, direct contact 184/221, and an observation timestamp 221/221. The current Mini App DTO itself does not expose a freshness/status field; its contract was left unchanged.

The first canonical-only examples include three fresh Facebook posts from the pilot, which are genuine incremental supply candidates. The wider sample also contains listings with missing bedrooms or contact, and at least two whose location text says Phnom Penh or Kandal while they pass the Siem Reap canonical city filter. These require source and city-field review before users can see them.

Legacy-only examples include records whose title and district conflict with Siem Reap, records with blank locations, and 4 Facebook source URLs with no matching current canonical occurrence in the checkpoint. These are not all safe to label as correctly absent; they remain potential ingestion/materialization gaps. Two Khmer24 rows have matching canonical source occurrences but are not paired by the current search comparison, which needs investigation.

The broad query demonstrates canonical's inventory expansion, but the canonical-only count includes records that may be stale, mislocated, incomplete, or duplicates. No manual source-page validation or false-merge/false-split conclusion is claimed by this report.

## Acceptance and next work

**Phase 6A is not accepted for Mini App cutover yet.** The canonical read path is available behind a default-off flag, but parity is not established: result counts diverge substantially, several DTO fields are incomplete, there are apparent location inconsistencies, unresolved legacy-only records, and canonical latency is much higher. The list/detail flag also does not make map, favorite, or moderation flows canonical, so it is not a production cutover switch today.

Next: investigate the seven legacy-only cases and sample canonical-only inventory against saved source artifacts, fix city/location and field mapping issues in canonical data/read logic, optimize search latency, then rerun this matrix. Mini App remains on legacy. No Bright Data calls, AI calls, production DB writes, scraper starts, or ingestion runs were made for Phase 6A.

Verification: full Jest suite passed (45 suites, 389 tests); TypeScript typecheck and final `git diff --check` passed.
