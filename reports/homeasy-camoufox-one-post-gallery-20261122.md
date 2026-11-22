# One-post Facebook gallery probe — 2026-11-22

## Scope and identity

Owner authorized a narrowly scoped, authenticated Camoufox check of **one existing Facebook post** on the Mac with its pinned device identity and saved session. No group-feed traversal, scraping batches, AI processing, account interactions or session writes. SQLite was opened read-only.

- Local historical source item `4613`, `FACEBOOK_GROUP`, group `1305656936237141`, post `4273888149413990`.
- Original URL `https://www.facebook.com/groups/cheaprentsiemreap/posts/4273888149413990/`.
- Source was recorded on 2026-10-18. Its saved payload contains **five** media URLs, associated `media_assets` contain five records, none with stored content/perceptual hashes. This does not prove the listing remains published in the present-day VPS catalog.

## Measured results

1. First launch under the default macOS command sandbox failed before navigation: Camoufox 152.0.4-beta.30 exited with `SIGABRT`, recorded in the local crash report. The runtime lock was released. The same probe succeeded after the command received macOS execution escalation.
2. Camoufox navigated to the exact post URL, **HTTP 200**. Final path retained the requested post ID. Saved session cookies were accepted. No challenge/checkpoint was detected; the visible page title matched the saved listing text.
3. **Five distinct `scontent...fbcdn.net` image URLs** were present in the post DOM, each inside a `[role="article"]` container and linked through `/photo/`. This establishes a usable route to the **five currently visible photo URLs from this one original post** without group-feed scrolling. Non-photo static assets and emojis were excluded.
4. A bounded HTTP `Range: bytes=0-31` request to **one of these five current URLs** returned **206 Partial Content**, `image/jpeg`, and `Content-Range: bytes 0-31/116522`. The remaining four current URLs were not separately downloaded or verified.
5. **None of the five current CDN pathname identities matches the five saved October pathname identities**. Saved photo filenames begin with `853…`–`855…`; the live page filenames begin with `905…`–`911…`. Their one-to-one content identity is therefore **unverified**. The source post may have been edited or images re-encoded/replaced; this probe cannot distinguish those explanations. There are no historical local image bytes/hashes with which to verify replacements.
6. Nine intercepted GraphQL responses parsed as JSON, but existing `extractStoriesFromGraphQL()` recognized **zero** `Story` nodes for this single-post page. A generic scan saw 18 unrelated/unmatched image identities. The current group-feed GraphQL extraction therefore cannot yet be reused as a proven single-post-gallery extractor. The verified five photo URLs came from DOM article/image anchors.

## Verification boundaries

### Follow-up photo ID check, 2026-11-22

A second narrowly scoped probe inspected the five live article-image anchors and compared their `/photo/?fbid=` identifiers and CDN filename numeric fields against the five October saved CDN filename numeric fields. It used the same original post, the pinned Mac Camoufox identity, and read-only SQLite.

- After one HTTP 200 authenticated navigation, the initial DOM sample contained **zero** post photos. On a fresh navigation with a bounded wait for article `scontent` images, **five** appeared. Single-post DOM extraction therefore needs a render-ready condition and must distinguish an unloaded page from an empty gallery.
- The five `/photo/?fbid=` values were distinct, and each live image had a CDN filename. **None of the five live `fbid` values or live CDN filename second numeric components matched any of the five saved CDN filename second numeric components.** The `fbid` values also differed from the second numeric components of their respective *current* CDN filenames. A numeric component of a CDN filename must not be assumed to be a Facebook photo ID.
- The full visible set still comprised five photos; one current image returned **206/image/jpeg** for a 32-byte Range request. The existing group-feed GraphQL story extractor still recognized zero relevant stories. Both probes released `fb_runtime.lock` and exited without an observed challenge.
- **Historical photo identity and order remain unproven.** Equal image counts, present-day `fbid` anchors, and an apparently related post cannot justify mapping current images onto the five October slots. Historical image bytes/hashes or independently source-backed photo identity would be needed for that claim.

| Question | Result |
| --- | --- |
| Does an authenticated one-post visit work? | **PASS**, HTTP 200 and no challenge in this sample. |
| Can the present post expose multiple gallery URLs? | **PASS for this one post**, five DOM photos associated with the article. |
| Do those URLs correspond one-to-one to the previously stored media? | **UNPROVEN**, zero pathname matches and no saved content hashes. |
| Is a new signed CDN URL usable? | **PASS for one URL** with HTTP 206. Expiration duration and four other URLs are untested. |
| Is a catalog-wide durable media solution implemented? | **NO**. No storage, API, frontend or production data changes were made. |

## Implications and next dependency

A bounded same-post DOM extraction is technically promising, but it needs post-ID and article-scoped identity checks, stable `/photo/` identifiers if available, explicit ordering, partial-gallery handling, and regression tests before any renewal implementation. Never overwrite saved gallery positions merely because an observed set has equal length. Signed Facebook CDN URLs still expire. The original 2026-10-22 owner decision to defer S3/object storage remains in force. Decide the durability approach for serving images within the approved modernization order, then implement/test locally before seeking authorization for production catalog changes.

The session and device files retained their pre-probe 2026-10-05 modification times, and `fb_runtime.lock` was removed at exit. No safety-state file was produced. The three successful same-post navigations in this report are **not** evidence of recoverability for any other Facebook group or listing.
