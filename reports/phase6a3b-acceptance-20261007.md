# Phase 6A.3b acceptance — moderation calibration and permanent backfill

Date: 2026-10-07
Production read path: `legacy`
External source requests, Bright Data requests, and AI calls during this phase: **0**

## Moderation calibration

The read-only checkpoint audit covered the 142 canonical-only pending cards in the broad Siem Reap rental search:

| Disposition | Count |
|---|---:|
| `AUTO_APPROVE_CANDIDATE` | 95 |
| `MANUAL_REVIEW` | 46 |
| `REJECT` | 1 |

There were 117 Facebook and 25 Khmer24 cards in that cohort. All 25 Khmer24 cards had a manual-review flag, so there was no Khmer24 auto-approval sample. The stratified approval sample was therefore 40 Facebook cards: 26 exact-city, 14 probable-city, 38 with rental evidence, and 2 with unknown offer language. It included one card without a price, four without bedrooms, and four without direct contact details. All 40 were plausible current housing supply; observed false approvals were **0/40**. This is a sample result, not a guarantee for unreviewed Khmer24 or future data.

The policy keeps moderation separate from search ranking. Missing price, bedrooms, direct contact, and exact city do not by themselves block approval. Explicit source/price/bedroom inconsistencies, mixed rent/sale evidence, reused source URLs, missing housing type, invalid card content, and identity alias conflicts stay pending for review. Clear out-of-area evidence or sale-only content is excluded from the rental surface.

The deterministic policy is `INGESTION_VALIDATED_V1`. Each applied decision records the prior status, policy version, evidence, decision time, and `AUTO_POLICY` actor in `canonical_listing_moderation`.

## Permanent local backfill

Before writing, a consistent SQLite backup was created at `data/backups/homeasy_phase6a3b_prebackfill_20261007.db`. Its integrity check passed, it had no foreign-key violations, and its legacy `properties` table had 390 rows with the expected digest:

`59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272`

Only API, bot, and tunnel containers were running; no scraper container or Facebook scraper lock was present. The local backfill used the normal `IngestionService` with a legacy write guard and no network or AI work.

| Check | Before | First run | Repeat |
|---|---:|---:|---:|
| Source items | 1,254 | 1,257 | 1,257 |
| Source item versions | 1,936 | 1,939 | 1,939 |
| Current occurrences | 730 | 733 | 733 |
| Canonical properties/listings | 462 / 462 | 465 / 465 | 465 / 465 |
| Backfill result | — | +3 items, +3 versions, +3 occurrences | 3 unchanged, 0 versions |
| AI attempts | — | 0 | 0 |
| Legacy writes | — | 0 | 0 |

The three local rows (legacy IDs 3, 18, 158) each created a new canonical Property and Listing with one current occurrence. Their nearest existing candidates were:

- **ID 3:** nearest was Khmer24 listing 365, “1BR Apartment in Wat Bo” at $400/month. The backfilled apartment is $270/month near Angkor High School; only neighborhood, bedroom count, and type overlap. Text similarity was 0.242, with no shared identifiers, photos, or contact. `DIFFERENT_PROPERTY` is defensible.
- **ID 18:** nearest was Khmer24 listing 401, “1BR Apartment in Svay Dangkum” at $250/month. The backfill is a 2BR apartment; same neighborhood, price, and type are weak evidence, with 0.096 text similarity and no shared identifier, photo, or contact. The bedroom mismatch supports a separate property.
- **ID 158:** nearest was Khmer24 listing 286, “3BR Flat House in Siem Reap” at $400/month. The backfill is a $360/month second-floor apartment with different text and no shared identifier, photo, or contact. Similarity was limited to city, bedrooms, and rent; `DIFFERENT_PROPERTY` is defensible.

Incremental reconciliation also restored 10 exact legacy source-URL aliases that were absent from the migration-only checkpoint. Together with the three aliases for the backfilled legacy rows, that added 13 namespace-scoped aliases. No legacy `properties` row changed.

## Policy application and final read parity

The v1 policy was applied to 125 pending canonical-only records in the live search cohort: 95 approved, 29 retained pending for manual review, and 1 rejected. A separate identity check found eight legacy-origin approvals without a resolvable legacy alias; these were moved to pending with recorded policy evidence. One legacy-mapped listing whose source text said “House for sell / ផ្ទះលក់” despite a rental title was also moved to manual review. These changes affected canonical moderation only.

Final broad Siem Reap search parity on the production database:

| State | Count |
|---|---:|
| Broad candidates | 215 |
| Approved/visible | 174 |
| Pending | 37 |
| Rejected/blocked | 4 |
| Explicit geography contradictions in results | 0 |

The 174 visible cards contain 141 exact-city, 30 probable-city, and 3 unknown-city records. Offer evidence is 164 rental-evidence and 10 unknown-offer cards. The city/offer cross-tab and all row-level decisions are in the JSON triage report.

For the 215 broad candidates, list, map, and detail `public_ref` values agree. Pending and rejected listings return 404 by direct opaque public reference. The Mini App read path remains `legacy`.

## Identity, favorites, tracking, and integrity

- 465/465 canonical listings have unique well-formed opaque public refs; every ref has exactly its matching public-ref alias.
- No duplicate alias keys, dangling aliases, or duplicate current source bindings.
- Public refs survive SQLite backup and numeric-ID remapping in a synthetic regression fixture.
- Production favorites are empty; the dry-run found zero mapped/unmapped/ambiguous entries. Synthetic tests cover legacy favorite mapping, duplicate collapse, unresolved favorites, and numeric-ID collision safety.
- Three existing tracked links have no listing identity and remain unchanged. Synthetic tests cover numeric legacy alias → canonical listing, new public-ref links, invalid aliases, and history preservation.
- Legacy `properties`: **390 rows**, unchanged digest above.
- Database `integrity_check=ok`, foreign-key check has zero violations, and there are no queued/running freshness jobs.

## Verification

- Full Jest with open-handle detection: **46 suites, 403 tests passed**.
- TypeScript typecheck: passed.
- Web app production build: passed. Vite reported its existing large-chunk advisory (>500 kB).
- `git diff --check`: passed.

## Decision

Phase 6A.3b backfill and moderation calibration are complete. Keep `LISTING_READ_PATH=legacy`; do not cut over in this phase. No Bright Data or Facebook discovery was run.
