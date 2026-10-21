# Project Diary

## Decisions and Lessons

- Mini App sorting already existed in filter state, API parameters, drawer, and legacy query. Expose it directly on the feed by reusing these interfaces; avoid adding dependencies or changing filter semantics.
- Default sort stays `newest`, including the canonical confidence-tier priority. Explicit price sorting instead orders globally by price across confidence tiers. Missing/non-positive prices come last and equal prices have deterministic tie-breakers.
- Async pagination must be guarded across filter/sort changes. A generation check prevents older first-page and Load More responses from corrupting the current list.
- Existing uncommitted edits cover many unrelated files; distinguish scoped acceptance from broader lint/test failures and preserve the user's dirty working tree.
- Workflow documentation directory `agent_docs/` was absent at deployment entry, preventing complete required intake. Re-establish concise canonical documents and explicitly preserve this limitation in the handoff.

## 2026-10-14 — system audit and stabilization

- Canonical must replace legacy, with stability/recovery first. Stale scraped listings may be cleared and sequentially re-ingested **after** cutover, with user/analytics/source history and exact deletion scope preserved.
- Current infrastructure is MacBook Docker Compose and shared SQLite WAL. Facebook Camoufox host/session fingerprints cannot simply be carried to Linux with a server move.
- Development `.env` may select canonical; tests using legacy fixtures must isolate read mode. Schema migration assertions need to reflect v52.
- Canonical listing-specific GPS must survive map/list/detail projection. Validate and reject implausible locations, then fall back to trusted property/maps coordinates.
- Snapshot verification and standalone restoration are different checks. Automated restore coverage exists; external copies and operational restore rehearsal remain required.
- Frontend cold-start and 500–1000-user capacity need real measurements; total users and simultaneous API clients are different loads.
- Effective agent harness discipline means standing invariants, a current-status file, an explicit decisions file, append-only lessons and a reproducible end-of-session checkpoint. Native subagents take bounded tasks with single-owner edits.

## 2026-10-14 — canonical moderation and detached parity checkpoint

- A canary admin must be able to moderate canonical records even while the global read switch stays legacy. Treat canonical `public_ref` and legacy numeric property IDs as distinct namespaces; don't infer an alias from a canonical numeric ID.
- Moderation decisions transition only from `pending`. Unavailable/removed/rented canonical listings must never become newly approved; rejected and inactive records must remain inspectable to admins without leaking to public detail.
- A detached comparison is a **diagnostic**, not a cutover certificate: 69 legacy vs 169 canonical Siem Reap rental results with 62 semantic overlaps, five source/duplicate flags needing human review. Improved SQL counts must not conceal identity mismatches, media/contact gaps or deep-link behavior.
- Matching and Telegram notifications still depend on legacy repo/ID semantics; implement canonical-specific alert identity and deduplication before switching global reads.
- Preserve measured frontend cold-start as an explicit task: Vite entry ~737.67 kB uncompressed / ~223.50 kB gzip, occasional slow Telegram Mini App initial load reported by owner. Measure real-device critical path before changing chunk strategy.

## 2026-10-14 — cohort-safe Telegram matching and source alias triage

- The canonical cohort must use canonical listing refs in match alerts, filter results, favorites and reports. A legacy numeric `id` can equal a canonical integer `id` without identifying the same listing. Check the cohort using the Telegram user ID, not a default/absent identity.
- Match newly approved canonical listings directly. Legacy ingestion may fan out to canonical canaries only after resolving the explicit `legacy_property_id` alias and finding a publicly visible canonical listing. Preserve legacy notifications for legacy users.
- v54 stores canonical reports independently with one complaint per (listing, user), moderator review on first report and no auto-hide. Both callback namespaces remain separate; old legacy inline buttons must not mutate canonical-canary state.
- Full offline Jest suite: 53/53 suites, 445/445 tests after fixing a stale v52 migration assertion; web Vitest 4 files / 23 tests, TypeScript, lint, build and diff whitespace all passed. Jest still emits a post-run open-handle warning.
- Detached snapshot confirms three legacy Khmer24 ID duplicates share adid/price/city and map to canonical listings through counterpart aliases (22/215, 19/213, 12/286). Old missing alias IDs have no favorites. Source-less Facebook IDs 165 and 2 need fresh evidence; 165's city/title contradict. No alias repair, production write or external scraping occurred.
- Next evidence: controlled duplicate-alias backfill with explicit conflict checks; owner-attended Telegram canary; off-device encrypted backups and Docker restore rehearsal before global read switch.

## 2026-10-14 — detached alias repair rehearsal and ingestion alerts audit

- The alias validation must fail closed unless Khmer24 URLs and independent listing fields match an already trusted sibling alias; an identical ad ID by itself is not evidence. Five unmapped legacy IDs passed in a 42-candidate audit; 37 remained blocked.
- Applied those five aliases only to a private temp backup of a detached snapshot. Counts 1268→1273; repeat idempotent; protected-table hashes unchanged; SQLite integrity OK and no FK violations. Evidence `reports/phase6a-khmer24-alias-rehearsal-20261014.json`.
- The existing 13-scenario read parity comparator remains 62 semantic matches, 7 legacy-only after alias repairs; this is expected because a URL-based one-to-one semantic measure does not read the alias table. Keep source identity/alias resolution as a separate metric.
- Canonical source ingestion lacks a notification trigger, while moderation approval has one. Notification queue memory is not a durable sent ledger: avoid dispatching on every scrape/reconciliation without database-backed publication/user event deduplication.
- `npm run typecheck` and `npm run lint` passed after the alias code; no live scraping, external delivery, or live DB writes performed.

## 2026-10-14 — canonical publication ledger and delivery regression

- Canonical notifications need a persisted publication ledger and recipient ledger because canonical shadow rebuild can run repeatedly and the in-memory legacy queue cannot provide durable deduplication. Migration v55 uses one publication per canonical listing, a DB trigger for explicit approval, high-water gates for fresh discoveries, and UNIQUE `(listing_id,telegram_id)` recipients.
- Delivery claims commit before the Telegram call. A response timeout or interrupted claim is marked `uncertain` without retries because a successful but unacknowledged Telegram request may already have delivered. Stale claims are retired after five minutes; verify long-running call/concurrent-worker behavior in controlled canary.
- New-source publication must originate from a fresh `DISCOVERY` processing run after activation and approved canonical listing. Reject manual imports/reparse/replay/backfill from automatic publication. Keep `CANONICAL_ALERTS_ENABLED=false` until delivery is validated; activation skips historical approval events.
- Full verification: Jest 56 suites / 460 tests PASS, frontend Vitest 4 files / 23 tests PASS, backend/frontend builds, typecheck, lint and diff check PASS. A separate-file SQLite test verifies that two DB connections cannot claim the same alert twice. No external Telegram call, paid scraping, live database modification or cutover. Existing Jest post-run open-handles warning and initial Mini App JS bundle size of 737.67 kB remain follow-ups.

## 2026-10-14 — tracked listing deep links and StrictMode regression

- Tracking route now uses the actual canonical/legacy read path for the Telegram opener, returns canonical opaque `listingTarget` publicRef or a legacy numeric target as appropriate, and verifies approved/active canonical visibility. Explicit legacy aliases resolve through their own namespace; do not interpret canonical internal numeric IDs as legacy properties.
- Mini App consumes tracking attribution and opens the linked listing detail; `useRef` preserves a single tracking promise across React StrictMode effect cleanup/replay while each current effect may safely consume its result. Added API and frontend regressions for canonical target, legacy target, hidden listing 404 and delayed StrictMode completion.
- Verified after changes: Jest 56 suites / 461 tests PASS, Vitest 4 files / 25 tests PASS; focused API/callback suites 2/42 PASS; typecheck, lint, backend/frontend build and diff check PASS. Bundle 737.90 kB raw / 223.58 kB gzip; real-device cold-start profiling and split remain open. All tests offline; no real Telegram delivery, production DB writes, paid scraping or global cutover.

## 2026-10-14 — reproducible detached alias identity delta and unresolved-source triage

- Implemented `scripts/phase6a-alias-coverage-delta.ts` plus npm command: requires explicit before/after detached SQLite paths, refuses live/same DB, opens read-only, checks identical Siem Reap rental cohorts and unchanged existing ID mappings, and writes a new report only if the target filename does not exist.
- Report `reports/phase6a-alias-identity-delta-20261014.json`: among 69 legacy cards, explicit aliases 53→58, visible mappings 51→56, unique canonical targets 51→51, unresolved 16→11. Five repaired old IDs all point to already visible canonical listings, so these fixes improve identity/link coverage rather than enlarge inventory. Historical one-to-one semantic overlap remains 62/69.
- Remaining 11 unresolved: Facebook 1/2/4/5/156/157/159/160/164/165 have no source_items matches by post ID in the detached snapshot. Khmer24 197 maps by source occurrence to canonical 158 but the alias guard correctly blocks without a trusted sibling. A follow-up read-only comparison of the fields for 197/158 was rejected by the tool safety review; treat the fields as unverified.
- Post-script verification: `npm run typecheck` PASS; 2 suites/9 tests (`canonical-alias-parity`, `khmer24-alias-repair`) PASS; detached report PASS. No live database writes, proxy usage, Telegram sends or cutover.

## 2026-10-14 — changed-price Khmer24 identity and second detached parity rehearsal

- Verified legacy Khmer24 ID 197 and current canonical listing 158 refer to adid 13984030. An already-aliased sibling, legacy 182→158, carries the older price; all three records agree on normalized title and positive bedrooms, and the candidate matches current canonical city, category, currency and price. Introduced a strict changed-price fallback requiring all of these signals, approved/visible states and an existing trusted sibling. Blank titles, zero bedrooms, missing sibling or any mismatch fail closed. Added regression cases in `tests/khmer24-alias-repair.test.ts`.
- Second isolated audit: `reports/phase6a-khmer24-alias-audit-v2-20261014.json`, 42 Khmer24 candidates / six safe / 36 blocked. Second detached repair: `reports/phase6a-khmer24-alias-rehearsal-v2-20261014.json`, aliases 1268→1274, second pass idempotent, integrity=ok, FK violations=0, protected legacy/source/canonical/moderation/occurrence hashes unchanged. All live state untouched.
- Alias-aware delta: `reports/phase6a-alias-identity-delta-v2-20261014.json`. For 69 legacy Siem Reap rental cards: explicit aliases 53→59; visible resolved cards 51→57; distinct visible canonical targets stay 51; unresolved IDs 16→10. One-to-one semantic comparator remains 62/69; keep different measures distinct.
- All remaining ten unmapped IDs are Facebook posts without exact source_items post-ID matches in the detached snapshot. Prior `reports/phase6a3-legacy-gap-dispositions-20261007.md` already justifies 165 as Phnom Penh/out of search scope and 2 as lacking villa location evidence; do not invent source identities for the other eight.
- Full backend Jest suite 56/462 PASS; ESLint and `git diff --check` PASS. One targeted filesystem/schema introspection command was denied by the current tool safety review and did not run; continued using source and existing reports. No proxy, scraping, Telegram sends, live DB modifications or global cutover.

## 2026-10-14 — frontend lazy chunks and source geography correction

- Historical ID 165 exclusion relied on a generated title mentioning Phnom Penh, while original source text mentions Siem Reap/Pub Street (~1.1 km). Marked `SOURCE_GEOGRAPHY_CONFLICT` pending manual source verification; do not equate generated title with original evidence. ID 2 still lacks sufficient location evidence, and eight more Facebook IDs lack exact post-ID source identity. No speculative aliases.
- `MapView` now loads only when opened; frontend initial entry decreased from 737.90 KB / 223.58 KB gzip to 580.88 / 177.90 KB gzip. Static PostHog imports were consolidated into one lazy facade that initializes once when configured, preserving Telegram identity and contact event capture without affecting keyless builds; resulting initial entry is 308.51 / 87.81 KB gzip, a ~61% gzip reduction from original. With an analytics key, PostHog is a separate 271.88 / 90.23 KB gzip chunk, map 158.44 / 46.38 KB gzip.
- Frontend focused Vitest 5 files / 29 tests passed, keyless and test-key Vite builds passed, frontend lint exited 0 (existing hook warnings), and diff check passed. Backend was previously validated at 56 suites / 462 tests, but was not rerun for these frontend-only edits. Real-device cold-start p50/p95 and actual analytics events are unverified; keep profiling on the roadmap.

## 2026-10-14 — configured backup source and awaited worker shutdown

- Discovered that `createDatabaseBackup()` defaulted to `<cwd>/data/homeasy.db` even when bot/scraper/API used `DATABASE_PATH`; the wrong DB could be silently archived on a moved/configured deployment. It now loads `.env` for CLI calls, defaults to `DATABASE_PATH`, and locates backup snapshots beside the configured database. Guard retention `maxRetained` as a positive safe integer to prevent a zero setting immediately deleting all backups. Added isolated tests with two different source DBs.
- `stopWorker()` previously flagged an active scraper to stop but `src/scraper.ts` and combined `src/index.ts` immediately closed the DB, despite potentially ongoing asynchronous scraper/maintenance work. The scheduler now retains its worker completion promise and exposes `stopWorkerAndWait()`; shutdown awaits it before analytics/DB cleanup. A deterministic deferred-scrape test proves shutdown remains pending while work is in flight. A hung browser/API call can still hit the Docker `stop_grace_period: 120s` and requires an attended stop/restore rehearsal.
- Proposed remote backup encryption, independent retention, SHA-256 verification, scratch restore, and rollback flags (`LISTING_READ_PATH=legacy`, empty canary allowlist, canonical alerts disabled) in `sqlite_recovery_runbook.md`. No off-device archive was transferred and no production database or Docker container was touched. Remote provider/key custody, RTO/RPO and acceptance thresholds still require owner selection.
- Focused Jest 2 suites / 13 tests PASS. Full backend Jest 56 suites / 465 tests PASS, build/typecheck/lint/diff check PASS. Repeated full Jest with `--detectOpenHandles`: 56/465 PASS and exit 0 without identifying an open handle; normal run still emitted its transient exit-delay warning.

## 2026-10-14 — local-only MVP backups and independent schedule

- Owner confirms MacBook local storage for MVP with tolerated data loss up to 24 hours; S3 comes later. No live Docker deployment or SQLite operation was authorized by this decision.
- The daily scraper maintenance backup does not assure recovery points if the scraper pauses. Added isolated minimal Node Compose backup worker (12h successful interval, 30m failure retry), age-based health check (24h) and common 21-file retention. Local snapshots are still on the same disk, so host failure is unprotected and Docker health requires operator monitoring.
- Focused backup tests 2 suites / 12 PASS; full Jest 57 suites / 467 PASS; TypeScript, lint, build, Compose config and diff check PASS. Live-container activation and end-to-end restore remain unverified. S3 encryption/remote checks deferred.

## 2026-10-14 — aligned roadmap and harness with local MVP backup decision

- Reconciled `HOMEASY_ROADMAP.md` stage 1, infrastructure guidance and immediate recovery gates, plus `agent_docs/harness_protocol.md`: verified local backup and restore are mandatory for MVP cutover; external S3 replication/encryption/restore are planned after MVP under the owner's accepted 24-hour RPO tolerance. The required pre-cutover snapshot must be protected from routine rotation. Did not deploy Compose, access production SQLite, alter aliases, run scrapers or send notifications.

## 2026-10-14 — first live Docker backup and verified local recovery

- Explicit continuation authorized backup-only Compose rollout. `docker compose up -d --no-deps --build backup` succeeded; `homeasy-backup` was healthy with API/bot/tunnel still running and the scraper already stopped. The worker emitted its first verified live SQLite snapshot (58,560,512 bytes; 10 rotating snapshots retained). The 12h successor and alerting are still unobserved.
- Fresh snapshot SHA-256 `7bafa3a26e00551005fca8b78a68777c5174fbfcb5c6fa0d91cb98855966df2c`. Detached host restore passed full integrity and foreign-key checks, representative canonical/source/user table reads, and actual write/read/drop. A duplicate snapshot protected under `data/backups/verified-checkpoints/` passed checksum verification. A separate disposable Docker runtime with no network and only read-only source bind mount restored a writable temp copy successfully. See `reports/backup-compose-restore-20261014.json`.
- Backup Jest 2 suites / 12 tests and Compose config passed. Docker image npm install reported 5 production dependency advisories (3 moderate, 2 high); security remediation needs a separate version review. No modification of live table contents, production restore/restart, scraper run, Telegram send, inventory clearing, canonical cutover or S3 transfer. Production API/WAL rollback exercise remains gated.

## 2026-10-14 — protected-snapshot API recovery and canary rehearsal

- Added a repeatable offline smoke check in `scripts/backup-api-restore-smoke.ts` for a protected SQLite checkpoint; it uses a disposable writable copy, isolated Fastify requests, dummy credentials and checksum comparison. Its actual pass evidence is `reports/backup-api-restore-smoke-20261014.json`, with 69 legacy / 169 canonical searchable rental cards, 7 / 10 map markers, detail/metadata/sort/404 and schema migrations v53–v55 on scratch.
- Signed-Telegram synthetic canary and control identities demonstrated cohort isolation, canonical favorites round trip and legacy fallback without making a Telegram request or modifying production. Targeted tests 3 suites/45 pass, typecheck/lint/diff check pass. The ad hoc standalone TypeScript check was auto-review-blocked before execution; runtime CLI passed. Real-user Telegram canary and actual Docker/WAL rollback are still mandatory.

## 2026-10-14 — isolated real HTTP recovery and Mac backup notifications

- After the protected 58,560,512-byte snapshot and detached `Fastify.inject()` restore proof, added `scripts/recovery-docker-api-smoke.sh` to run a real listening `dist/api.js` from separate disposable SQLite copies, in networkless read-only Docker containers. Legacy 69 catalog/7 map and canonical 169/10 both passed health/list/detail/map/filters/invalid-ID 400/unknown-ID 404 checks. The protected checkpoint SHA-256 stayed `7bafa3a26e00551005fca8b78a68777c5174fbfcb5c6fa0d91cb98855966df2c`; no production data or API process was changed.
- Added host-side watchdog with `backup:monitor` CLI, 18h warning/24h critical freshness and Docker inspection, macOS Notification Center delivery, deduplication, and every-30-minutes LaunchAgent installation. Fixed a real initial LaunchAgent PATH issue by pinning absolute Docker/Node paths; agent last exit 0 and on-demand monitor `ok` at snapshot age ~0.8h were observed. Real failure notification and sleep/wake handling remain untested; an offline/sleeping Mac cannot satisfy 24-hour RPO by itself.
- Syntax, backend typecheck/lint/build, focused Jest 2 suites/6 tests, monitor Jest 4 tests, and diff check passed. Full backend suite last completed earlier at 57 suites/467 tests. Evidence `reports/backup-docker-api-and-monitor-20261014.json`. Second scheduled 12h snapshot still pending. Production stopped-Compose/WAL restore and live Telegram canaries must precede canonical cutover.
- A later restricted Codex-shell invocation reported `critical/unavailable` solely because Docker socket access was blocked in that sandbox. A read-only Docker-authorized rerun showed worker `running/healthy`, backup age 1h and monitor `ok`; LaunchAgent last exit code 0. Check monitoring from a Docker-authorized host context before declaring a live outage.
## 2026-10-14 — simulated WAL crash recovery and snapshot rollback

- Added deterministic isolated WAL incident/rollback simulation for the protected backup. Saved pending `.db/-wal/-shm` frames and proved main-only loses the committed synthetic change but replaying the full triplet restores it; preserved pre-restore evidence, restored pristine checkpoint with no old sidecars, verified writable integrity/FKs and key table counts. Host v2 report `reports/backup-wal-rollback-rehearsal-v2-20261014.json` PASS, targeted Jest 2/11 and TypeScript/lint PASS. Docker-only continuation unavailable because `docker.sock` was denied inside sandbox and escalation automatically rejected; no production service was stopped or changed. Second scheduled backup and attended maintenance-window canary remain pending.

## 2026-10-14 — deterministic backup watchdog notification rehearsal

- Refactored the host watchdog's notification/persistent marker transition to accept a test transport; failed delivery leaves marker unchanged and eligible for retry. Added `npm run backup:monitor-rehearsal` with isolated synthetic timestamps/temp marker and no Docker, osascript or live DB. Eleven scenarios PASS: status escalation, throttling, repeat, recovery, failed delivery and retry; six simulated successes and one intentional failure. Added focused marker tests; focused Jest 2/8 PASS, complete backend Jest 59 suites/474 PASS, TypeScript/lint/build/diff check PASS (preexisting Jest exit-delay warning). Built monitor JS locally, did not touch LaunchAgent installation, production SQLite, current Docker containers, Telegram or network. Real GUI delivery, sleep/wake and second independent worker snapshot remain to observe.
