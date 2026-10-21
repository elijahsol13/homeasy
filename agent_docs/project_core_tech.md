# Core Technology and Contracts

- **Backend:** TypeScript on Node.js; Fastify serves the Mini App REST API, and grammY handles Telegram bot updates. `src/container.ts` wires shared repositories and services.
- **Persistence:** Node's synchronous `node:sqlite` with SQLite WAL. Bot, scraper, and API processes use the same `DATABASE_PATH`; schema setup runs through `src/database/migrate.ts`.
- **Listings:** Parser and ingestion code lives in `src/modules/parser/`. The canonical read path was globally enabled in the reported 2026-10-16 deployment, even if code defaults or fixtures still allow legacy. Inspect the real read-path configuration when making runtime decisions (`src/modules/api/listing-read-path.ts`); preserve parity, moderation and rollback guarantees when changing it.
- **Mini App:** React, TypeScript, Vite, Tailwind CSS, and Telegram Web App SDK under `webapp/`. The client calls `/api/v1` through `webapp/src/services/api.ts`.
- **Scraping:** TypeScript owns scraper and extraction logic. Facebook uses patched Firefox through Camoufox, launched by `scripts/camoufox/serve.py` and controlled via Playwright, over the host's ordinary internet connection. Keep `attachTrafficGuard` resource filtering and host-specific Facebook device/session state.
- **AI and media:** Provider adapters/router are under `src/modules/ai/`; image hashing uses Sharp.

Useful checks: `npm run typecheck`, `npm test`, `npm run build`, `npm run build:webapp`, and `npm --prefix webapp run test`. The Mini App build also runs its TypeScript project build.
