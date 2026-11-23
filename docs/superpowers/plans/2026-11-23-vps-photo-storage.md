# VPS Photo Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax. Preserve the existing dirty develop checkout and live data; do not mix the prior context-recovery changes into a feature commit.

**Goal:** Serve source-verified Facebook galleries from WebP files on the existing VPS and remove unused files 90 days after public disappearance (or 90 days after upload for never-public photos).

**Architecture:** Mac keeps the pinned Facebook session, obtains a complete source-bound photo set, converts with the existing sharp dependency and sends bytes through an authenticated API. VPS stores immutable content-addressed files under data/media, tracks gallery versions and file references in SQLite, projects hosted URLs, and reuses the backup worker for bounded cleanup. Media has no separate backup; a lost VPS disk loses the files.

**Tech Stack:** TypeScript, Fastify, SQLite DatabaseSync, sharp, Jest, existing Mac Facebook outbox and VPS Compose volume.

**Spec:** docs/superpowers/specs/2026-11-23-vps-photo-storage-design.md

## Global Constraints

- Preserve data/, WAL/SHM, pinned Camoufox device/session, production containers and existing dirty source files.
- No Facebook automation on VPS. No live Facebook run, bulk backfill, paid calls, production DB write, deployment or GitHub push in local implementation.
- Keep original source URLs and source item history. Do not infer historical photo correspondence from filename or equal counts.
- 90 full days after public disappearance, or 90 full days from successful upload for never-public photos. Retire at day 90, purge gallery references after a 14-day hold plus snapshot rotation, and delete orphan bytes after another 14-day hold plus snapshot rotation (normally day 118 or later). Physical deletion requires current backup health and zero remaining references.
- No new dependency, daemon, cron, S3 or Mac/off-VPS media copy. Existing sharp and backup worker suffice.

## Review Focus

- A photo from another group/post or a partial gallery must not replace a gallery. Task 3 test.
- Replayed upload and interrupted file write must not create duplicate DB links or expose a partial file. Task 2 test.
- One hash referenced by two public listings must not be deleted when one disappears. Task 5 test.
- An old DB snapshot restored after file deletion must return a controlled missing-photo fallback, not 500. Task 4 test.
- Backup failure, symlink/path escape and a listing reappearing before physical deletion must leave bytes intact. Task 5 test.

---

### Task 1: Schema and content-addressed file store

**Files:** Modify src/database/migrate.ts. Create src/modules/media/hosted-media-store.ts and src/modules/media/hosted-media.repo.ts. Test tests/hosted-media-store.test.ts.

**Interfaces:** storeEncodedPhoto(root: string, input: Buffer) -> {hash, relativePath, byteLength}; HostedMediaRepository records gallery versions keyed by source_item_id, ordinal, optional photo anchor, and full/thumb hashes. Files use SHA-256 names and only the configured data/media root.

- [ ] Write failing temporary-directory/SQLite tests for hash idempotence, atomic file visibility, two references to one hash, and path safety.
- [ ] Run focused Jest; confirm failure is the missing behavior.
- [ ] Append one migration for hosted file metadata, source gallery version and ordered references; implement the minimum store/repository operations.
- [ ] Run focused Jest and typecheck; inspect exact output.

### Task 2: Bounded authenticated VPS media API

**Files:** Create src/modules/api/routes/facebook-media.routes.ts. Modify src/modules/api/server.ts. Test tests/facebook-media-routes.test.ts.

**Interfaces:** POST /api/v1/internal/facebook/media accepts a bounded gallery upload keyed by group_id + post_id and resolves exactly one matching FACEBOOK_GROUP source item; GET /api/v1/media/:hash/:variant serves a validated stored WebP or 404. Reuse the existing FB_INGEST_TOKEN bearer check.

- [ ] Write failing API tests for auth, wrong/ambiguous source, MIME/signature/size, replay, complete gallery activation and missing file.
- [ ] Run focused Jest; confirm red.
- [ ] Implement route and atomic DB publish only after all files are valid; never accept a caller-chosen filesystem path.
- [ ] Run focused Jest and typecheck.

### Task 3: Mac source-bound capture, conversion and replay

**Files:** Create src/modules/parser/facebook-gallery-media.ts and src/modules/parser/facebook-media-outbox.ts. Modify src/modules/parser/facebook.scraper.ts only at the validated media handoff. Test tests/facebook-gallery-media.test.ts and tests/facebook-media-outbox.test.ts.

**Interfaces:** extract a gallery from one verified post article only after render-ready detection, preserving current photo anchor order; convert selected bytes with sharp (full WebP max 1600 px/quality ~75; thumbnail 400 px) and strip EXIF; queue durable bounded uploads to the authenticated endpoint with replay. The normal browser traffic guard remains attached.

- [ ] Write failing fixture tests for wrong post, initially empty DOM, partial gallery, duplicate anchors, metadata stripping, retry and durable outbox ACK.
- [ ] Run focused Jest; confirm red.
- [ ] Implement the source-scoped extractor, converter and queue; do not launch Camoufox in tests or run a live scraper.
- [ ] Run focused Jest and typecheck.

### Task 4: Catalog projection and browser fallback

**Files:** Modify src/database/repositories/canonical-listing.repo.ts and relevant API DTO/route only as needed; modify Web/TMA image rendering only if current fallback cannot handle 404. Test tests/canonical-listing.repo.test.ts and focused frontend photo tests.

**Interfaces:** Public list/detail return hosted URLs in verified gallery order when an active complete version exists; preserve existing source URL behavior otherwise. Missing hosted files return source URL if usable or placeholder without crashing.

- [ ] Add failing tests for list/detail/thumbnail order, absent file and unverified historical mapping.
- [ ] Run focused Jest/Vitest; confirm red.
- [ ] Implement the smallest projection/render changes.
- [ ] Run focused tests, typecheck and local browser smoke with isolated fixtures.

### Task 5: Retention and safe cleanup

**Files:** Create src/modules/media/hosted-media-gc.ts. Modify src/database/backup-worker.ts to invoke bounded housekeeping after a successful backup without making backup health depend on GC success. Test tests/hosted-media-gc.test.ts and tests/backup-worker.test.ts.

**Interfaces:** public visibility uses the same repository predicate as canonical reads; track first nonpublic time and reset on return; never-public timer starts at upload. Mark at 90 days, purge links after day 104 and ordinary snapshot rotation, then physically delete after a second 14-day hold and snapshot rotation (normally day 118 or later). Dry-run is the default for manual inspection; automatic runs are batch-limited and fail closed on backup/path inconsistency.

- [ ] Write failing tests for days 89/90/104/118, reappearance, shared hash, pending/never-public, backup failure and symlink escape.
- [ ] Run focused Jest; confirm red.
- [ ] Implement GC and hook it into the existing worker; keep original SQLite/source history intact.
- [ ] Run focused Jest and typecheck.

### Task 6: Integrated local acceptance and handoff

**Files:** Update agent_docs/project_progress.md, agent_docs/latest_session_work.md and relevant VPS operator/release notes after implementation.

- [ ] Run all new focused tests and the applicable backend Jest, frontend Vitest, typecheck, lint and builds. Read output; fix actual regressions.
- [ ] Exercise Mac-to-VPS API and public image journey on isolated local fixtures, including a real browser cover/detail check and missing-file fallback.
- [ ] Independently review the feature diff; fix important findings with a failing test then a passing suite.
- [ ] Record exact local evidence, current storage estimate, missing live proof and the separately gated production/backfill/release steps. Do not claim live recovery.
