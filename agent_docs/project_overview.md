# Project Overview

HomeEasy aggregates residential listings for Siem Reap and Phnom Penh, Cambodia. It provides a Telegram bot and Telegram Mini App for browsing listings, searching, favorites, and alerts.

Facebook and Khmer24 source adapters feed the TypeScript parser and ingestion services. Listings are stored in a shared SQLite database and served through the Fastify API to the React Mini App; the bot uses the same application services for search and notifications. Docker Compose runs separate bot, scraper, and API services, with a Cloudflare tunnel exposing the API.

The target product adds a public Web App alongside the Telegram Mini App on the shared frontend/backend. The canonical read path was activated globally on 2026-10-16 according to the documented deployment; it should be rechecked against live runtime before any operational decision. See `decisions.md` for approved constraints and `project_progress.md` for current gates.

For agent intake start with `current_context.md` and `harness_protocol.md`. `project_progress.md` owns active milestones, `decisions.md` accepted choices, `latest_session_work.md` the latest bounded handoff, `history/` full prior checkpoints and `project_diary.md` historical lessons. The longer product hypothesis belongs in `HOMEASY_ROADMAP.md`.
