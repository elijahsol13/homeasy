# Phase 5 shadow acceptance — 2026-10-07

> Historical initial report. Phase 5D later restored the legacy baseline and ran guarded 20-item Khmer24 repeats. See the Phase 5D outcome below and [the detailed mutation report](phase5d-legacy-diff-20261007.md) for the final status.

## Scope and stop point

Two initial controlled Khmer24 shadow discovery cycles were run with a five-listing cap each. During Phase 5D, two more cycles were run with a 20-listing cap after the legacy write guard was added. The HTTP path returned 403, so the configured local Camoufox fallback was used with the traffic guard active before navigation. The cycles were limited to Khmer24; no Facebook discovery, BrightData request, or paid freshness execution was run. Work stops before Facebook live discovery as requested.

The initial five-record feed changed between cycles: cycle 1 received five records; cycle 2 received five, of which one overlapped and was unchanged. The more representative Phase 5D sample showed stronger overlap:

| Metric | Run A (processing run 11) | Run B (processing run 12) |
|---|---:|---:|
| Feed records | 20 | 20 |
| New source items | 18 | 2 |
| Changed source items | 0 | 0 |
| Unchanged source items | 2 | 18 |
| Errors | 0 | 0 |
| New source item versions | 18 | 2 |
| Canonical property/listing/current occurrence delta | +14 / +14 / +14 | 0 / 0 / 0 |

Run A sent 18 new candidates through three AI rewrite batches (six each); 14 were accepted as residential supply and four classified `IRRELEVANT`. Run B's 18 unchanged items bypassed AI enrichment; the only two AI candidates were newly encountered records, both classified `IRRELEVANT`. Run B added two raw source items and two versions, with no canonical materialization. Thus the unchanged-item AI bypass and zero canonical delta were verified on 18 overlaps. All rejected candidates remain in raw ingestion as `IRRELEVANT`.

## Production database observations

| Measure | Baseline | After two cycles |
|---|---:|---:|
| `source_items` | 1,193 | 1,222 |
| `source_item_versions` | 1,875 | 1,904 |
| Canonical properties | 423 | 443 |
| Canonical listings | 423 | 443 |
| Canonical source occurrences (all) | 686 | 706 |
| Canonical source occurrences (current) | — | 704 |
| Legacy `properties` rows | 390 | 390 |

The database passed SQLite `integrity_check` and `foreign_key_check`. The legacy table was restored row-by-row from the Phase 5 baseline copy for only the columns proven changed. Its current count, IDs, and canonical full-row digest exactly match the baseline. The detailed before/after diff for all 14 rows and the writer analysis are in `phase5d-legacy-diff-20261007.md`.

Two initially AI-rejected records from the first five-item cycle were mistakenly materialized as housing supply by the then-current shadow wrapper. The wrapper was corrected before the next cycle. Those two raw records remain, now classified `IRRELEVANT`; their mistakenly created canonical occurrences were closed and retained as history. The 20-item cycles used the corrected behavior. This history explains the two inactive derived listings and closed historical occurrences.

## Cost and freshness boundary

The provider usage table contains four Khmer24 discovery entries (two five-record runs and two 20-record runs; 50 records total). It contains no BrightData usage. There are zero freshness jobs. The final freshness dry-run was read-only and returned:

- 441 active canonical listings; 385 considered fresh and 56 stale.
- 0 proposed checks; the 56 stale listings had no active demand in top-N.
- Paid execution disabled; BrightData budget, reserve, and estimated records all zero.

## Phase 5D outcome

The scoped Phase 5D investigation and repair is complete. The 20-item repeat reached 18 unchanged records, with no repeated AI enrichment, versions, or canonical writes for those unchanged items. The legacy full-row digest matched baseline before and after both guarded cycles. Phase 5 remains open, and Facebook/BrightData live discovery must not start automatically.

## Verification already performed

After the Phase 5D changes, the full Jest suite passed (43 suites, 380 tests), typecheck passed, and `git diff --check` passed. After the guarded live cycles, SQLite `integrity_check` returned `ok`, `foreign_key_check` returned no rows, the legacy digest still matched, and `npm run freshness:dry-run` completed read-only with paid execution disabled.
