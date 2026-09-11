import type { PropertiesRepository, Property } from '../database/repositories/properties.repo';
import type { AlertService } from './alert.service';
import type { IngestionService } from '../modules/parser/ingestor';
import { fetchPostTextAnonymous, parseFormattedPrice } from '../modules/parser/fb-worker';

export interface LinkCheckResult {
  isAlive: boolean;
  statusCode?: number;
  reason?: string;
  normalizedUrl?: string;
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
      return { isAlive: false, reason: 'Invalid or missing URL scheme' };
    }

    // Normalize web.facebook.com to www.facebook.com
    let targetUrl = rawUrl;
    let normalizedUrl: string | undefined;
    if (targetUrl.includes('web.facebook.com')) {
      targetUrl = targetUrl.replace('web.facebook.com', 'www.facebook.com');
      normalizedUrl = targetUrl;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);

      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Definite 404 or 410 Gone
      if (res.status === 404 || res.status === 410) {
        return { isAlive: false, statusCode: res.status, reason: `HTTP ${res.status} Not Found`, normalizedUrl };
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
            isAlive: false,
            statusCode: res.status,
            reason: 'Content removed, expired, or unavailable',
            normalizedUrl,
          };
        }
      }

      return { isAlive: true, statusCode: res.status, normalizedUrl };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('timeout')) {
        // Timeouts or transient network issues do not mark a listing dead
        return { isAlive: true, reason: 'Network timeout (transient)' };
      }
      return { isAlive: true, reason: `Network check error: ${msg}` };
    }
  }

  /**
   * Lightweight Khmer24 re-check: a single HTML fetch, JSON-LD parsed with
   * regex (no browser needed). Cloudflare challenges are treated as "alive —
   * can't verify", never as dead.
   */
  private async checkKhmer24(url: string): Promise<{ alive: boolean; snap?: ScrapedSnapshot; reason?: string }> {
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow' });
      if (res.status === 404 || res.status === 410) {
        return { alive: false, reason: `HTTP ${res.status}` };
      }
      const html = await res.text();
      if (
        res.status === 403 ||
        html.includes('Just a moment') ||
        html.includes('Attention Required')
      ) {
        return { alive: true, reason: 'cloudflare_blocked' };
      }
      // K24 removed-ad pages still return 200 — detect the tombstone text.
      if (/this (ad|listing|post) (is|was) (no longer available|removed|deleted|expired)/i.test(html)) {
        return { alive: false, reason: 'removed listing tombstone' };
      }

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
      return { alive: true, snap };
    } catch (err) {
      return { alive: true, reason: `fetch error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Facebook re-check via the anonymous permalink worker: post text +
   * GroupCommerceProductItem price. Falls back to a plain dead-marker check
   * when the Relay cache can't be extracted.
   */
  private async checkFacebook(prop: Property, url: string): Promise<{ alive: boolean; snap?: ScrapedSnapshot; reason?: string }> {
    try {
      const post = await fetchPostTextAnonymous(url);
      if (!post) {
        const health = await this.checkUrl(url);
        return { alive: health.isAlive, reason: health.reason };
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
      return { alive: true, snap };
    } catch (err) {
      return { alive: true, reason: `fb check error: ${err instanceof Error ? err.message : String(err)}` };
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
        this.propertiesRepo.markVerified(prop.id);
        continue;
      }

      checked++;

      let result: { alive: boolean; snap?: ScrapedSnapshot; reason?: string };
      if (url.includes('khmer24.com')) {
        result = await this.checkKhmer24(url);
      } else if (url.includes('facebook.com') || url.includes('fb.com')) {
        result = await this.checkFacebook(prop, url);
      } else {
        const health = await this.checkUrl(url);
        result = { alive: health.isAlive, reason: health.reason };
      }

      if (!result.alive) {
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
