# Phase 6A.1 — Canonical correctness and query performance

Date: 2026-10-07  
Input: read-only `data/rebuild/phase6a-checkpoint-20261007.db`  
Production read path: `LISTING_READ_PATH=legacy`; no cutover performed.

## Acceptance summary

- Legacy-only: 14 before identity matching, 9 after. All 9 are classified: 8 have no matching `source_items` row in this checkpoint (`NO_SOURCE_ITEM`), and 1 Khmer24 item is correctly excluded from Siem Reap because its title says Phnom Penh (`CORRECTLY_EXCLUDED`). There are 0 unexplained legacy-only rows and 0 remaining comparator mismatches.
- The four highlighted Facebook URLs (legacy IDs 165, 160, 158, 156) have no source item, occurrence, cluster membership, or canonical decision in the checkpoint. They are ingestion coverage gaps, not read-path omissions. Four additional legacy Facebook rows have the same missing-source-item condition (IDs 18, 2, 4, 3).
- Khmer24 identity matching now normalizes `adid-123`, `adid:123`, and URL variants to the same ad ID. The two highlighted records with current canonical occurrences are matched before semantic fallback.
- The Siem Reap rent query returned 78 listings and 0 explicit Phnom Penh/Kandal/Sihanoukville results. A dry run scanned 220 active Siem Reap city rows and produced 5 high-confidence geography findings: 4 Phnom Penh (including 1 title conflict) and 1 Kandal. These are excluded deterministically by the read filter; the checkpoint itself was not rewritten.
- Canonical-only sample: all 24 current broad-query rows were reviewed from stored facts and assigned labels: 18 `VALID_NEW_INVENTORY`, 6 `INCOMPLETE_BUT_VALID`; none were flagged as duplicate, out-of-area, stale, irrelevant, or another data bug. Labels are based on checkpoint evidence, not a new source fetch.
- Unknown bedrooms stay in broad results but do not pass bedroom filters. Zero/unknown prices do not pass the default rent or budget query. Missing contact is allowed when the source link exists. List reads select only one current primary photo; detail reads can return the full media set.

## Parity and data-quality counts

| Measure | Result |
|---|---:|
| Legacy Siem Reap rent results | 69 |
| Canonical Siem Reap rent results | 78 |
| Identity/semantic overlap | 60 |
| Legacy-only before identity fix | 14 |
| Legacy-only after identity fix | 9 (all explained) |
| Canonical-only sample | 24 / 24 labeled |
| Explicit out-of-area returned after filter | 0 |
| Broad Siem Reap typed-supply candidates | 105 |
| Broad candidates with missing/zero price | 12 |
| Broad candidates with unknown bedrooms | 20 |
| Broad candidates without direct contact | 4 |
| Broad candidates without a photo | 0 |
| Default rent results with missing/zero price | 0 |
| Default rent results with unknown bedrooms | 7 (excluded when a bedroom filter is set) |
| Default rent results without direct contact | 1 |
| Default rent results without a photo | 0 |

Unknown offer type is excluded from the typed DTO instead of being silently labeled rent. The expanded canonical inventory is retained. The 78 vs 69 difference is not treated as a defect by itself.

## Representative query counts and median latency

Each latency is the median of five sequential runs on the same checkpoint. Canonical search runs two SQL queries (count and page), with SQL filtering/count/order/page before DTO mapping. No N+1 query is used.

| Query | Legacy count | Canonical count | Legacy ms | Canonical ms | Canonical SQL ms | Mapping ms |
|---|---:|---:|---:|---:|---:|---:|
| Cheap room | 10 | 8 | 0.32 | 5.89 | 5.56 | 0.30 |
| 1-bedroom apartment | 16 | 14 | 0.44 | 9.90 | 9.60 | 0.22 |
| 2-bedroom apartment | 12 | 10 | 0.35 | 8.06 | 7.96 | 0.14 |
| House | 26 | 35 | 0.63 | 17.63 | 16.52 | 0.58 |
| Budget under $400 | 36 | 40 | 0.75 | 18.15 | 17.51 | 0.60 |
| Budget $400–$800 | 27 | 26 | 0.61 | 13.58 | 13.17 | 0.43 |
| Sala Kamreuk | 22 | 23 | 0.54 | 12.09 | 12.91 | 0.24 |
| Wat Bo | 0 | 3 | 0.13 | 5.33 | 5.00 | 0.04 |
| Svay Dangkum | 25 | 27 | 0.58 | 12.55 | 11.88 | 0.22 |
| Pet friendly | 1 | 2 | 0.15 | 4.16 | 3.99 | 0.03 |
| Lease up to 12 months | 69 | 39 | 1.33 | 16.19 | 15.60 | 2.10 |
| Broad current rent query | 69 | 78 | 1.30 | 34.20 | 33.08 | 1.01 |

The broad-query plan uses `idx_canonical_listings_status`, primary-key lookups for property/occurrence/source/registry joins, and applies filter predicates in SQLite. No new index was added: the planner already uses the status index, and the checkpoint is small. Full `EXPLAIN QUERY PLAN` output for every query is in the JSON report.

## Source-surface compatibility inventory

- List/search: legacy by default; shadow mode can run canonical read for comparison; canonical serving is gated separately.
- Detail: follows the read-path flag. Canonical and legacy IDs do not yet have a compatibility map for saved favorites.
- Map: still reads legacy properties and legacy IDs.
- Favorites: storage and lookup remain tied to legacy property IDs.
- Moderation: legacy `review_status` remains authoritative; canonical records have no equivalent moderation state.
- Tracking/contact: IDs are not yet unified across canonical and legacy surfaces.

This is a dependency map only. `LISTING_READ_PATH` remains `legacy` and Mini App cutover is not approved by this phase.

## Integrity and regression checks

- Legacy `properties`: 390 rows; digest `59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272`.
- Canonical: 462 properties, 462 listings, 460 active listings, 730 current occurrences, 2 historical occurrences, 1,254 source items, 1,936 versions.
- Duplicate current source bindings: 0; duplicate canonical keys: 0.
- `PRAGMA integrity_check`: `ok`; `foreign_key_check`: 0 violations.
- Repository regressions cover explicit Phnom Penh, explicit Kandal, source-city hint with no location, explicit Siem Reap, zero-price budget exclusion, and unknown-bedroom exclusion.
- Verification: `npm test -- --runInBand --silent` passed (45 suites, 392 tests); `npm run typecheck` passed; `git diff --check` passed. Jest reports an existing open-handle warning after all suites pass.
- Full report and row-level audit details: `phase6a-canonical-read-parity-20261007.json` and `phase6a1-city-repair-dry-run-20261007.json`.
