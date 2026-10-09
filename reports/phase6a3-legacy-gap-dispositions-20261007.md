# Phase 6A.3 legacy-only coverage dispositions

The audit is against the read-only Phase 6A checkpoint. Facebook source URLs and post IDs were already present in legacy rows; no external fetch or AI call was needed.

| Legacy ID | Disposition | Evidence / outcome |
|---:|---|---|
| 165 | `INTENTIONALLY_EXCLUDED` | Title explicitly says Phnom Penh. It is excluded from Siem Reap rent coverage. |
| 158 | `BACKFILLED` in isolated preview | Local legacy text and stable Facebook post ID. Ingestion retained `FACEBOOK_GROUP`, created one source item/version, repost membership and current occurrence; 0 AI attempts. |
| 18 | `BACKFILLED` in isolated preview | Local bilingual post text and stable Facebook post ID. Same deterministic ingestion results; 0 AI attempts. |
| 3 | `BACKFILLED` in isolated preview | Local post includes Sala Kamreuk, Angkor High School, Old Market and Pub Street, plus stable post ID. This is sufficient local geography and identity evidence; 0 AI attempts. |
| 2 | `INSUFFICIENT_LOCAL_DATA` | Raw text says the owner relocated to Phnom Penh but does not identify the villa's location. Legacy location is empty; group scope alone is only a prior. No speculative canonical row was created. |

The isolated-copy run processed IDs 3, 18 and 158 through `IngestionService` with `MANUAL_IMPORT` / `MANUAL`, preserved their original Facebook source identities, created one version and one current occurrence per item, and reported zero errors, zero AI attempts and zero duplicate current bindings. A second run left source items, versions, occurrences and listing counts unchanged (`3 unchanged`, `0 new versions`). The source checkpoint's legacy `properties` remained at 390 rows with the original digest.

**Coverage acceptance: 0 unexplained legacy-only rows.** This is a preview report; the source checkpoint and production database were not updated. The deterministic local backfill remains ready for an explicitly controlled application after review.
