import type { Property, PropertiesRepository } from '../src/database/repositories/properties.repo';
import { LinkVerifierService } from '../src/services/link-verifier.service';

jest.mock('../src/modules/parser/fb-worker', () => ({
  fetchPostTextAnonymous: jest.fn(async () => null),
  parseFormattedPrice: jest.fn(),
}));

const property = (id: number, url: string): Property => ({
  id, title: `Fixture ${id}`, original_url: url, source_url: url,
  price: 40000, raw_text: '',
} as Property);

describe('LinkVerifierService conservative offline health checks', () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let due: Property[];
  let deactivate: jest.Mock;
  let verified: jest.Mock;
  let service: LinkVerifierService;
  let fetchMock: jest.Mock;
  let timersMocked = false;

  function useControlledTimers(): void {
    jest.useFakeTimers();
    timersMocked = true;
  }

  beforeEach(() => {
    timersMocked = false;
    due = [];
    deactivate = jest.fn();
    verified = jest.fn();
    service = new LinkVerifierService({
      findDueForVerification: () => due,
      deactivateProperty: deactivate,
      markVerified: verified,
      updateVerifiedFields: jest.fn(),
    } as unknown as PropertiesRepository);
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (timersMocked) {
      jest.useRealTimers();
      // This Jest/Node combination drops the global timers after restoring a fake clock.
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('keeps anonymous Facebook 404/410, login wall, access denial and network failure UNKNOWN', async () => {
    for (const status of [404, 410, 403]) {
      fetchMock.mockResolvedValueOnce(new Response('Not found', { status }));
      expect((await service.checkUrl('https://www.facebook.com/groups/abc/posts/123')).outcome).toBe('UNKNOWN');
    }
    fetchMock.mockResolvedValueOnce(new Response("This content isn't available right now"));
    expect((await service.checkUrl('https://web.facebook.com/groups/abc/posts/123'))).toMatchObject({
      outcome: 'UNKNOWN', normalizedUrl: 'https://www.facebook.com/groups/abc/posts/123',
    });
    fetchMock.mockRejectedValueOnce(new Error('transient network failure'));
    expect((await service.checkUrl('https://www.facebook.com/groups/abc/posts/123')).outcome).toBe('UNKNOWN');
    expect((await service.checkUrl('ftp://example.com')).outcome).toBe('UNKNOWN');
  });

  it('only treats non-Facebook hard 404/410 as definitely dead in generic checks', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await service.checkUrl('https://example.com/removed')).toMatchObject({ outcome: 'DEAD', statusCode: 404 });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 410 }));
    expect(await service.checkUrl('https://example.com/removed')).toMatchObject({ outcome: 'DEAD', statusCode: 410 });
    fetchMock.mockResolvedValueOnce(new Response('Visible listing'));
    expect(await service.checkUrl('https://example.com/listing')).toMatchObject({ outcome: 'ALIVE', statusCode: 200 });
  });

  it('keeps Facebook/challenged Khmer24 inventory active and deactivates proven Khmer24 tombstones', async () => {
    due = [property(1, 'https://www.facebook.com/groups/abc/posts/1'), property(2, 'https://www.khmer24.com/en/blocked-adid-2')];
    fetchMock.mockResolvedValueOnce(new Response('Page Not Found', { status: 404 }));
    fetchMock.mockResolvedValueOnce(new Response('Just a moment...'));
    expect(await service.verifyBatch(2)).toEqual({ checked: 2, deactivated: 0, updated: 0, reingested: 0 });
    expect(deactivate).not.toHaveBeenCalled();
    expect(verified).not.toHaveBeenCalled();

    due = [property(3, 'https://www.khmer24.com/en/removed-adid-3'), property(4, 'https://www.khmer24.com/en/dead-adid-4')];
    fetchMock.mockResolvedValueOnce(new Response('This ad is no longer available'));
    fetchMock.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    expect(await service.verifyBatch(2)).toEqual({ checked: 2, deactivated: 2, updated: 0, reingested: 0 });
    expect(deactivate.mock.calls).toEqual([[3], [4]]);
    expect(verified).not.toHaveBeenCalled();
  });

  it('returns UNKNOWN after aborting a stalled response body and clears the request timeout', async () => {
    useControlledTimers();
    fetchMock.mockImplementationOnce(async (_url: string, options: RequestInit) => {
      const response = new Response('ignored');
      response.text = () => new Promise<string>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return response;
    });
    const pending = service.checkUrl('https://example.com/slow-body');
    await jest.advanceTimersByTimeAsync(7000);
    expect((await pending).outcome).toBe('UNKNOWN');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts stalled Khmer24 verification without deactivating or marking it verified', async () => {
    useControlledTimers();
    due = [property(5, 'https://www.khmer24.com/en/stalled-adid-5')];
    fetchMock.mockImplementationOnce((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = service.verifyBatch(1);
    await jest.advanceTimersByTimeAsync(7000);
    expect(await pending).toEqual({ checked: 1, deactivated: 0, updated: 0, reingested: 0 });
    expect(deactivate).not.toHaveBeenCalled();
    expect(verified).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not follow Khmer24 redirects to an external host during canonical checks', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { Location: 'https://redirect.example.test/collector' },
    }));
    expect(await service.checkCanonicalKhmer24('https://www.khmer24.com/en/offer-adid-123'))
      .toMatchObject({ outcome: 'UNKNOWN', reason: 'HTTP 302' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses untrusted URLs before any canonical network request', async () => {
    for (const url of [
      'https://khmer24.com.evil.test/en/ad-adid-123', 'http://www.khmer24.com/en/ad-adid-123',
      'https://www.khmer24.com:8443/en/ad-adid-123', 'https://user@www.khmer24.com/en/ad-adid-123',
      'https://www.khmer24.com/en/ad', 'https://www.khmer24.com/search',
      'https://www.khmer24.com/en/ad-adid-123?next=https://evil.test',
      'https://www.khmer24.com/en/../ad-adid-123',
    ]) {
      expect(await service.checkCanonicalKhmer24(url)).toMatchObject({ outcome: 'UNKNOWN',
        reason: 'Untrusted Khmer24 URL' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized or non-HTML canonical responses without claiming a listing is alive', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>valid</html>', { headers: {
      'Content-Type': 'text/html', 'Content-Length': '500000',
    } }));
    expect(await service.checkCanonicalKhmer24('https://www.khmer24.com/en/ad-adid-123'))
      .toMatchObject({ outcome: 'UNKNOWN', reason: 'HTML body exceeds canary limit' });

    fetchMock.mockResolvedValueOnce(new Response('binary', { headers: { 'Content-Type': 'image/png' } }));
    expect(await service.checkCanonicalKhmer24('https://www.khmer24.com/en/ad-adid-123'))
      .toMatchObject({ outcome: 'UNKNOWN', reason: 'Non-HTML response' });

    fetchMock.mockResolvedValueOnce(new Response('<html>partial</html>', { status: 206,
      headers: { 'Content-Type': 'text/html' } }));
    expect(await service.checkCanonicalKhmer24('https://www.khmer24.com/en/ad-adid-123'))
      .toMatchObject({ outcome: 'UNKNOWN', reason: 'HTTP 206' });
  });

  it('stops an HTML stream after the configured decoded-byte limit', async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(200 * 1024).fill(65));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'text/html' } }));
    expect(await service.checkCanonicalKhmer24('https://www.khmer24.com/en/ad-adid-123'))
      .toMatchObject({ outcome: 'UNKNOWN', reason: 'HTML body exceeds canary limit' });
    expect(reads).toBeLessThanOrEqual(4);
  });

  it('distinguishes real Khmer24 tombstones, challenges, and small HTML listings', async () => {
    for (const [html, outcome] of [
      ['This ad is no longer available', 'DEAD'],
      ['The product you are looking for is sold out (or deleted).', 'DEAD'],
      ['Just a moment... verifying your browser', 'UNKNOWN'],
      ['<html><title>Rental listing</title></html>', 'UNKNOWN'],
      ['<script type="application/ld+json">{"@type":"Product","sku":"123"}</script>', 'ALIVE'],
    ]) {
      fetchMock.mockResolvedValueOnce(new Response(html, { headers: { 'Content-Type': 'text/html' } }));
      expect((await service.checkCanonicalKhmer24('https://www.khmer24.com/en/ad-adid-123')).outcome).toBe(outcome);
    }
    fetchMock.mockResolvedValueOnce(new Response('Missing', { status: 404 }));
    expect(await service.checkCanonicalKhmer24('https://www.khmer24.com/en/ad-adid-123'))
      .toMatchObject({ outcome: 'DEAD', bytesRead: 0 });
  });

  it('measures consumed HTML bytes and honors operator cancellation', async () => {
    const html = '<html>ជំរាបសួរ<script type="application/ld+json">{"@type":"Product","sku":"123"}</script></html>';
    fetchMock.mockResolvedValueOnce(new Response(html, { headers: { 'Content-Type': 'text/html' } }));
    expect(await service.checkCanonicalKhmer24('https://www.khmer24.com/en/ad-adid-123'))
      .toMatchObject({ outcome: 'ALIVE', bytesRead: new TextEncoder().encode(html).length });

    const controller = new AbortController();
    fetchMock.mockImplementationOnce((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const check = service.checkCanonicalKhmer24('https://www.khmer24.com/en/ad-adid-123', controller.signal);
    controller.abort();
    expect(await check).toMatchObject({ outcome: 'UNKNOWN', bytesRead: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await service.checkCanonicalKhmer24('https://www.khmer24.com/en/ad-adid-123', controller.signal))
      .toMatchObject({ outcome: 'UNKNOWN', reason: 'Cancelled', bytesRead: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
