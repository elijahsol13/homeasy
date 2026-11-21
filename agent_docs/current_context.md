# Homeasy — agent entry map

Updated 2026-11-21. This file is a **navigation guide**, not a second state log.

## What this repository is

Cambodian rental listings product with Telegram bot, React Mini App, a public Web App direction, Fastify API, SQLite and Facebook/Khmer24 ingestion. Current API/bot/SQLite host is the VPS (`/home/ubuntu/homeasy`, Docker Compose); Facebook/Camoufox stays on the Mac residential IP. Manual Bright Data collection via the VPS Telegram bot and a dedicated worker was deployed 2026-11-09; the owner-authorized 1,000-post-cap / 16-group / two-week one-off **completed AI recovery and canonical ingest on 2026-11-10**, with API visibility and recovered Telegram job status verified against production. Manual Khmer24 **Mac → VPS** ingest was deployed and the owner-authorized **14-day one-off** completed on 2026-11-10 (**69 collected, +64 source items, +56 canonical, +43 publicly visible**); operator commands: `deploy/vps/KHMER24_MAC_RUN_RU.md`. See `project_progress.md` and `latest_session_work.md` for counts and remaining moderation; bot's regular Bright Data `all` mode still defaults to 30 days. Current gates: `project_progress.md`; source map: `project_structure.md`; technical contracts: `project_core_tech.md`.

## Read path — short by default

1. Read root `AGENTS.md` for permanent safety and scope rules.
2. Read `project_progress.md` for **current agreed priority** and last verified facts.
3. Read `decisions.md` for owner-approved policy, permissions and constraints relevant to your task.
4. Read `latest_session_work.md` for most recent handoff and exact next step.
5. Inspect implementation/tests in the **specific affected module**. Read `project_overview.md`, `project_structure.md`, `project_core_tech.md`, `HOMEASY_ROADMAP.md` or operational runbooks only when relevant.

For a cross-system architecture and release map, read [`../reports/homeasy-full-audit-20261121.md`](../reports/homeasy-full-audit-20261121.md) after the concise intake. It distinguishes local code, last documented VPS checkpoint, and current browser observations. It is a dated audit, not a replacement for decisions or current gates.

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
