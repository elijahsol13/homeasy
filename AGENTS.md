# 🤖 Project Rules & Inviolable Principles for AI Agents & Developers

## Project harness: durable context and safe entry

- **OWNER DIRECTIVE — no self-invented work (2026-10-15):** Follow the agreed sequence in `agent_docs/project_progress.md` and `agent_docs/decisions.md`. Do not turn an incidental concern, test idea, or optional risk mitigation into a new prerequisite, architecture project, or multi-hour detour. If the goal, necessity, priority, underlying assumption, cost, or scope is materially unclear, **ask the owner a targeted question before starting that branch of work**. Explain the concrete reason and impact first. Do not interpret "continue" as approval for an unrelated workstream. Routine implementation/testing within a clearly approved workstream can proceed autonomously.
- **Owner-approved network architecture (2026-10-15):** Scrapers use the ordinary residential internet connection of the host (currently MacBook/Docker; planned home server behind CGNAT). Remove obsolete paid/residential proxy integrations and experimental Khmer24 egress brokers, Linux network namespaces, firewall quotas and physical-byte caps. Do not restart that work without a specific owner request. Cloudflare Tunnel/reverse proxy for incoming API traffic is a separate existing component.
- Before nontrivial work, follow the short entry map at `agent_docs/current_context.md`; read `agent_docs/project_progress.md`, `agent_docs/decisions.md` and `agent_docs/latest_session_work.md`. Read architecture, roadmap and history only as relevant to the current task. Follow `agent_docs/harness_protocol.md` for intake, verification and handoff. Do not bulk-load historical logs.
- `AGENTS.md` owns standing engineering/safety invariants; `agent_docs/decisions.md` records accepted choices; `agent_docs/project_progress.md` owns current gates and next priorities. Do not create competing copies of these facts in ad-hoc agent memory.
- **Codex tooling (2026-10-21):** Superpowers supplies optional task-appropriate planning, debugging, testing and review skills; Serena MCP supplies semantic TypeScript/Python navigation. In Codex Desktop, ensure Serena has activated **this** Homeasy project before symbol queries (activate it explicitly if needed). Serena runs with `no-memories`; do not create separate Serena/project-plan sources of truth. Apply skills within the owner's approved task and the existing harness; never let a skill create a new prerequisite, unauthorized branch/worktree, or unrelated workstream.
- Preserve the dirty working tree and real `data/` files. Before a database operation, establish whether its path is live; use isolated temporary fixtures for tests. Never reset live listing inventory or execute live scrapers/paid LLMs without explicit task authorization.
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
