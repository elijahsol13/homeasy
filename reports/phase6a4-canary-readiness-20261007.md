# Phase 6A.4 — canonical canary readiness

Date: 2026-10-07

## Checkpoint

The consistent SQLite checkpoint was created before the canary work at `data/backups/homeasy_phase6a4_precanary_20261007.db`.

- SHA-256: `2346eb463d34c43609f5a99b82604d532bdd7136d38bd3f5eb87073201cb10d5`
- `integrity_check`: `ok`
- foreign-key violations: `0`
- legacy properties: `390`
- legacy digest: `59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272`
- source items / versions: `1257 / 1939`
- canonical properties / listings: `465 / 465`
- current occurrences: `733`
- public refs: `465 / 465` unique and well formed
- duplicate aliases / dangling aliases / duplicate current bindings: `0 / 0 / 0`

The final read-only integrity check after the moderation corrections also passed. Legacy count and digest still match the baseline.

## Canary implementation

`CANONICAL_READ_CANARY_TELEGRAM_IDS` is parsed as a validated comma-separated list. The global `LISTING_READ_PATH` remains `legacy` by default. For a user in the allowlist, list/search, map, filter metadata, detail, favorites, and tracking resolution use canonical data. Public opaque refs are unavailable to non-canary users while their read path is legacy. Legacy numeric detail URLs resolve only through the `legacy_property_id` alias namespace.

Canary list and map requests serve canonical results and log a legacy shadow comparison: criteria, counts, overlap, top canonical refs, latency, and shadow errors. Detail, favorite, and tracking resolution events record successful and failed resolutions. Removing a user from the allowlist returns that user's reads to legacy; the rollback test confirms this without any database rollback.

The Mini App detail modal now sends `publicRef` for canonical favorites, matching the card and map behavior. A canary user cannot use admin privileges to view pending or rejected listings through public list/detail/favorite/tracking paths.

## Ranking review and data corrections

The first 20 results were reviewed for broad Siem Reap, apartment, house, 1BR, 2BR, up to $300, $300–500, Wat Bo, Sala Kamreuk, and Svay Dangkum. Detailed rows and query timings are in `phase6a4-ranking-audit-20261007.json`.

Five isolated data issues were corrected through explicit listing moderation, without changing moderation policy:

- Listing 54: office/retail/land source text conflicted with the extracted room and bedroom fields — moved to pending.
- Listing 136: one post offered multiple unit types and prices that did not match the single extracted price/bedroom pair — moved to pending.
- Listing 196: title, sangkat, and explicit location conflicted — moved to pending.
- Listing 240: source text says Sla Kram while the canonical explicit location says Wat Bo — moved to pending.
- Listing 252: source was a hotel room advertised at `$11/night`, not a monthly rental — rejected from the monthly rental catalog.

After those corrections, the broad visible set is `169`. The reviewed top-20 sets contain no duplicate public refs, explicit out-of-area entries, or sale-only listings. Each broad/category/bedroom/budget top-20 set ranks exact city and exact rent first. Wat Bo returns 8 rows: exact rent ranks first, followed by probable rent; the last two are probable city. Unknown prices are absent from the reviewed budget top-20 lists. One house and one location-filter result have unknown bedrooms, which is represented as unknown rather than a false bedroom count.

## Verification

- Full Jest: 47 suites, 407 tests passed.
- TypeScript typecheck: passed.
- Mini App production build: passed; existing large-chunk advisory remains.
- `git diff --check`: passed.
- Production database integrity and foreign-key checks: passed.
- Legacy properties digest: unchanged.
- Per-user API smoke: canonical-only fixture appears in canary list, map, detail, and favorites; non-canary remains on legacy; pending listing is hidden from list/map and returns 404 for detail, favorite, and tracking resolution.
- Numeric alias namespace collision regression: covered by the existing identity repository tests.

The first complete Jest run attempted its configured PostHog flush, but DNS resolution failed before delivery. The final full run used an empty PostHog key and completed without a network flush.

## Activation state

Live canary is enabled for Telegram user ID `8441221953`. `LISTING_READ_PATH` remains `legacy`; the allowlist contains exactly this one ID. Removing it was smoke-tested: the signed request returned the legacy response (`69` total, no `publicRef`). Re-adding it restored canonical serving (`169` total, opaque `publicRef` present), and the API emitted `canonical_canary_shadow` with legacy/canonical counts and query latencies.

The API and bot containers are running the current build. The bot was rebuilt on the lightweight Node runtime (without scraper/browser dependencies) after its older process logged an analytics SQLite error while handling an update. It now reports polling mode active and `@Homeasy_kh_bot` running. The Mini App production build was deployed at `https://726a68bf.homeasy-app.pages.dev`; the public app loads and renders listing cards, and API-level signed smoke covered list, detail, map, filters, favorites, legacy numeric detail alias, and moderation visibility. The user's Telegram session still needs one fresh `/start` and Mini App open after this restart to confirm the end-to-end interaction.

The live legacy `properties` table remains at 390 rows with baseline digest `59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272`; `integrity_check` is `ok` and `foreign_key_check` returns no rows. The running Docker set contains API, bot, and tunnel; there is no scraper container. No scraping, Bright Data, Camoufox, AI enrichment, or paid freshness request was made. Do not broaden the cohort or switch the global path without a separate decision.
