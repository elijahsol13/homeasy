# Bright Data single-group shadow pilot — 2026-10-07

## Account preflight

Before the run, the Bright Data Control Panel showed 3,511 free credits, $2 account balance, $0 consumed, and no payment methods. The $2 is a potential existing-balance exposure after free credits are exhausted; no payment card was attached. The billing settings page exposed no monthly spend-limit or auto-recharge control.

The Facebook Groups dataset `gd_lz11l67o2cb3r0lkj3` has no documented provider-side record cap in the public input schema. The generated request did not include a guessed cap field. The earlier 60-record observation was not treated as a maximum.

## Request

Exactly one scrape job was submitted for `Real Estate in Siem Reap`, group `495676670504992`, for the single calendar date 2026-10-07. Shadow ingestion and legacy write guard were enabled; paid freshness was disabled. The provider returned HTTP 202 with snapshot `sd_muxur0qt2oy8f98vuz`, then completed the same job with 31 delivered records. No additional groups or scrape jobs ran.

Sanitized payload:

```json
{
  "dataset_id": "gd_lz11l67o2cb3r0lkj3",
  "endpoint": "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_lz11l67o2cb3r0lkj3&include_errors=true&format=json",
  "input": [
    {
      "url": "https://www.facebook.com/groups/495676670504992",
      "start_date": "2026-10-07",
      "end_date": "2026-10-07",
      "user_to_not_include": ""
    }
  ]
}
```

## Usage and ingestion

- Bright Data free credits: 3,511 → 3,480, a reduction of 31.
- Bright Data account balance: remained $2; consumed amount remained $0.
- Provider records: 31 delivered; 29 usable posts entered classification.
- Classification: 24 `HOUSING_SUPPLY`, 5 `IRRELEVANT`.
- Shadow ingestion: 29 source items, 29 versions, 24 current occurrences, 0 ingestion errors.
- Canonical inventory vs accepted Phase 5C baseline: properties 443 → 460 (+17); listings 443 → 460 (+17); active listings 441 → 458 (+17); inactive listings remain 2; current occurrences 704 → 728 (+24); historical occurrences remain 2.
- Legacy `properties`: 390 rows; digest remains `59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272`.
- Paid freshness checks: 0.

The 24 new current occurrences map to 24 distinct listings; 17 canonical listings were newly created and the remaining occurrences attached to existing listings. This indicates the run added canonical inventory without duplicating every accepted post into a new listing.

## Initial transport failure

The first attempt ran inside the restricted shell and failed before obtaining an HTTP response. DNS lookup inside that environment returned `ENOTFOUND` for `api.brightdata.com`; the same hostname resolved and accepted an HTTPS HEAD outside the sandbox. Prior raw responses from 2026-10-06 also show successful HTTP 202 deliveries. The first attempt did not change the account usage. The authorized one-shot was then run from the network-enabled shell and completed successfully.

## Artifacts

- Raw snapshot: `tmp/brightdata-test/2026-10-07T08-35-12_Real_Estate_in_Siem_Reap_raw.json`
- Run summary: `tmp/brightdata-test/2026-10-07T08-35-12_summary.json`
- Classified posts: `tmp/brightdata-test/2026-10-07T08-37-57_classified.json`
- Group report: `tmp/brightdata-test/2026-10-07T08-37-57_group_report.json`

## Second Facebook snapshot — rebuilt acceptance

After the separate user go-ahead, exactly one more request was submitted with the same dataset, group, and one-day window. Bright Data returned HTTP 202, snapshot `sd_muxvubo125d4j70mpc`, and 31 delivered records. No third scrape request was made. The first run had 3,480 free credits remaining; 31 additional delivered records imply 3,449 remaining, while the account balance was last observed at $2 with $0 consumed. The billing panel was not re-opened after this snapshot, so the final balance is inferred from provider delivery rather than independently re-read.

The corrected nested-post mapper produced 30 usable posts. The initial classifier attempt found 28 source IDs with identical text hashes, but their Facebook CDN hosts, signed query parameters, and photo order differed. The old media hash treated those URL changes as real media edits, so it sent the overlapping posts through AI before the attempt was stopped. The first write attempt therefore did not meet the acceptance condition.

After the user explicitly approved sending the text of new post `39435810449398129` to configured AI providers, the saved replay completed locally. It reused cached classification results and skipped AI for the 28 same-content posts; one extraction call completed for a new post. Shadow ingestion completed with zero ingestion errors.

Facebook media identity is now normalized to the stable file path, ignoring CDN shard host, signed query parameters, and photo order. An offline comparison confirmed all 28 overlap media sets are identical under this normalization.

The API held the SQLite files open during the initial integrity checks. A forensic copy of the exact `.db`, `-wal`, and `-shm` set was captured with matching hashes. That copy passed `integrity_check` and `foreign_key_check`; the earlier `.recover` output was incomplete and was kept only as a diagnostic artifact. After graceful service shutdown, the live database checkpointed its WAL; that post-shutdown file is also archived.

A separate rebuild copy was restored to the pre-second-run state by removing exactly the 28 false media versions and the two new run-15 source/canonical objects. The restored baseline matched the first Facebook run: 460 canonical properties/listings, 728 current and 2 historical occurrences, 1,252 source items, 1,934 versions, and the unchanged 390-row legacy digest.

Both saved classified snapshots were replayed locally against the rebuild copy, with no Bright Data or AI API requests:

- First snapshot: 29 unchanged, 0 changed, 0 new source items, 0 new versions, 0 errors.
- Second snapshot: 2 new source items, 28 unchanged, 0 changed, 2 new versions, 0 errors. The two persisted AI result records belong to the two new posts; none were recorded for the 28 overlaps.

The final rebuilt database has 462 canonical properties/listings, 460 active and 2 inactive listings, 730 current and 2 historical occurrences, 1,254 source items, and 1,936 versions. Legacy `properties` remains 390 rows with digest `59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272`. Final `integrity_check` is `ok`, `foreign_key_check` is empty, and duplicate current bindings are 0.

The validated rebuilt DB replaced `data/homeasy.db`; the original live database file is archived alongside the preserved forensic trio. Docker API and bot were restarted on the rebuilt database. The scraper container remains stopped to avoid starting a new live collection cycle. API health returned `status=ok`.

Verification: Jest 44/44 suites, 387/387 tests; TypeScript typecheck passed; `git diff --check` passed.

### Second-run artifacts

- Raw snapshot: `tmp/brightdata-test/2026-10-07T09-05-45_Real_Estate_in_Siem_Reap_raw.json`
- Provider summary: `tmp/brightdata-test/2026-10-07T09-05-45_summary.json`
- Normalized replay: `tmp/brightdata-test/2026-10-07T09-05-45_shadow_replay.json`
- Interrupted classifier progress: `tmp/brightdata-test/2026-10-07T09-06-46_classification_progress.json`
- Interrupted extraction progress: `tmp/brightdata-test/2026-10-07T09-06-46_supply_progress.json`
- Completed classified replay: `tmp/brightdata-test/2026-10-07T09-06-46_classified.json`
- Rebuild repair utility: `scripts/phase5-restore-pre-second.ts`
- Forensic SQLite bundle with source hashes: `data/forensics/phase5-corrupt-20261007/`
- Forensic hashes: DB `8d43ec630d3892dfef96278880bdbbddb82f9b05523d3289966c325b7954f184`; WAL `0bc89c33904f2f2aed6917b7d834a8218be337ceed2b04ce5b6e95b47e14e533`; SHM `14d67da9ddae2ddd90680f3281c8c582cb2e3bc5d1b9fb9d82f7c0c6f0944fde`.
- Validated production replacement: `data/homeasy.db`
- Preserved recovery diagnostics: `/private/tmp/homeasy-recovery-20261007.sql`, `/private/tmp/homeasy-recovered-20261007.db`

Phase 5 Facebook shadow acceptance is complete on the validated rebuild. No further Bright Data request was made or is needed. The scraper remains stopped pending the next explicitly authorized phase.
