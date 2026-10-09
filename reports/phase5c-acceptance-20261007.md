# Phase 5C incremental canonical acceptance — 2026-10-07

## Production baseline

These values were captured from `data/homeasy.db` after Phase 5D and before the final Khmer24 smoke repeat. Acceptance fixtures run against in-memory SQLite databases and must not alter this production baseline.

| Measure | Baseline |
|---|---:|
| Legacy `properties` rows | 390 |
| Legacy IDs | 1–390 |
| Legacy full-row SHA-256 | `59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272` |
| Canonical properties | 443 |
| Canonical listings | 443 |
| Active listings | 441 |
| Inactive listings | 2 |
| Current occurrences | 704 |
| Historical/closed occurrences | 2 |

The digest covers all columns in `properties`, serialized in schema order with rows ordered by `id`; timestamps are included.

## Acceptance matrix

| Scenario | Result | Fixture evidence |
|---|---|---|
| Price edit | Pass: same Property, Listing, and current occurrence IDs; price updates and one source version is added. | `tests/ingestion-batch.test.ts`, “keeps a changed price on its existing canonical binding through the complete ingestion path”; `tests/canonical-shadow.test.ts`, “keeps price edits…” |
| Media-only edit | Pass: AI processing count remains one, IDs stay fixed, media association updates. | `tests/ingestion-batch.test.ts`, “updates media-only state…”; `tests/canonical-shadow.test.ts`, “reconciles media-only changes…” |
| New repost | Pass: new source item joins the existing repost cluster and Listing; one occurrence is added, no new Property or Listing. | `tests/ingestion-batch.test.ts`, “ingests a new repost…”; `tests/canonical-shadow.test.ts`, “attaches a new repost member…” |
| RENTED | Pass: same canonical identity transitions to rented and records `CONTENT_CHANGE/UNAVAILABLE`. | `tests/ingestion-batch.test.ts`, “marks explicit rented edits…” |
| AVAILABLE again | Pass: same identity returns to available and records `CONTENT_CHANGE/ALIVE`. | Same availability fixture; it asserts both historical events. |
| Post repurpose | Pass: old occurrence remains with `is_current=0` and `ended_at`; new current occurrence binds to a different Property and Listing; old Listing becomes inactive. | `tests/canonical-shadow.test.ts`, “closes the historical occurrence…” |
| Cross-source order independence | Pass for Khmer24→Facebook and Facebook→Khmer24. Both orders produce identical topology for a same Listing and for separate offers. | `tests/canonical-shadow.test.ts`, “produces order-independent cross-source canonical topology…” |
| Same Property, different Listings | Pass: synthetic same-building offers with different agent/contact and price yield one Property and two Listings in either source order. | Same cross-source topology fixture; asserts `SAME_PROPERTY_DIFFERENT_LISTING`. |

Occurrence schema supports the history model: migration v42 adds `is_current` and `ended_at`, and the unique index on `(source_item_id, source_entity_key)` has predicate `WHERE is_current=1`. A closed occurrence therefore does not prevent a new current occurrence for a repurposed source item.

## Legacy isolation and verification

`tests/canonical-shadow.test.ts` now snapshots all legacy property columns before each fixture and asserts the digest is identical afterward. The dedicated legacy guard test also rejects legacy INSERT, UPDATE, and DELETE and exercises new, unchanged, irrelevant, and media-only ingestion under the guard.

Verification: 43 Jest suites / 380 tests passed; TypeScript typecheck passed; `git diff --check` passed. Production SQLite integrity returned `ok`, foreign-key check returned zero rows, and the legacy digest matched the Phase 5D baseline. Production canonical counts were unchanged by the in-memory acceptance fixtures.

The fixture matrix passed without changing production data. Facebook and BrightData were not run. Phase 5C acceptance is complete after the final small Khmer24 shadow repeat below; Phase 5 remains open pending the separately reviewed Facebook shadow step.

## Final Khmer24 shadow repeat

After the fixture matrix passed, one guarded five-item Khmer24 shadow cycle completed (processing run 13): 5 received, 1 new source item, 0 changed, 4 unchanged, 0 errors. The one new candidate was classified `IRRELEVANT`; unchanged items did not trigger repeated AI enrichment. Production delta: +1 raw source item and +1 source version; +0 properties, listings, current occurrences, or legacy writes. No Facebook or BrightData activity occurred.

Post-repeat inventory: 1,223 source items, 1,905 source versions, 443 canonical properties/listings, 441 active and 2 inactive listings, 704 current and 2 historical occurrences. Legacy remains at 390 rows with the same digest above. SQLite integrity and foreign-key checks still pass. Freshness dry-run remains at 441 active listings, 385 fresh, 56 stale, 0 proposed checks, and paid execution disabled.

This satisfies the requested Phase 5C fixture acceptance and follow-up Khmer24 smoke. Facebook remains unrun.

## Proposed first Bright Data Facebook shadow run (not executed)

- **Candidate group:** `Real Estate in Siem Reap` (`495676670504992`), a previously successful public group that returned 60 records during the earlier pilot. Choose one group only and use a one-day date window.
- **Desired hard cap:** 20 delivered records. The current `brightdata-batch-test.ts` request has no record-count parameter. Bright Data's public group scraper example documents `url`, `start_date`, `end_date`, and `user_to_not_include`, but does not document a per-request post cap. Client-side truncation would happen after billing and is not a hard cap.
- **Expected charge if the provider enforces 20:** at the published $1.50 per 1,000 delivered records, at most $0.03; $0 if covered by remaining monthly free credits. The current account credit balance is unknown. Bright Data advertises 5,000 free monthly records and says failed deliveries are not charged ([Groups Scraper pricing](https://brightdata.com/products/web-scraper/facebook/groups)).
- **Gate:** before any request, verify an enforced per-request record cap for this exact group dataset, or configure a provider-side budget limit that guarantees a maximum. Until then, do not run this request. The prior 60-record result is a planning estimate only, not a bound.
- **After the separate go-ahead:** save the capped raw response, classify and ingest with shadow mode and the legacy write guard, then report received records, exact canonical deltas, and provider usage. Do not start other groups or Facebook Camoufox discovery in the same run.
