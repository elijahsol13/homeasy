# Homeasy — active handoff (2026-11-21)

## Stage 2 — local source-ingestion reliability

- Work completed and committed locally on `develop`. Stage 2 scope follows `agent_docs/modernization_plan.md`. The prior full Stage 1 Git/production baseline handoff was archived byte-identically as `agent_docs/history/session_work_2026-11-21_before_stage2_handoff.md`, SHA-256 `1f6cea207994b1767b3e6ef503d5131b5475d6b2ca6b8839f447e3cbddbacec3`.
- Facebook outbox flushes for the same directory are serialized within the process. Response ACK validation requires complete nonnegative counts and no errors before removing a queued file. Bad/partial responses retain the batch for retry.
- Khmer24 import marks unavailable AI enrichment as a processing error and responds with HTTP 503, retaining Mac outbox batches for replay. The import repository permits successful classification retry of an unchanged `UNCLASSIFIED` source without adding a fabricated content version. Ingestion run and per-source success/failure counters now reflect enrichment failures.
- Source-verified Khmer24 coordinates and `maps_url` survive appropriate source refreshes, including when a later source extraction temporarily omits the URL while retaining the same coordinates. A verified location change updates canonical ingestion without relying on AI location guesses.
- Both internal ingestion endpoints now use the same constant-time Bearer verification and structured success/failure counters in application logs. The emitted events are `ingestion_batch_completed` and `ingestion_batch_failed`. No raw listing text or error messages are included in the new logging helper.
- Tests cover Facebook queued-batch concurrency and response validation, unchanged-source retry, enrichment failures, run metrics, source-verified map pin updates and omissions, and both HTTP endpoints. The temporary missing-URL regression was observed failing before the fix and passing after it.

## Checks and evidence

- Backend Jest **99 suites / 1099 tests passed** after the map-link fix. Log at `/private/tmp/homeasy-stage2-jest-post-review.log`; Jest uses `--forceExit`. Restricted-network PostHog DNS `ENOTFOUND` messages occurred in log output without failing tests.
- Root TypeScript and ESLint passed. Frontend Vitest **14 files / 185 tests passed**, frontend lint exited 0 with eight existing warnings. Backend build and both Web/TMA builds passed, with a previously known MapView chunk warning (~1.21 MB).
- The independent reviewer agent `01a1fde6-f06c-7ef1-b368-36bb4a6e45de` disconnected twice. No independent review approval is claimed. Local integrator inspected the source diff and exercised the missing-map-URL RED→GREEN regression.
- Production was untouched during Stage 2: no VPS database change, network scrape, paid AI call, Docker recreation, Cloudflare action, GitHub push or deployment. Historical VPS checkout and published Web/TMA evidence are recorded in the archived handoff and `project_progress.md`; those states have not been freshly rechecked in this stage.

## Remaining authorized sequence

1. Finish local Stage 2 operational acceptance with isolated SQLite WAL/concurrent-write/backup-and-restore rehearsal, and verify that import-error alerts actually reach the intended operational channel. Existing structured logs alone do not establish delivery.
2. Stage 1 production-release gate is still open: retained/pinned Docker images and digest evidence, attributable Web/TMA artifacts, verified rollback and smoke tests require a separately approved production release. When authorized, validate the Stage 2 build against real ingestion/API/SQLite on VPS before claiming production acceptance.
3. Stage 3 targets catalog photos, strict geography/GPS, the observed public count change from 264 to 219, Web/TMA performance and real-device checks. Do not start live data corrections without a bounded approved scope.

`agent_docs/project_progress.md` owns verified state, `agent_docs/decisions.md` owns accepted decisions, and `agent_docs/modernization_plan.md` owns stage criteria. The previous detailed Git/deployment handoff is preserved in `agent_docs/history/`.
