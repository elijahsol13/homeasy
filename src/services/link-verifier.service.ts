import type { PropertiesRepository, Property } from '../database/repositories/properties.repo';
import type { AlertService } from './alert.service';
import type { IngestionService } from '../modules/parser/ingestor';
import { fetchPostTextAnonymous, parseFormattedPrice } from '../modules/parser/fb-worker';
import { safeKhmer24Url } from '../modules/parser/canonical-freshness-executor';
import { classifyKhmer24DetailLiveness } from '../modules/parser/khmer24-liveness';

export interface LinkCheckResult {
  outcome: 'ALIVE' | 'DEAD' | 'UNKNOWN';
  statusCode?: number;
  reason?: string;
  normalizedUrl?: string;
  /** Body bytes consumed by a bounded canonical probe; excludes wire/header overhead. */
  bytesRead?: number;
}

interface ScrapedSnapshot {
  /** Normalized whitespace-collapsed post text for diffing against raw_text. */
  text?: string;
  /** USD cents when a fresh price could be read from the source page. */
  priceCents?: number;
  /** Khmer24 JSON-LD extras used to rebuild the ingest payload on re-parse. */
  photos?: string[];
  phone?: string;
  location?: string;
}

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Canonical freshness checks read text only. A large page is inconclusive, never proof of availability.
const CANONICAL_KHMER24_BODY_LIMIT = 256 * 1024;

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Cheap "did the ad change?" signal: compares whitespace-normalized text
 * lengths + shared-token overlap. Deliberately fuzzy — we only need to know
 * whether a full re-parse is warranted, not the exact diff.
 */
function textChanged(oldText: string, newText: string): boolean {
  const a = collapseWs(oldText);
  const b = collapseWs(newText);
  if (!a || !b) return Boolean(b) && a !== b;
  if (a === b) return false;
  const lenRatio = Math.abs(a.length - b.length) / Math.max(a.length, 1);
  if (lenRatio > 0.2) return true;
  const tokA = new Set(a.toLowerCase().split(' '));
  const tokB = new Set(b.toLowerCase().split(' '));
  let shared = 0;
  for (const t of tokA) if (tokB.has(t)) shared++;
  const jaccard = shared / Math.max(tokA.size, 1);
  return jaccard < 0.8;
}

export class LinkVerifierService {
  private ingestionService?: IngestionService;

  constructor(
    private readonly propertiesRepo: PropertiesRepository,
    private readonly alertService?: AlertService,
  ) {}

  /** Wired post-construction to avoid a circular container dependency. */
  setIngestionService(svc: IngestionService): void {
    this.ingestionService = svc;
  }

  /**
   * Performs an HTTP health check on a listing URL.
   * Detects 404, 410, and known "content removed" markers.
   */
  async checkUrl(rawUrl: string): Promise<LinkCheckResult> {
    if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))) {
      return { outcome: 'UNKNOWN', reason: 'Invalid or missing URL scheme' };
    }

    // Normalize web.facebook.com to www.facebook.com
    let targetUrl = rawUrl;
    let normalizedUrl: string | undefined;
    if (targetUrl.includes('web.facebook.com')) {
      targetUrl = targetUrl.replace('web.facebook.com', 'www.facebook.com');
      normalizedUrl = targetUrl;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);
    try {

      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': FETCH_HEADERS['User-Agent'],
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: controller.signal,
      });

      // Anonymous Facebook errors can mean access restrictions, not deletion.
      if (res.status === 404 || res.status === 410) {
        return { outcome: /(?:facebook\.com|fb\.com)/i.test(new URL(targetUrl).hostname) ? 'UNKNOWN' : 'DEAD',
          statusCode: res.status, reason: `HTTP ${res.status}`, normalizedUrl };
      }

      // Check text body for dead post signatures
      if (res.ok) {
        const textSample = (await res.text()).slice(0, 15000);

        if (
          textSample.includes("This content isn't available right now") ||
          textSample.includes('The link you followed may be broken') ||
          textSample.includes('The link you followed may have expired') ||
          textSample.includes('Page Not Found') ||
          textSample.includes('Facebook is not available on this browser')
        ) {
          return {
            outcome: 'UNKNOWN',
            statusCode: res.status,
            reason: 'Content removed, expired, or unavailable',
            normalizedUrl,
          };
        }
      }

      return { outcome: res.ok ? 'ALIVE' : 'UNKNOWN', statusCode: res.status, normalizedUrl };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('timeout')) {
        // Timeouts or transient network issues do not mark a listing dead
        return { outcome: 'UNKNOWN', reason: 'Network timeout (transient)' };
      }
      return { outcome: 'UNKNOWN', reason: `Network check error: ${msg}` };
    } finally {
      // Keep the timeout active through response.text(), which may also stall.
      clearTimeout(timeoutId);
    }
  }

  /**
   * Lightweight Khmer24 re-check: a single HTML fetch, JSON-LD parsed with
   * regex (no browser needed). Cloudflare challenges are treated as "alive —
   * can't verify", never as dead.
   */
  private async checkKhmer24(url: string, strictRedirect = false): Promise<{ outcome: LinkCheckResult['outcome']; snap?: ScrapedSnapshot; reason?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS, redirect: strictRedirect ? 'manual' : 'follow', signal: controller.signal });
      if (res.status === 404 || res.status === 410) {
        return { outcome: 'DEAD', reason: `HTTP ${res.status}` };
      }
      if (!res.ok) return { outcome: 'UNKNOWN', reason: `HTTP ${res.status}` };
      const html = await res.text();
      if (
        res.status === 403 ||
        html.includes('Just a moment') ||
        html.includes('Attention Required')
      ) {
        return { outcome: 'UNKNOWN', reason: 'cloudflare_blocked' };
      }
      const liveness = classifyKhmer24DetailLiveness(html, /-adid-(\d+)/i.exec(url)?.[1]);
      if (liveness === 'dead') {
        return { outcome: 'DEAD', reason: 'removed listing tombstone' };
      }
      if (liveness === 'unknown') return { outcome: 'UNKNOWN', reason: 'no confirmed Khmer24 detail post' };

      const snap: ScrapedSnapshot = {};
      const ldMatch = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
      if (ldMatch) {
        try {
          const raw = JSON.parse(ldMatch[1]!);
          for (const item of Array.isArray(raw) ? raw : [raw]) {
            if (item?.['@type'] !== 'Product') continue;
            const price = parseFloat(String(item.offers?.price ?? '').replace(/[^0-9.]/g, ''));
            if (!isNaN(price) && price > 0) snap.priceCents = Math.round(price * 100);
            if (typeof item.description === 'string') snap.text = item.description;
            const loc = item.offers?.seller?.address?.streetAddress;
            if (typeof loc === 'string' && loc) snap.location = loc;
            const imgs = item.image;
            if (Array.isArray(imgs) && imgs.length) snap.photos = imgs;
            const tel = item.offers?.seller?.telephone;
            snap.phone = Array.isArray(tel) ? tel[0] : tel;
          }
        } catch {
          // malformed JSON-LD — fine, just means no structured snapshot
        }
      }
      return { outcome: 'ALIVE', snap };
    } catch (err) {
      return { outcome: 'UNKNOWN', reason: `fetch error: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** A separately bounded canonical probe: one trusted host, no redirects, at most 256 KiB decoded HTML. */
  async checkCanonicalKhmer24(url: string, signal?: AbortSignal): Promise<LinkCheckResult> {
    const trusted = safeKhmer24Url(url);
    if (!trusted) return { outcome: 'UNKNOWN', reason: 'Untrusted Khmer24 URL', bytesRead: 0 };
    if (signal?.aborted) return { outcome: 'UNKNOWN', reason: 'Cancelled', bytesRead: 0 };
    const controller = new AbortController();
    const abortExternally = (): void => controller.abort();
    signal?.addEventListener('abort', abortExternally, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), 7000);
    let bytesRead = 0;
    try {
      const response = await fetch(trusted, {
        method: 'GET', headers: FETCH_HEADERS, redirect: 'manual', signal: controller.signal,
      });
      if (response.status === 404 || response.status === 410) {
        return { outcome: 'DEAD', reason: `HTTP ${response.status}`, statusCode: response.status, bytesRead };
      }
      if (response.status !== 200) {
        return { outcome: 'UNKNOWN', reason: `HTTP ${response.status}`, statusCode: response.status, bytesRead };
      }
      const contentType = response.headers.get('content-type');
      if (contentType && !/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType.trim())) {
        return { outcome: 'UNKNOWN', reason: 'Non-HTML response', statusCode: response.status, bytesRead };
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > CANONICAL_KHMER24_BODY_LIMIT)) {
        return { outcome: 'UNKNOWN', reason: 'HTML body exceeds canary limit', statusCode: response.status, bytesRead };
      }
      if (!response.body) return { outcome: 'UNKNOWN', reason: 'Empty HTML response', statusCode: response.status, bytesRead };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let html = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytesRead += chunk.value.byteLength;
        if (bytesRead > CANONICAL_KHMER24_BODY_LIMIT) {
          return { outcome: 'UNKNOWN', reason: 'HTML body exceeds canary limit', statusCode: response.status, bytesRead };
        }
        html += decoder.decode(chunk.value, { stream: true });
      }
      html += decoder.decode();
      if (!html.trim()) return { outcome: 'UNKNOWN', reason: 'Empty HTML response', statusCode: response.status, bytesRead };
      if (html.includes('Just a moment') || html.includes('Attention Required')) {
        return { outcome: 'UNKNOWN', reason: 'cloudflare_blocked', statusCode: response.status, bytesRead };
      }
      const liveness = classifyKhmer24DetailLiveness(html, /-adid-(\d+)/i.exec(trusted)?.[1]);
      if (liveness === 'dead') {
        return { outcome: 'DEAD', reason: 'removed listing tombstone', statusCode: response.status, bytesRead };
      }
      return { outcome: liveness === 'alive' ? 'ALIVE' : 'UNKNOWN',
        reason: liveness === 'unknown' ? 'no confirmed Khmer24 detail post' : undefined,
        statusCode: response.status, bytesRead };
    } catch (error) {
      return { outcome: 'UNKNOWN', reason: `fetch error: ${error instanceof Error ? error.message : String(error)}`, bytesRead };
    } finally {
      controller.abort(); // Stop any unread response bytes when rejecting headers or a truncated body.
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortExternally);
    }
  }

  /**
   * Facebook re-check via the anonymous permalink worker: post text +
   * GroupCommerceProductItem price. Falls back to a plain dead-marker check
   * when the Relay cache can't be extracted.
   */
  private async checkFacebook(prop: Property, url: string): Promise<{ outcome: LinkCheckResult['outcome']; snap?: ScrapedSnapshot; reason?: string }> {
    try {
      const post = await fetchPostTextAnonymous(url);
      if (!post) {
        const health = await this.checkUrl(url);
        // Anonymous HTML cannot establish that an authenticated group post is visible.
        return { outcome: 'UNKNOWN', reason: health.reason ?? 'Anonymous Facebook response is inconclusive' };
      }
      const snap: ScrapedSnapshot = { text: post.text };
      const price = post.commerce ? parseFormattedPrice(post.commerce.priceText) : null;
      if (price) {
        snap.priceCents =
          price.currency === 'KHR'
            ? Math.round((price.amount / 4_000) * 100)
            : price.currency === 'THB'
              ? Math.round((price.amount / 35.5) * 100)
              : price.amount < 10_000
                ? Math.round(price.amount * 100)
                : Math.round((price.amount / 4_000) * 100); // huge bare number on rent ≈ riel
      }
      return { outcome: post.text?.trim() ? 'ALIVE' : 'UNKNOWN', snap };
    } catch (err) {
      return { outcome: 'UNKNOWN', reason: `fb check error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Re-ingests a listing whose source text changed: pushes the fresh raw text
   * through the normal pipeline so regex/price/location logic re-runs, and the
   * source_url dedup check merges it into the existing row.
   */
  private async reingestChanged(prop: Property, url: string, snap: ScrapedSnapshot): Promise<boolean> {
    if (!this.ingestionService || !snap.text) return false;
    try {
      const res = await this.ingestionService.ingestRawListing({
        title: prop.title,
        description: snap.text,
        raw_text: snap.text,
        price: snap.priceCents !== undefined ? snap.priceCents / 100 : undefined,
        currency: 'USD',
        type: prop.type,
        category: prop.category ?? undefined,
        location: snap.location ?? (prop.location || undefined),
        city: prop.city,
        photos: snap.photos?.length ? snap.photos : prop.photos,
        phone: snap.phone,
        url,
        source_url: prop.source_url ?? url,
      });
      return res.status !== 'error';
    } catch (err) {
      console.warn(`[LinkVerifier] Re-ingest of #${prop.id} failed:`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * Smart-queue verification: pulls the listings that are due by age bucket
   * (fresh ≤7d → every 12h · mid ≤30d → every 72h · old >30d → every 7d),
   * performs a lightweight source check, deactivates dead links, syncs price
   * changes, and re-ingests listings whose text was edited.
   */
  async verifyBatch(limit = 25): Promise<{ checked: number; deactivated: number; updated: number; reingested: number }> {
    const due = this.propertiesRepo.findDueForVerification(limit);

    let checked = 0;
    let deactivated = 0;
    let updated = 0;
    let reingested = 0;

    for (const prop of due) {
      const url = prop.original_url || prop.source_url;
      if (!url) {
        continue;
      }

      checked++;

      let result: { outcome: LinkCheckResult['outcome']; snap?: ScrapedSnapshot; reason?: string };
      if (url.includes('khmer24.com')) {
        result = await this.checkKhmer24(url);
      } else if (url.includes('facebook.com') || url.includes('fb.com')) {
        result = await this.checkFacebook(prop, url);
      } else {
        const health = await this.checkUrl(url);
        result = { outcome: health.outcome, reason: health.reason };
      }

      if (result.outcome === 'UNKNOWN') continue;
      if (result.outcome === 'DEAD') {
        this.propertiesRepo.deactivateProperty(prop.id);
        deactivated++;
        console.log(`[LinkVerifier] 🚫 Deactivated dead listing #${prop.id} ("${prop.title.slice(0, 35)}..."): ${result.reason}`);
        continue;
      }

      this.propertiesRepo.markVerified(prop.id);

      const snap = result.snap;
      if (!snap) continue;

      // Price sync — source page wins when it shows a different non-zero price.
      if (snap.priceCents && snap.priceCents !== prop.price) {
        this.propertiesRepo.updateVerifiedFields(prop.id, { price: snap.priceCents });
        updated++;
        console.log(`[LinkVerifier] 💲 #${prop.id} price ${prop.price / 100} → ${snap.priceCents / 100}`);
      }

      // Text change → full re-ingest (merged into the same row via source_url).
      if (snap.text && textChanged(prop.raw_text ?? prop.description ?? '', snap.text)) {
        if (await this.reingestChanged(prop, url, snap)) {
          reingested++;
          console.log(`[LinkVerifier] ♻️  #${prop.id} source text changed — re-ingested`);
        }
      }

      // Be gentle: fixed jitter between requests.
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
    }

    if ((deactivated > 0 || updated > 0 || reingested > 0) && this.alertService) {
      await this.alertService.info(
        `🧹 <b>Listing Re-Verification:</b> ${checked} checked — ` +
        `${deactivated} dead deactivated, ${updated} price updates, ${reingested} edited & re-parsed.`,
      );
    }

    return { checked, deactivated, updated, reingested };
  }
}
