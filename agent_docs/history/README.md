# Historical checkpoints — read only on demand

This folder preserves full, **byte-identical** working memory from immediately before the 2026-10-21 consolidation. The history contains superseded interim claims, repeated `latest/current` labels, detailed production outputs and older authorizations. Do not load it wholesale at task start or infer renewed permission from an old command.

- `project_progress_through_2026-10-20.md` — old 73,613-byte progress log; SHA-256 `73b6d8a30c676cd99bb9f1103ff39b622397edac3df482fc05e7cda6cf3eeac7`.
- `session_work_through_2026-10-20.md` — old 267,878-byte session log; SHA-256 `3f094c314b14a24a0d065a45665671f110a116311fa569d3da5de8417cdbb2a3`.
- `session_work_2026-10-21_prior.md` — earlier 2026-10-21 work entries moved from the bounded handoff after numeric API validation and safe localStorage restoration; covers the 4+ BR regression, FilterDrawer fix, Superpowers/Serena setup, memory cleanup and prior 2026-10-20 checkpoint.
- `session_work_2026-10-21_before-git-hardening.md` — byte-identical checkpoint of the 2026-10-21 local Git/SQLite consolidation and Mini App investigation, archived before the branch audit and pre-commit hardening handoff.
- `session_work_2026-10-22_pre-full-audit.md` — byte-identical 15,470-byte checkpoint (including the independent backend audit) archived before the 2026-10-22 full-audit handoff; SHA-256 `8f7f0197645380b43e402472366e8d41d340ce0ad46fe1c3066b44c485eeda1b`.
- `session_work_2026-10-22_before-ai-stage1-final.md` — byte-identical previous latest handoff covering the earlier AI implementation, QA, Facebook photo research and operational checks; archived before the Stage 1 final verification checkpoint.
- `session_work_2026-11-12_before_full_audit.md` — byte-identical 2026-11-12 handoff covering the VPS refresh, Web/TMA releases, Pending diagnostics and earlier detailed history; SHA-256 `91df81a5d124ad6cdb2f57a51b93e444d2018fe04a0fbd98d163e073e71d4062`. Archived before the 2026-11-21 audit handoff.
- `session_work_2026-11-21_before_release_baseline.md` — byte-identical 2026-11-21 full-audit handoff, archived before the Git/release-baseline handoff; SHA-256 `476f3195093fca9495f80c868222b2a560b4aab03950700dd8598bf144d8aebe`.
- `session_work_2026-11-21_before_stage2_handoff.md` — byte-identical 2026-11-21 Git cleanup and production baseline handoff, archived before the Stage 2 implementation handoff; SHA-256 `1f6cea207994b1767b3e6ef503d5131b5475d6b2ca6b8839f447e3cbddbacec3`.
- `session_work_2026-11-21_before_stage3_handoff.md` — byte-identical 2026-11-21 Stage 2 ingestion/SQLite/alerts verification handoff, archived before Stage 3 catalog work; SHA-256 `4bf02d9338f78583b480fc13a169b34934e8e8b763b1e5dc517536a6f39bc8c6`.

Current progress and work handoff: `../project_progress.md` and `../latest_session_work.md`. Accepted owner decisions: `../decisions.md`; detailed dated evaluation outputs in `../../reports/`.

To locate an old event, search for an ID, module or date within these files; read only the matching heading and its local lines.
