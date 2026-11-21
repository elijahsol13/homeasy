# Homeasy — active handoff (2026-11-21)

## Goal and current result

Owner chose step 1 of [the full audit](../reports/homeasy-full-audit-20261121.md): release baseline and a clean two-branch Git policy. The verified inventory, checks and completion procedure are in [the baseline report](../reports/homeasy-release-baseline-20261121.md). Chosen mapping: `main` production, `develop` development. This is **prepared but not committed/published**. The audit handoff was archived byte-for-byte under `history/session_work_2026-11-21_before_release_baseline.md`.

## Evidence and impact

- GitHub branches: `main` `7ad0ec7`, `codex/vps-migration-ready` `9d57576` (+9 unique), `feature/telegram-mini-app` `23c6bd2` (merged ancestor). Local checkout on main: 58 modified tracked and 796 untracked paths before this report and doc updates; `data/` ignored and untracked in Git. Three detached Codex worktrees exist; two contain 4 and 7 paths of distinct frontend changes, respectively. No Git operation modified refs or index.
- Fresh checks: `npm test -- --runInBand --silent` **99/99 suites, 1092/1092** (existing open async handle warning); frontend Vitest **14/14, 185/185**; root typecheck/lint/build, `npx tsc -p tsconfig.brightdata.json`, Web/TMA builds, frontend lint exit 0 (8 warnings), and `git diff --check` pass. Compiled `dist/modules/parser/canonical-dedupe.js` contains the scoped moderation v13 call.
- `git fetch origin --prune` failed immediately: `cannot open '.git/FETCH_HEAD': Operation not permitted`; `git ls-remote origin` cannot resolve github.com from shell, while the GitHub connector works with admin/push permission. The configured `ovh` SSH alias points to the production VPS `/home/ubuntu/homeasy`, but SSH is blocked by `Operation not permitted` on port 22 before authentication; this is not evidence of a VPS outage. Local Docker daemon/socket absent; image can instead be built and checked on VPS once SSH access is available. No live SQLite, scraper, paid provider, container or production operation. No remote branch deletion/push; no unstaged work discarded.

## Access recheck in the follow-up (2026-11-21)

- Default sandbox calls still fail with `Operation not permitted` for `.git/FETCH_HEAD` and outbound SSH port 22, and DNS fails for `github.com`.
- The native Codex command tool with `sandbox_permissions=require_escalated` succeeded in a reversible `.git` write/delete probe (`LOCAL_GIT_WRITE_OK`), and `git ls-remote --heads origin` returned all three remote branches. No refs or index were changed.
- `ssh ovh` with the same escalation successfully authenticated as `ubuntu` to `vps-184e5427`, found `/home/ubuntu/homeasy/.git`, and read the VPS checkout at `07bf9eb` on `codex/vps-migration-ready` with 20 status entries. Remote `codex/vps-migration-ready` head is still `9d57576`; investigate this divergence before any integration or deployment.
- Read-only `docker ps` on VPS succeeded. `homeasy-bot`, `homeasy-api`, `homeasy-brightdata-worker`, `homeasy-tunnel`, and `homeasy-backup` were running, with the backup container reporting healthy. This only verifies current access and process status, not application correctness or code parity.
- Escalation is session/approval-dependent and must be requested on later attempts as needed. The two-branch cleanup has not started.

## Resume exactly here

Use the native command tool's `require_escalated` path for `.git`, Git remote and SSH as needed. Follow the report's explicit source selection and branch integration, first reconciling VPS checkout `07bf9eb` against remote `9d57576`, independent Codex worktree changes and current Pages branch bindings before pruning refs. Re-run checks on the actual staged tree, check the private-file hook and build the image from the resulting commit on VPS or another suitable builder. Keep `main` at the known production source until a controlled release; the following product step is read-only 264→219 cohort/photo analysis.
