import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { RawListing } from './schemas';
import { FBGroupTarget, parseFacebookPostText, extractStoriesFromGraphQL, extractPhotosFromStory } from './facebook.scraper';
import { cleanPhotoUrls } from './normalizer';

export interface FetchedFbPost {
    postUrl: string;
    text: string;
    photos: string[];
}

/**
 * Fetches and extracts the raw post text/photos for a permalink WITHOUT calling
 * the LLM. Split out from `fetchPostAnonymous` so callers (namely `scrapeFacebookGroup`)
 * can fetch a whole batch of posts first, then send them through
 * `extractListingsBatchWithLLM` together in a single micro-batched request instead
 * of one Gemini call per post.
 */
export async function fetchPostTextAnonymous(postUrl: string): Promise<FetchedFbPost | null> {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
    };

    let html = "";
    try {
        const res = await fetch(postUrl, { headers });
        html = await res.text();
    } catch (e: any) {
        console.warn(`[Worker] HTTP failed for ${postUrl}: ${e.message}`);
        return null;
    }

    // Check for login wall vs SSR content
    if (!html.includes('GroupsCometLoggedOutPermalinkQuery')) {
        // Not the expected SSR. Might be an error or pure login wall.
        dumpErrorHtml(postUrl, html, 'no_permalink_query');
        return null;
    }

    try {
        // Extract RelayPrefetchedStreamCache JSON
        const match = html.match(/"RelayPrefetchedStreamCache","next",\[\],\["adp_GroupsCometLoggedOutPermalinkQueryRelayPreloader_[^"]+",(\{.*?\})\]\]/);
        if (!match) {
            dumpErrorHtml(postUrl, html, 'no_relay_cache');
            return null;
        }

        const data = JSON.parse(match[1]);

        // Locate the post text in the nested GraphQL structure
        // Usually: data.group.group_feed.edges[0].node.comet_sections.message.story_body.text
        // We'll use a deep search for the text field to be robust against schema changes
        const postText = extractText(data);

        if (!postText) {
            dumpErrorHtml(postUrl, html, 'no_text_extracted');
            return null;
        }

        // Extract photo URLs from the Relay GraphQL story node(s)
        const stories = extractStoriesFromGraphQL(data);
        const extractedPhotos: string[] = [];
        for (const story of stories) {
          extractedPhotos.push(...extractPhotosFromStory(story));
        }
        const photos = cleanPhotoUrls(extractedPhotos);

        return { postUrl, text: postText, photos };
    } catch (e: any) {
        dumpErrorHtml(postUrl, html, 'parse_error');
        console.warn(`[Worker] Parse error on ${postUrl}: ${e.message}`);
        return null;
    }
}

/**
 * Single-post convenience wrapper (fetch + LLM extraction). Prefer batching via
 * `fetchPostTextAnonymous` + `extractListingsBatchWithLLM` when processing more
 * than one post, to conserve Gemini quota.
 */
export async function fetchPostAnonymous(postUrl: string, target: FBGroupTarget): Promise<RawListing | null> {
    const fetched = await fetchPostTextAnonymous(postUrl);
    if (!fetched) return null;
    return parseFacebookPostText(fetched.text, target, fetched.postUrl, fetched.photos);
}

function dumpErrorHtml(url: string, html: string, reason: string) {
    const dir = path.join(process.cwd(), 'data', 'fb_error_dumps');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 8);
    const file = path.join(dir, `error_${reason}_${hash}.html`);
    fs.writeFileSync(file, html);
    console.warn(`[Worker] Dumped unparseable HTML to ${file}`);
}

function extractText(obj: any): string | null {
    if (!obj) return null;
    let foundText: string | null = null;
    
    // recursive search for "message":{"text": "..."} or "story_body":{"text": "..."}
    const stack = [obj];
    while (stack.length > 0) {
        const curr = stack.pop();
        if (curr && typeof curr === 'object') {
            if (curr.message && curr.message.text && typeof curr.message.text === 'string') {
                return curr.message.text;
            }
            if (curr.story_body && curr.story_body.text && typeof curr.story_body.text === 'string') {
                return curr.story_body.text;
            }
            for (const key of Object.keys(curr)) {
                if (curr[key] && typeof curr[key] === 'object') {
                    stack.push(curr[key]);
                }
            }
        }
    }
    return foundText;
}
