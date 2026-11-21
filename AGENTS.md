# 🤖 Project Rules & Inviolable Principles for AI Agents & Developers

## Project harness: durable context and safe entry

- **OWNER DIRECTIVE — no self-invented work (2026-10-15):** Follow the agreed sequence in `agent_docs/project_progress.md` and `agent_docs/decisions.md`. Do not turn an incidental concern, test idea, or optional risk mitigation into a new prerequisite, architecture project, or multi-hour detour. If the goal, necessity, priority, underlying assumption, cost, or scope is materially unclear, **ask the owner a targeted question before starting that branch of work**. Explain the concrete reason and impact first. Do not interpret "continue" as approval for an unrelated workstream. Routine implementation/testing within a clearly approved workstream can proceed autonomously.
- **Owner-approved network architecture (updated 2026-10-24):** Facebook/Camoufox must stay on the Mac's residential IP, with pinned macOS identity and its local session; never launch Facebook automation on the Singapore VPS. The VPS is the planned host for Khmer24 (datacenter egress **unverified**), API, bot, SQLite, backups and tunnel; Facebook sends batches to the VPS via authenticated API. No residential proxies or old egress brokers/network namespaces/firewall traffic caps. Cloudflare Tunnel/reverse proxy for incoming API traffic remains a separate existing component.
- Before nontrivial work, follow the short entry map at `agent_docs/current_context.md`; read `agent_docs/project_progress.md`, `agent_docs/decisions.md` and `agent_docs/latest_session_work.md`. Read architecture, roadmap and history only as relevant to the current task. Follow `agent_docs/harness_protocol.md` for intake, verification and handoff. Do not bulk-load historical logs.
- `AGENTS.md` owns standing engineering/safety invariants; `agent_docs/decisions.md` records accepted choices; `agent_docs/project_progress.md` owns current gates and next priorities. Do not create competing copies of these facts in ad-hoc agent memory.
- **OWNER DIRECTIVE — actually use Superpowers and Serena (2026-10-22):** At the start of **every Homeasy turn, including technical questions and discussion**, check which Superpowers skills apply and invoke the relevant ones according to their instructions; for ordinary questions this may only be the basic `using-superpowers` check. For actual design, coding, debugging, tests and review, use task-appropriate skills, scaled to the requested work. Serena MCP is the preferred **semantic TypeScript/Python code-navigation tool** when investigating symbols/references: ensure it has activated **this** Homeasy project before symbol queries. **If Serena is absent from the initial tool list, first use deferred `tool_search` / tool discovery for `mcp__serena__initial_instructions` and `mcp__serena__serena_repl` and attempt a real symbol lookup before reporting it unavailable.** If discovery or the call actually fails, report the specific failure and use ordinary source inspection. Never claim a skill/tool was used without a real invocation. Skills never authorize extra work, worktrees, deployments or paid operations beyond the owner's agreed scope.
- **OWNER DIRECTIVE — capture context from ordinary conversations too (2026-10-23):** Before finishing **every Homeasy turn**, review the owner's questions, corrections, examples, ideas, rejected alternatives and comments, including exploratory discussion. Use **native Serena project memories** for useful discussion context that may matter later; distinguish proposed, rejected, undecided and approved ideas. Persist explicit accepted decisions in `agent_docs/decisions.md`, verified state and next gates in `agent_docs/project_progress.md`, and execution evidence/handoff in `agent_docs/latest_session_work.md` when relevant. Serena memories may reference those authoritative records but must not duplicate or override them. Do not treat selective Codex Memories or chat compaction as guarantees that every detail was stored; never claim a memory write without checking it. Do not generate redundant entries for turns with no new information.
- Preserve the dirty working tree and real `data/` files. Before a database operation, establish whether its path is live; use isolated temporary fixtures for tests. Never reset live listing inventory or execute live scrapers/paid LLMs without explicit task authorization.
- Never stage database files, SQLite WAL/SHM/journals, backups, or private runtime files from `data/`. The repository provides `.gitignore` rules and `.githooks/pre-commit` with `scripts/check-staged-private-files.cjs` to reject forced-staged private files. In every new clone, enable the hook with `git config --local core.hooksPath .githooks`. Do not bypass this hook for normal commits. Existing remote history/PR refs require separate remediation.
- Record evidence, remaining risks and the next step in the **short** `agent_docs/latest_session_work.md` after meaningful work; move older handoffs to `agent_docs/history/` with an index before they accumulate. `project_progress.md` owns current state, `decisions.md` owner decisions. External tools may assist execution, but must not create competing sources of authority.

## 🛡️ Scraper resource filtering

- Attach `attachTrafficGuard(page)` from `src/modules/parser/traffic-guard.ts` before browser navigation where used by the existing scraper. Keep the existing response/API interception and extraction logic.
- Extract image URLs as strings from JSON/HTML, avoiding unnecessary binary image, media and font downloads in headless workers. Keep visual assets/stylesheets available when required for attended login.
- Preserve existing blocking of nonessential telemetry and tracking beacons, and direct HTTP/JSON extraction when it works for the source.
- Never spoof mobile Facebook user agents: the pinned Camoufox identity supports desktop fingerprints only.

---

## 🦊 Camoufox engine — Facebook scraping runs on patched Firefox, not Chromium

**Architecture:** the TypeScript pipeline owns ALL logic (traffic guard, GraphQL
interception, LLM batching, dedup, ingest). The browser is Camoufox — a patched
Firefox — spawned as a Playwright websocket server by
`scripts/camoufox/serve.py` and driven from Node via `firefox.connect()`
(`src/modules/parser/camoufox-server.ts`). Both sides speak Playwright 1.62.
Do NOT write a second scraper/extractor in Python or elsewhere: one
implementation of each rule, always.

### Setup

```bash
python3 -m venv .venv-camoufox
.venv-camoufox/bin/pip install -r scripts/camoufox/requirements.txt
.venv-camoufox/bin/camoufox fetch          # patched Firefox + uBO
```

### Run

```bash
# One-time visual login: a headed Camoufox window opens, YOU type the
# password/2FA, the script only waits for the c_user cookie and saves
# storage_state to data/fb_session.json.
npm run fb:login                  # direct connection through the local host

# One-group smoke cycle, then the normal headless cycle
npm run scrape:fb:smoke -- --group=0
npm run scrape:fb
```

### Hard-won constraints (verified on this machine, do not "simplify" away)

1. **Device identity is pinned — never rotate it.** Camoufox re-rolls
   canvas/audio/font noise seeds and picks a fresh fingerprint on EVERY launch
   (daijro/camoufox#442): same cookies + new hardware fingerprint reads as
   session hijacking. `serve.py` pins a real in-the-wild fingerprint preset +
   the three noise seeds in `data/fb_device.json` (generated once per account,
   never committed). Do not pass `userAgent`/`viewport`/`locale` overrides on
   the client context — they desync navigator.* from spoofed WebGL/screen.
2. **No persistent context over the websocket** (daijro/camoufox#253 —
   Playwright limitation). Sessions are carried by `storageState`
   (`data/fb_session.json`), saved back at the end of every run. Cold HTTP
   cache each run is the accepted cost; `enable_cache` is on within a run.
3. **`humanize=True` stays OFF** — on macOS beta.30 the first humanized
   trajectory departs from the tracked pointer (0,0), can emit a point on
   x==0/y==0, and wedges the process-global input chain (daijro/camoufox#751).
   Measured: 10/10 cold-start hangs to a near-corner target, 1/10 even to a
   distant interior one. The scraper scrolls via JS `scrollBy` (no input
   dispatch) and only makes rare interior `mouse.move` hops — safe.
4. **Never spoof a mobile UA / `m.facebook.com`.** Camoufox removed mobile OS
   fingerprints — only `windows`/`macos`/`linux` exist. A mobile UA over a
   desktop fingerprint is a guaranteed mismatch.
5. **`os` is pinned in `data/fb_device.json`** (macOS today). If this project
   moves to a Linux mini-PC, regenerate the device file (`--os linux`) instead
   of keeping a macOS fingerprint on a Linux host.
6. **`page.evaluate` runs in an isolated world since beta.29** — page-script
   globals are invisible without `main_world_eval=True` + the `mw:` prefix.
   DOM state (`window.scrollY`) is shared and unaffected.
7. **Authentication is never automated.** `fb:login` waits for a human;
   credentials never enter code, terminal input, or files.
8. **camoufox-js (npm) is deliberately NOT used** — it pins playwright-core
   <1.61 and fetches its own browser builds. `serve.py` launches the venv
   install so browser + protocol versions have a single source of truth.
9. **Facebook automation is fail-closed.** `data/fb_runtime.lock` prevents concurrent login/scrape processes. A detected challenge writes `data/fb_safety_state.json`; only a successful attended `npm run fb:login` may clear it.
10. **One account stays on one host identity.** Never copy a macOS `fb_device.json` to Linux. A host migration requires a new OS-correct device file and an attended login before scraping resumes.
