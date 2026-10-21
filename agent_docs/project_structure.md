# Project Structure

- `src/index.ts`, `src/bot.ts`, `src/scraper.ts`, `src/api.ts`: application entry points. `src/index.ts` also supports combined bot/scraper local mode.
- `src/container.ts`: composition root for database repositories and application services.
- `src/config/`: validated environment settings, locations, landmarks, and amenities.
- `src/database/`: SQLite setup, migrations, and repositories for users, listings, favorites, analytics, and ingestion data.
- `src/modules/api/`: Fastify routes, authentication, DTOs, and listing read-path selection.
- `src/modules/bot/`: grammY bot handlers, commands, keyboards, and session state.
- `src/modules/parser/`: source adapters, scraping, extraction, normalization, ingestion, deduplication, and freshness work.
- `src/modules/ai/`: AI provider adapters, routing, batching, and quota handling.
- `src/modules/matcher/`, `src/services/`: subscription matching and shared application services.
- `webapp/src/`: React Mini App, feed and map components, filter UI, and API clients.
- `scripts/`: maintenance, replay, backfill, evaluation, and operational scripts; `scripts/camoufox/` contains the Python browser launcher.
- `tests/`: backend Jest tests; `webapp/src/**/*.test.ts(x)` contains Mini App Vitest tests.
- `agent_docs/`: concise project context plus workflow progress, diary, and latest-session records.
