# Earlier Homeasy session checkpoints — 2026-10-20/21

Archived on 2026-10-21 from `latest_session_work.md`; historical statuses and permissions are not current instructions.

## 2026-10-21 — 4+ BR filter regression (canonical and legacy)

**Cause and fix:** `FilterDrawer` sends the existing numeric value `4` for `4+ BR` and API forwards CSV `bedrooms=2,4`; both SQLite repositories treated `4` as exact `IN (4)`. Updated only `src/database/repositories/properties.repo.ts` and `src/database/repositories/canonical-listing.repo.ts`: the value `4` now means `bedrooms >= 4`, combined via `OR` with exact selected bedroom counts. Canonical's existing inclusion of `l.bedrooms IS NULL` remains intact. Frontend/API contract, sorting and pagination logic unchanged.

**Regression evidence:** Tests added to `tests/properties-sorting.test.ts`, `tests/canonical-listing.repo.test.ts` and `webapp/src/services/api.test.ts`, using only isolated `:memory:` SQLite fixtures or mocked HTTP. Before SQL changes: focused backend run **5 failing / 22 passing** (5 failures demonstrate excluded 5/6 BR and mixed selection/combined filtering); frontend contract test **6/6 passing**. After SQL changes: focused backend **27/27 passing**, including 3/4/5/6 boundary, `[2,4]` union, exact 1/2/3, list/map, NULL preservation, combined filters, price sort and pagination.

**Verification:** `npm test -- --runInBand --silent`: **760 passed / 1 failed** across 76 suites; the unrelated existing `tests/canonical-shadow.test.ts` expects moderation policy `source-corroborated-crossposts-v11` but current `canonical-moderation-policy.ts` defines `v12`. Left untouched as outside this task. `npm --prefix webapp test`: **36/36 passed**. `npm run typecheck`, `npm run lint`, `npm --prefix webapp run build`, `git diff --check`: **PASS**. `npm --prefix webapp run lint`: exit 0, seven already-existing warnings in `App.tsx`/`MapView.tsx`, no new warnings for this change.

**Tools and boundaries:** Superpowers `using-superpowers`, `systematic-debugging`, `test-driven-development`, `verification-before-completion` consulted; Serena activated on `homeasy` in `no-memories` mode and used `initial_instructions`, `get_symbols_overview`, `find_symbol`, `find_referencing_symbols` for React → API → repositories. No live SQLite, scraper, paid provider, deploy, Git cleanup, commit or merge. Existing dirty worktree retained. **Next:** owner may review behavior in the running Mini App; separate stale moderation-policy assertion is outside this fix.

## 2026-10-21 — FilterDrawer sort regression (first Superpowers/Serena trial)

**Cause and change:** `webapp/src/components/FilterDrawer.tsx` keeps `useState(filters)` while the parent previously rendered the drawer even when `isOpen=false`. The draft therefore survived closing, external feed-sort changes, and cancelled edits. `webapp/src/App.tsx` now conditionally mounts `<FilterDrawer>` when opened; existing draft and Apply/Reset behavior are otherwise unchanged. `webapp/src/App.test.tsx` (pre-existing untracked file) now uses the real drawer plus a minimal Header trigger, with a regression case that failed before and passed after the change.

**Tools:** Superpowers `using-superpowers`, `systematic-debugging`, `test-driven-development`, `verification-before-completion` consulted. Serena `initial_instructions` confirmed active `homeasy` and `no-memories`; REPL used `find_symbol`, `get_symbols_overview`, `find_referencing_symbols`, `search_for_pattern`, `get_diagnostics_for_file` to inspect drawer, parent, FilterState and references.

**Verification:** red regression failed on stale selected sort; green focused regression PASS. `npm --prefix webapp test -- --environment jsdom` **5 files / 35 tests PASS**; `npm --prefix webapp run build` PASS (`tsc -b` and Vite); `npm run typecheck` PASS; `npm --prefix webapp run lint` exits 0 with seven existing `App`/`MapView` warnings and none introduced; scoped `git diff --check` PASS. No backend, DB, scraper, infrastructure, Git cleanup, commit, network scrape or deployment was performed.

**Remaining:** Owner to check drawer interactions in a browser/Telegram Mini App; no hands-on visual device test or production deployment. Raw filter-location grouping is a distinct future topic; do not start it from this handoff.

## 2026-10-21 — Superpowers + Serena integration

**Scope completed:** Installed Superpowers 7.0.0 with `codex plugin marketplace add obra/superpowers --ref main` and `codex plugin add superpowers@superpowers-dev`; verified plugin installed/enabled and skills present. Installed Serena 2.1.0 with `uv tool install -p 3.13 serena-agent` (Python 3.13.13), ran `serena init`, and registered the global Codex MCP via `codex mcp add serena` using `/Users/lacr0s/.local/bin/serena start-mcp-server --context=codex --project-from-cwd --open-web-dashboard=false` and a 45s startup timeout. Existing `node_repl` MCP and other Codex settings were retained. Config backup: `/private/tmp/homeasy-codex-config-before-superpowers-serena-20261021.toml` (temporary machine-local copy).

**Project setup:** `.serena/project.yml` enables TypeScript/Python LSP, excludes generated/runtime data, and activates `no-memories` with a brief pointer to canonical project docs. `.gitignore` ignores Serena caches/memories/logs, while project config remains available for future Git review. `AGENTS.md` and `harness_protocol.md` describe use, authority and activation in Codex Desktop.

**Verification:** `serena project health-check` PASS; TypeScript and Python language servers started. Direct MCP stdio test using the exact Codex command PASS: `initial_instructions` reported Homeasy active and `no-memories`; `serena_repl` found **1 definition and 11 references** for `attachTrafficGuard` in `src/modules/parser/traffic-guard.ts`. `codex mcp get serena --json` reports enabled and timeout 45s. Superpowers 7.0.0 appears installed/enabled in `codex plugin list`. No product code changes, live data access, scraping, paid providers, deployment or Git cleanup. A newly started Codex chat must still confirm actual plugin/MCP tool discovery in the desktop UI; tool registry in the already running chat predates installation.

**Next:** start a fresh Codex chat in Homeasy, confirm Superpowers and Serena availability (activate `homeasy` explicitly if absent), then do the next small task chosen by the owner. Existing `agent_docs/` and `.serena/` remain untracked until the separate Git cleanup decision.

## 2026-10-21 — durable context cleanup (documentation only)

**Owner request:** make Homeasy's memory usable across large Codex sessions; prepare for later Superpowers + Serena integration and a small trial task. Owner will decide Git cleanup and review product behavior later.

**Scope:** preserved original progress/session documents as byte-identical archives under `agent_docs/history/`; replaced working versions with compact current status and handoff; added a short intake map; updated read order and clarified source-of-truth boundaries. Product code and data were not intentionally changed by this documentation pass.

**Known limitation:** existing product counts and operational state are from reports dated **2026-10-20**, not freshly read from the live database. The outstanding frontend filter/sort issue is an investigation only, not an implementation.

**Verification:** original archives pass SHA-256 checks listed in `history/README.md`. The two mandatory living logs went from **341,491 bytes to approximately 9.5 KB (over 97% less)**. Markdown path resolution and whitespace checks PASS after accounting for repository-root-relative references; initial parent-only path checking produced false positives. `git diff --check` for tracked documentation PASS. No application tests run (documentation-only scope); no scraper, provider, production SQLite operation, Docker service, deployment, commit, reset or Git cleanup was executed.

**Next at that checkpoint:** configure/install Superpowers and Serena. This is now done as documented above. `agent_docs/` remains untracked; Git cleanup/commit stays owner-directed.

## Previous checkpoint — 2026-10-20

- v12 policy was deployed to API/scraper; ID100 source-confirmed and approved. Reported active state: **232 canonical, 36 legacy, 1,144 source items; 181 approved / 44 Pending / 7 rejected**; **0** additional source-verified auto-approvals in remaining Pending.
- 48 Pending originals re-extracted; four historically contaminated repost clusters and other stale room facts repaired. ID373 still held for conflicting lease prices. No fabricated exact coordinates for source Maps/place links.
- Focused last reported v12 verification: **6 suites / 120 tests PASS**, plus typecheck, lint, build and diff-check. These checks were **not** rerun by the memory cleanup.
- Latest frontend source inspection found ungrouped raw location choices and stale FilterDrawer sort draft; **no fixes or tests**. Archived first section of the prior work log contains details.
- Full restore/image tags, SQLite checkpoint hashes, script outcomes, and older reports remain in `history/session_work_through_2026-10-20.md`; do not summarize their conclusions as new live checks.
