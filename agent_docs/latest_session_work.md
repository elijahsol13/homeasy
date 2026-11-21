# Homeasy — active handoff (2026-11-21)

## Stage 2 — local source-ingestion reliability

- Work completed and committed locally on `develop`. Stage 2 scope follows `agent_docs/modernization_plan.md`. The prior full Stage 1 Git/production baseline handoff was archived byte-identically as `agent_docs/history/session_work_2026-11-21_before_stage2_handoff.md`, SHA-256 `1f6cea207994b1767b3e6ef503d5131b5475d6b2ca6b8839f447e3cbddbacec3`.
- Facebook outbox flushes for the same directory are serialized within the process. Response ACK validation requires complete nonnegative counts and no errors before removing a queued file. Bad/partial responses retain the batch for retry.
- Khmer24 import marks unavailable AI enrichment as a processing error and responds with HTTP 503, retaining Mac outbox batches for replay. The import repository permits successful classification retry of an unchanged `UNCLASSIFIED` source without adding a fabricated content version. Ingestion run and per-source success/failure counters now reflect enrichment failures.
- Source-verified Khmer24 coordinates and `maps_url` survive appropriate source refreshes, including when a later source extraction temporarily omits the URL while retaining the same coordinates. A verified location change updates canonical ingestion without relying on AI location guesses.
- Both internal ingestion endpoints now use the same constant-time Bearer verification and structured success/failure counters in application logs. The emitted events are `ingestion_batch_completed` and `ingestion_batch_failed`. No raw listing text or error messages are included in the new logging helper.
- Tests cover Facebook queued-batch concurrency and response validation, unchanged-source retry, enrichment failures, run metrics, source-verified map pin updates and omissions, and both HTTP endpoints. The temporary missing-URL regression was observed failing before the fix and passing after it.
- Both endpoints issue per-source throttled warnings via the existing `AlertService` for partially failed imports and unexpected exceptions. Alerts use trusted counters or static text, omit raw listing/provider errors, and rearm after a successful batch. A failed alert attempt preserves the ingestion HTTP error/producer retry. Mocked Telegram `sendMessage` and failure paths are covered by endpoint tests.
- Temporary SQLite WAL databases proved that a competing writer waits/fails while a transaction is open, readers see committed state only, and both committed writes survive a verified snapshot and writable restore. Existing backup tests also cover open/uncommitted transactions, foreign-key/integrity errors and rollback. No live database was opened for the rehearsal.
- Security finding: a test initially used the real grammY client because webhook registration replaced the mock, and a failed DNS request printed a Telegram API URL containing the configured bot token in local logs. The test harness now restores its mock after registration. `AlertService` catch blocks no longer log raw exception objects. No successful Telegram send occurred in that test. Rotate the exposed bot token as a precaution through a separately authorized credential change.

## Checks and evidence

- Backend Jest **99 suites / 1103 tests passed** after WAL and alert regressions (`/private/tmp/homeasy-stage2-full-jest.log`); focused SQLite/ingest/alert suite **5 / 30 passed** (`/private/tmp/homeasy-stage2-targeted.log`). Jest uses `--forceExit`. The new exception/error-logging tests were observed RED before implementation and GREEN after.
- Root TypeScript and ESLint passed. Frontend Vitest **14 files / 185 tests passed**, frontend lint exited 0 with existing warnings. Backend build and both Web/TMA builds passed with the known large MapView chunk warning. `git diff --check` passed before the handoff.
- The independent reviewer agent `01a1fde6-f06c-7ef1-b368-36bb4a6e45de` disconnected twice. No independent review approval is claimed. Local integrator inspected the source diff and exercised the missing-map-URL RED→GREEN regression.
- Production was untouched during Stage 2: no VPS database change, network scrape, paid AI call, Docker recreation, Cloudflare action, GitHub push or deployment. Historical VPS checkout and published Web/TMA evidence are recorded in the archived handoff and `project_progress.md`; those states have not been freshly rechecked in this stage.

## Remaining authorized sequence

1. Confirm the actual configured Telegram admin recipient and delivery of ingestion-error alerts on the running environment in an approved operational check. Local delivery is verified only with the test double. Review rotation of the token revealed in a local exception log.
2. Stage 1 production-release gate remains open: retained/pinned Docker images and digest evidence, attributable Web/TMA artifacts, verified rollback and smoke tests require a separately approved production release. When authorized, validate Stage 2 against real ingestion/API/SQLite on VPS before claiming production acceptance.
3. Stage 3 targets catalog photos, strict geography/GPS, the observed public count change from 264 to 219, Web/TMA performance and real-device checks. No live data corrections without a bounded approved scope.

`agent_docs/project_progress.md` owns verified state, `agent_docs/decisions.md` owns accepted decisions, and `agent_docs/modernization_plan.md` owns stage criteria. The previous detailed Git/deployment handoff is preserved in `agent_docs/history/`.
