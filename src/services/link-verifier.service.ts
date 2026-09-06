import type { PropertiesRepository } from '../database/repositories/properties.repo';
import type { AlertService } from './alert.service';

export interface LinkCheckResult {
  isAlive: boolean;
  statusCode?: number;
  reason?: string;
  normalizedUrl?: string;
}

export class LinkVerifierService {
  constructor(
    private readonly propertiesRepo: PropertiesRepository,
    private readonly alertService?: AlertService,
  ) {}

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
   * Scans a batch of active properties and deactivates any that lead to 404 or dead links.
   */
  async verifyBatch(limit = 25): Promise<{ checked: number; deactivated: number }> {
    const activeProps = this.propertiesRepo.searchProperties({
      limit,
      offset: 0,
    });

    let checked = 0;
    let deactivated = 0;

    for (const prop of activeProps.items) {
      const url = prop.original_url || prop.source_url;
      if (!url) continue;

      checked++;
      const health = await this.checkUrl(url);

      if (!health.isAlive) {
        this.propertiesRepo.deactivateProperty(prop.id);
        deactivated++;
        console.log(`[LinkVerifier] 🚫 Deactivated dead listing #${prop.id} ("${prop.title.slice(0, 35)}..."): ${health.reason}`);
      }
    }

    if (deactivated > 0 && this.alertService) {
      await this.alertService.info(
        `🧹 <b>Listing Health Check:</b> Deactivated <b>${deactivated}</b> dead/404 listing(s) out of ${checked} checked.`,
      );
    }

    return { checked, deactivated };
  }
}

