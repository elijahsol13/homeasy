# Homeasy — agent entry map

Updated 2026-10-21. This file is a **navigation guide**, not a second state log.

## What this repository is

Cambodian rental listings product with Telegram bot, React Mini App, a public Web App direction, Fastify API, SQLite and Facebook/Khmer24 ingestion. Current host is MacBook/Docker Compose. Source map: `project_structure.md`; technical contracts: `project_core_tech.md`.

## Read path — short by default

1. Read root `AGENTS.md` for permanent safety and scope rules.
2. Read `project_progress.md` for **current agreed priority** and last verified facts.
3. Read `decisions.md` for owner-approved policy, permissions and constraints relevant to your task.
4. Read `latest_session_work.md` for most recent handoff and exact next step.
5. Inspect implementation/tests in the **specific affected module**. Read `project_overview.md`, `project_structure.md`, `project_core_tech.md`, `HOMEASY_ROADMAP.md` or operational runbooks only when relevant.

Historical forensics: `history/README.md` then the exact archived section or dated report. **Never bulk-read history or the roadmap merely to begin a task.** Old text saying `latest` or `current` is historical evidence, not current authorization.

## Sources of truth

| Question | Read/write here |
| --- | --- |
| What task is currently approved; last verified state; next gates? | `project_progress.md` |
| What did the owner decide and authorize? | `decisions.md` |
| What happened during this session, evidence and handoff? | `latest_session_work.md` |
| Engineering/safety invariants? | root `AGENTS.md` |
| How to execute/review/checkpoint? | `harness_protocol.md` |
| Product aspirations? | `../HOMEASY_ROADMAP.md` |
| How did we get here? | `history/`, `project_diary.md`, dated `../reports/` |

**Avoid competing memories.** Any future Superpowers plan, Codex memory or Serena note should link to these canonical docs, not duplicate accepted policy, production statistics or task status.

## Guard against context drift

Read targeted files and bounded excerpts. If source contradicts docs, verify facts from the implementation or runtime (when authorized), then correct the owning document. Don't infer production state from a git diff or from yesterday's test. Never start a new workstream just because a report mentioned a risk.
