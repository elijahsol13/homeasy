# Homeasy — current verified state (2026-11-23)

This file contains the active priorities and last verified state. Earlier full progress is archived byte-identically in [history/project_progress_2026-11-22_before_context_compaction.md](history/project_progress_2026-11-22_before_context_compaction.md). Prior evidence is in [history/README.md](history/README.md) and the dated [independent audit](../reports/homeasy-independent-audit-20261122.md).

## Current development status

- Local integration branch is `develop`, ten commits ahead of `origin/develop` at the context-recovery intake. GitHub has two long-lived branches, `main` for production and `develop` for integration. The local work is pending release. Recheck Git before publishing.
- The Mac holds Facebook/Camoufox with pinned session/device identity. The VPS hosts the API, bot and SQLite. Manual Khmer24 collection and authenticated delivery run Mac → VPS. Keep this architecture.
- Locally repaired the failed-Telegram-alert cooldown and Khmer24 same-URL enrichment collision. Targeted tests **26/26**, backend Jest **1142/1142**, typecheck/lint/build passed at the corresponding checkpoint. Live Telegram delivery and ingest verification remain pending.
- Subsequent source-backed location corrections restrict district precision and map clusters to verified `locationKey` evidence, reject proximity wording as a sangkat, and fix district pin → list navigation. Fresh local results from 2026-11-22 were backend Jest **1148/1148**, frontend Vitest **192/192**, root typecheck/lint/build, frontend lint, Web/TMA builds, real Chrome loopback UI smoke and `git diff --check` PASS. Warnings in lint/build/Jest existed. This is local acceptance only.
- Known Facebook CDN links expire after days and saved public covers have failed. The original expiry cause was investigated earlier. On 2026-11-23 the owner selected local VPS storage and WebP conversion, with cleanup eligibility 90 days after catalog disappearance; S3/object storage stays deferred. A local implementation with migration v59, authenticated media upload, source-scoped galleries, Mac outbox, public projection and bounded GC passed 105/105 backend suites (1185/1185 tests), 15/15 frontend suites (194/194 tests), TypeScript/lint/build and Chrome media fallback smoke on 2026-11-23. These were isolated local checks. Full source-gallery recovery, representative real WebP sizing and VPS validation remain open. The one-post authenticated probe and limitations are documented in [the dated source check](../reports/homeasy-camoufox-one-post-gallery-20261122.md).
- Production release, same-SHA provenance, operational rollback rehearsal, real Android/iOS WebView acceptance, catalog cohort/pilot and live issue verification are open.

## Owner-approved work sequence

1. **Read-only release and rollback baseline** — recorded. Operational rollback rehearsal remains a release gate.
2. **Telegram alert cooldown fix** — reproduced and locally verified. Live delivery still pending.
3. **Khmer24 same-URL batch enrichment fix** — reproduced and locally verified. Live ingest still pending.
4. **Durable Facebook media/gallery strategy** — locally implemented and accepted with migration v59 and isolated tests/browser on 2026-11-23. Owner approved VPS-only media with no separate backup, 90 days after disappearance, or 90 days from upload for never-public photos. GC marks galleries after 90 days, purges links after 104+ days and releases orphan bytes after 118+ days when snapshots have rotated. See [design](../docs/superpowers/specs/2026-11-23-vps-photo-storage-design.md) and [latest evidence](latest_session_work.md). Next gate is source-backed pilot and VPS free-disk/size measurement, separately approved production release and live collection. Do not assume historical links were recovered.
5. **Source-backed catalog/geo/freshness check** — location fixes verified locally, controlled cohort and production checks open.
6. **Same-SHA build/deploy/recovery checks** — CI/Docker/Web/TMA provenance, rollback rehearsal and release approval open.
7. **Real-device acceptance and catalog pilot** — Android/iOS checks, mobile timings and user-facing acceptance open.

## Current temporary workstream — Codex continuity

Owner approved addressing excessive context compaction, repeated rediscovery and ignored project instructions. A compact-only `SessionStart` checkpoint restore is installed at `scripts/codex/restore_checkpoint.py`. Seven focused tests, live-file simulation, hook configuration preservation and trust-record presence were verified on 2026-11-22. Its effect during an actual Codex compaction is still unobserved. Exact evidence belongs in [latest_session_work.md](latest_session_work.md). Continue the approved product sequence above without repeating earlier audits.

## Operational boundaries

Keep `data/` SQLite/WAL/SHM, private sessions and device identity intact. Product release, production DB writes, Facebook scraping, paid processing, GitHub push and live service changes follow their specific owner scope and recovery controls. Accepted decisions live in [decisions.md](decisions.md). Entry path is [current_context.md](current_context.md). Harness behavior is [harness_protocol.md](harness_protocol.md).
