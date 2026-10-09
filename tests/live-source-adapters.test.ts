import { FacebookLiveAdapter, Khmer24LiveAdapter } from '../src/modules/parser/live-source-adapters';

describe('live unified source adapters', () => {
  const context = { runType: 'DISCOVERY' as const, ingestionMethod: 'KHMER24_SCRAPER' as const };

  it('normalizes Khmer24 ad IDs, photos, media hashes and source text', () => {
    const adapter = new Khmer24LiveAdapter(async function* () { /* no network in adapter tests */ });
    const item = adapter.normalize({ sourceId: 'siem-reap', sourceName: 'Khmer24',
      listing: { title: 'Apartment', description: 'For rent $350/month', raw_text: 'For rent $350/month',
        source_url: 'https://www.khmer24.com/en/apartment-adid-12345', city: 'siem_reap',
        photos: ['https://img.example/a.jpg', 'https://img.example/a.jpg'] } });
    expect(item.externalId).toBe('12345');
    expect(item.classification).toBe('HOUSING_SUPPLY');
    expect(item.rawText).toBe('For rent $350/month');
    expect(item.mediaHash).toHaveLength(64);
    expect((item.raw as unknown as { photos: string[] }).photos).toHaveLength(1);
  });

  it('preserves the shadow classifier outcome for raw listings rejected by enrichment', () => {
    const adapter = new Khmer24LiveAdapter(async function* () {});
    const item = adapter.normalize({sourceId:'siem-reap',sourceName:'Khmer24',classification:'IRRELEVANT',
      listing:{title:'Shop house',raw_text:'Commercial shop house',source_url:'https://www.khmer24.com/en/shop-adid-54321',
        city:'siem_reap',photos:[]}});
    expect(item.classification).toBe('IRRELEVANT');
  });

  it('does not request discovery records until its fetcher is consumed', async () => {
    let fetched = false;
    const adapter = new FacebookLiveAdapter(async function* () {
      fetched = true;
      yield { sourceId: 'group-1', sourceName: 'Group 1',
        listing: { title: 'House', raw_text: 'For rent $400', source_url: 'https://facebook.com/groups/group-1/posts/999', city: 'siem_reap', photos: [] } };
    });
    expect(fetched).toBe(false);
    const rows = [];
    for await (const raw of adapter.fetchNewItems(context)) rows.push(adapter.normalize(raw));
    expect(fetched).toBe(true);
    expect(rows[0]?.externalId).toBe('999');
  });
});
