import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { FacebookLiveAdapter } from '../src/modules/parser/live-source-adapters';
import { inspectFacebookOgPhoto, applyFacebookOgPhotoRenewal } from '../src/modules/parser/facebook-og-media-refresh';
import { knownFacebookMediaUrls } from '../src/modules/parser/media-identity';
import { toPropertyDTO } from '../src/modules/api/dto';

const postUrl = 'https://www.facebook.com/groups/654321/posts/1001/';
const original = 'https://scontent-a.fbcdn.net/v/t39.30808-6/cover.jpg?oe=expired';
const renewed = 'https://scontent-b.fbcdn.net/v/t39.30808-6/cover.jpg?oe=renewed';
const second = 'https://scontent-a.fbcdn.net/v/t39.30808-6/second.jpg?oe=expired';

const html = (ogUrl = postUrl, image = renewed) => `<html><head>
  <meta property="og:url" content="${ogUrl}">
  <meta property="og:image" content="${image.replace(/&/g, '&amp;')}">
  </head></html>`;

function mockFetch(pageHtml = html(), imageStatus = 206, mime = 'image/jpeg'): typeof fetch {
  return jest.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === postUrl) return new Response(pageHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url === renewed) return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), {
      status: imageStatus, headers: { 'content-type': mime },
    });
    throw new Error('Unexpected network destination');
  }) as unknown as typeof fetch;
}

const request = { postUrl, externalId: '1001', groupId: '654321', knownPhotos: [original, second] };

describe('Facebook public Open Graph media proof', () => {
  it('collects original known gallery URLs from both current and legacy source payloads', () => {
    expect(knownFacebookMediaUrls({
      photos: [original], listing: { photos: [second] },
      photoAssets: [{ url: original }, { url: null }],
    })).toEqual([original, second]);
  });

  it('accepts one reachable image with matching post, group and stable CDN pathname', async () => {
    expect(await inspectFacebookOgPhoto(request, mockFetch())).toEqual({
      postUrl, externalId: '1001', groupId: '654321', imageUrl: renewed,
    });
  });

  it('accepts an original group slug whose saved group identifier is numeric', async () => {
    const aliasUrl = 'https://www.facebook.com/groups/cheaprentsiemreap/posts/1001/';
    const numericUrl = 'https://www.facebook.com/groups/654321/posts/1001/';
    const fetcher = jest.fn(async (input: string | URL | Request) => {
      if (String(input) === aliasUrl) return new Response(html(numericUrl), {
        headers: { 'content-type': 'text/html' },
      });
      if (String(input) === renewed) return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), {
        status: 206, headers: { 'content-type': 'image/jpeg' },
      });
      throw new Error('Unexpected destination');
    }) as unknown as typeof fetch;
    expect(await inspectFacebookOgPhoto({ ...request, postUrl: aliasUrl }, fetcher))
      .toMatchObject({ postUrl: aliasUrl, imageUrl: renewed, groupId: '654321' });
  });

  it('follows a single same-post www to web Facebook redirect manually', async () => {
    const webUrl = postUrl.replace('www.facebook.com', 'web.facebook.com');
    const fetcher = jest.fn(async (input: string | URL | Request, options?: RequestInit) => {
      expect(options?.redirect).toBe('manual');
      if (String(input) === postUrl) return new Response(null, {
        status: 302, headers: { location: webUrl },
      });
      if (String(input) === webUrl) return new Response(html(webUrl), {
        status: 200, headers: { 'content-type': 'text/html' },
      });
      if (String(input) === renewed) return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), {
        status: 206, headers: { 'content-type': 'image/jpeg' },
      });
      throw new Error('Unexpected destination');
    }) as unknown as typeof fetch;
    expect(await inspectFacebookOgPhoto(request, fetcher)).toMatchObject({ postUrl, imageUrl: renewed });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('refuses redirects that change the Facebook group or require another hop', async () => {
    const webUrl = postUrl.replace('www.facebook.com', 'web.facebook.com');
    for (const firstTarget of ['https://web.facebook.com/groups/999999/posts/1001/', webUrl]) {
      const fetcher = jest.fn(async (input: string | URL | Request) => {
        if (String(input) === postUrl) return new Response(null, {
          status: 302, headers: { location: firstTarget },
        });
        return new Response(null, { status: 302, headers: { location: postUrl } });
      }) as unknown as typeof fetch;
      expect(await inspectFacebookOgPhoto(request, fetcher)).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(firstTarget === webUrl ? 2 : 1);
    }
  });

  it('accepts an image when the CDN ignores the Range header and returns a full HTTP 200', async () => {
    const fetcher = jest.fn(async (input: string | URL | Request) => {
      if (String(input) === postUrl) {
        return new Response(html(), { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (String(input) === renewed) {
        const fullImage = new Uint8Array(1024);
        fullImage.set([0xff, 0xd8, 0xff, 0xe0]);
        return new Response(fullImage, { status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': String(fullImage.length) } });
      }
      throw new Error('Unexpected destination');
    }) as unknown as typeof fetch;
    expect(await inspectFacebookOgPhoto(request, fetcher)).toMatchObject({ imageUrl: renewed });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects conflicting Open Graph post or image tags', async () => {
    const conflictingPost = html() + `<meta property="og:url" content="https://www.facebook.com/groups/654321/posts/9999/">`;
    const conflictingImage = html() + `<meta property="og:image" content="${second}">`;
    for (const pageHtml of [conflictingPost, conflictingImage]) {
      const fetcher = mockFetch(pageHtml);
      expect(await inspectFacebookOgPhoto(request, fetcher)).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['wrong post', html('https://www.facebook.com/groups/654321/posts/9999/')],
    ['wrong group', html('https://www.facebook.com/groups/999999/posts/1001/')],
    ['wrong image', html(postUrl, 'https://scontent-b.fbcdn.net/v/t39.30808-6/stranger.jpg?oe=x')],
    ['external image host', html(postUrl, 'https://external.example.com/pic.jpg')],
    ['missing image', '<meta property="og:url" content="' + postUrl + '">'],
  ])('rejects %s without fetching any image', async (_reason, pageHtml) => {
    const fetcher = mockFetch(pageHtml);
    expect(await inspectFacebookOgPhoto(request, fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a post that redirects and an unsafe saved URL without following either', async () => {
    const fetcher = jest.fn(async () => new Response(null, {
      status: 302, headers: { location: 'https://external.example.com/login' },
    })) as unknown as typeof fetch;
    expect(await inspectFacebookOgPhoto(request, fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await inspectFacebookOgPhoto({ ...request, postUrl: 'http://127.0.0.1/groups/654321/posts/1001' }, fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, 'image/jpeg'],
    [200, 'text/html'],
  ])('rejects unproven image response %s %s', async (status, mime) => {
    expect(await inspectFacebookOgPhoto(request, mockFetch(html(), status, mime))).toBeNull();
  });

  it('rejects overlarge OG HTML before accepting its image', async () => {
    const fetcher = mockFetch(html() + 'x'.repeat(2_200_000));
    expect(await inspectFacebookOgPhoto(request, fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts Facebook HTML larger than 512 KiB within the bounded page limit', async () => {
    expect(await inspectFacebookOgPhoto(request, mockFetch(html() + 'x'.repeat(1_300_000))))
      .toMatchObject({ imageUrl: renewed });
  });
});

describe('Facebook media-only renewal on isolated canonical SQLite', () => {
  let db: DatabaseSync;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    await createContainer({ db }).ingestionService.ingestBatch(new FacebookLiveAdapter(async function* () {
      yield { sourceId: '654321', sourceName: 'Test Group', groupId: '654321',
        listing: { title: 'Rental apartment', description: 'For rent $450 monthly',
          raw_text: 'For rent $450 monthly', is_real_estate: true,
          source_url: postUrl, posted_at: '2026-10-01T00:00:00Z', photos: [original, second],
          city: 'siem_reap' } };
    }, async (_raw, item) => ({ ...item, raw: { ...item.raw, preservedExtraction: { bedrooms: 2 } } })), {
      runType: 'DISCOVERY', ingestionMethod: 'CAMOUFOX', observedAt: '2026-10-06T00:00:00Z',
    });
  });
  afterEach(() => db.close());

  it('keeps a renewed cover first in public list and detail gallery order', async () => {
    const source = db.prepare('SELECT id FROM source_items').get() as { id: number };
    const listing = db.prepare('SELECT id FROM canonical_listings').get() as { id: number };
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=?').run(recent);
    db.prepare('UPDATE source_items SET published_at=?').run(recent);
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?")
      .run(listing.id);

    const repository = createContainer({ db }).canonicalListingRepo;
    const publicItem = () => repository.searchProperties({ city: 'siem_reap', type: 'rent' }).items
      .find((item) => item.id === listing.id);
    expect(repository.listPublicListingIds({ city: 'siem_reap', type: 'rent' }))
      .toContain(listing.id);
    expect(publicItem()?.photos).toEqual([original, second]);
    expect(toPropertyDTO(publicItem()!).thumbnail).toBe(original);

    const proof = await inspectFacebookOgPhoto(request, mockFetch());
    expect(applyFacebookOgPhotoRenewal(db, source.id, proof!)).toBe(true);

    expect(publicItem()?.photos).toEqual([renewed, second]);
    expect(toPropertyDTO(publicItem()!).thumbnail).toBe(renewed);
    const detail = repository.getPropertyById(listing.id);
    expect(detail?.photos).toEqual([renewed, second]);
    expect(toPropertyDTO(detail!, undefined, { includeAllPhotos: true }).photos)
      .toEqual([renewed, second]);
    expect(toPropertyDTO(detail!).thumbnail).toBe(renewed);
  });

  it('changes only the matched photo and source media link while preserving timestamps and versions', async () => {
    const source = db.prepare('SELECT id FROM source_items').get() as { id: number };
    const listing = db.prepare('SELECT id FROM canonical_listings').get() as { id: number };
    const beforeSource = db.prepare(`SELECT published_at,last_seen_at,first_seen_at,content_hash,media_hash,updated_at
      FROM source_items WHERE id=?`).get(source.id);
    const beforeListing = db.prepare('SELECT last_seen_at,updated_at FROM canonical_listings WHERE id=?').get(listing.id);
    const beforeOccurrence = db.prepare('SELECT posted_at,last_seen_at,updated_at FROM canonical_listing_source_occurrences').get();
    const beforeVersions = db.prepare('SELECT COUNT(*) n FROM source_item_versions').get();
    const proof = await inspectFacebookOgPhoto(request, mockFetch());
    expect(proof).not.toBeNull();
    expect(applyFacebookOgPhotoRenewal(db, source.id, proof!)).toBe(true);
    expect(db.prepare(`SELECT published_at,last_seen_at,first_seen_at,content_hash,media_hash,updated_at
      FROM source_items WHERE id=?`).get(source.id)).toEqual(beforeSource);
    expect(db.prepare('SELECT last_seen_at,updated_at FROM canonical_listings WHERE id=?').get(listing.id)).toEqual(beforeListing);
    expect(db.prepare('SELECT posted_at,last_seen_at,updated_at FROM canonical_listing_source_occurrences').get())
      .toEqual(beforeOccurrence);
    expect(db.prepare('SELECT COUNT(*) n FROM source_item_versions').get()).toEqual(beforeVersions);
    const payload = JSON.parse((db.prepare('SELECT raw_payload_json FROM source_items WHERE id=?').get(source.id) as {
      raw_payload_json: string;
    }).raw_payload_json);
    expect(payload.preservedExtraction).toEqual({ bedrooms: 2 });
    expect(payload.photos).toEqual([renewed, second]);
    expect(payload.listing.photos).toEqual([renewed, second]);
    const property = createContainer({ db }).canonicalListingRepo.getPropertyById(listing.id, true);
    expect(property?.photos).toEqual(expect.arrayContaining([renewed, second]));
    expect(property?.photos).not.toContain(original);
    expect(applyFacebookOgPhotoRenewal(db, source.id, proof!)).toBe(false);
  });

  it('refuses a proof for another post and leaves the database intact', async () => {
    const source = db.prepare('SELECT id,raw_payload_json FROM source_items').get() as { id: number; raw_payload_json: string };
    expect(applyFacebookOgPhotoRenewal(db, source.id, {
      postUrl: 'https://www.facebook.com/groups/654321/posts/9999/', externalId: '9999',
      groupId: '654321', imageUrl: renewed,
    })).toBe(false);
    expect(db.prepare('SELECT raw_payload_json FROM source_items WHERE id=?').get(source.id)).toEqual({
      raw_payload_json: source.raw_payload_json,
    });
  });

  it('preserves another source association when an old asset was shared', async () => {
    await createContainer({ db }).ingestionService.ingestBatch(new FacebookLiveAdapter(async function* () {
      yield { sourceId: '777777', sourceName: 'Other Group', groupId: '777777',
        listing: { title: 'Other apartment', description: 'For rent $600 monthly',
          raw_text: 'For rent $600 monthly', is_real_estate: true,
          source_url: 'https://www.facebook.com/groups/777777/posts/2002/',
          photos: [original], city: 'siem_reap' } };
    }), { runType: 'DISCOVERY', ingestionMethod: 'CAMOUFOX', observedAt: '2026-10-06T00:00:00Z' });
    const source = db.prepare("SELECT id FROM source_items WHERE external_id='1001'").get() as { id: number };
    const other = db.prepare("SELECT id FROM source_items WHERE external_id='2002'").get() as { id: number };
    expect(applyFacebookOgPhotoRenewal(db, source.id, (await inspectFacebookOgPhoto(request, mockFetch()))!)).toBe(true);
    const joined = db.prepare(`SELECT ma.source_url FROM media_asset_source_occurrences mo
      JOIN media_assets ma ON ma.id=mo.media_asset_id WHERE mo.source_item_id=?`).all(other.id) as Array<{ source_url: string }>;
    expect(joined.map((row) => row.source_url)).toContain(original);
    const otherListing = db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=?')
      .get(other.id) as { listing_id: number };
    expect(createContainer({ db }).canonicalListingRepo.getPropertyById(otherListing.listing_id, true)?.photos)
      .toEqual([original]);
  });

  it('reuses an existing renewed media asset without losing either source association', async () => {
    await createContainer({ db }).ingestionService.ingestBatch(new FacebookLiveAdapter(async function* () {
      yield { sourceId: '777777', sourceName: 'Other Group', groupId: '777777',
        listing: { title: 'Other apartment', description: 'For rent $600 monthly',
          raw_text: 'For rent $600 monthly', is_real_estate: true,
          source_url: 'https://www.facebook.com/groups/777777/posts/2002/',
          photos: [renewed], city: 'siem_reap' } };
    }), { runType: 'DISCOVERY', ingestionMethod: 'CAMOUFOX', observedAt: '2026-10-06T00:00:00Z' });
    const source = db.prepare("SELECT id FROM source_items WHERE external_id='1001'").get() as { id: number };
    const other = db.prepare("SELECT id FROM source_items WHERE external_id='2002'").get() as { id: number };
    const proof = (await inspectFacebookOgPhoto(request, mockFetch()))!;
    expect(applyFacebookOgPhotoRenewal(db, source.id, proof)).toBe(true);
    const links = db.prepare(`SELECT mo.source_item_id AS sourceId,ma.source_url AS url
      FROM media_asset_source_occurrences mo JOIN media_assets ma ON ma.id=mo.media_asset_id
      WHERE mo.source_item_id IN (?,?) ORDER BY mo.source_item_id,ma.source_url`)
      .all(source.id, other.id) as Array<{ sourceId: number; url: string }>;
    expect(links.filter((link) => link.sourceId === source.id).map((link) => link.url).sort())
      .toEqual([renewed, second].sort());
    expect(links.filter((link) => link.sourceId === other.id).map((link) => link.url))
      .toEqual([renewed]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM media_assets WHERE normalized_url=?').get(renewed))
      .toEqual({ count: 1 });
    const listing = db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=?')
      .get(source.id) as { listing_id: number };
    expect(createContainer({ db }).canonicalListingRepo.getPropertyById(listing.listing_id, true)?.photos)
      .toEqual([renewed, second]);
    expect(applyFacebookOgPhotoRenewal(db, source.id, proof)).toBe(false);
  });

  it('renews media for a saved slug-group permalink with a numeric group ID', async () => {
    const aliasedPostUrl = 'https://www.facebook.com/groups/cheaprentsiemreap/posts/90909090/';
    await createContainer({ db }).ingestionService.ingestBatch(new FacebookLiveAdapter(async function* () {
      yield { sourceId: '654321', sourceName: 'Named Group', groupId: '654321',
        listing: { title: 'Named group apartment', description: 'For rent $700 monthly',
          raw_text: 'For rent $700 monthly', is_real_estate: true,
          source_url: aliasedPostUrl, photos: [original], city: 'siem_reap' } };
    }), { runType: 'DISCOVERY', ingestionMethod: 'CAMOUFOX', observedAt: '2026-10-06T00:00:00Z' });
    const source = db.prepare("SELECT id,group_id FROM source_items WHERE external_id='90909090'")
      .get() as { id: number; group_id: string };
    expect(source.group_id).toBe('654321');
    const verified = { postUrl: aliasedPostUrl, externalId: '90909090', groupId: '654321', imageUrl: renewed };
    expect(applyFacebookOgPhotoRenewal(db, source.id, verified)).toBe(true);
    const payload = JSON.parse((db.prepare('SELECT raw_payload_json FROM source_items WHERE id=?')
      .get(source.id) as { raw_payload_json: string }).raw_payload_json);
    expect(payload.photos).toEqual([renewed]);
  });
});
