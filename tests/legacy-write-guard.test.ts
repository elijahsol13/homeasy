import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { createContainer } from '../src/container';
import type { NormalizedSourceItem, SourceAdapter, SourceRunContext } from '../src/modules/parser/ingestion-contracts';
import {
  assertLegacyPropertiesUnchanged,
  installLegacyPropertiesWriteGuard,
  snapshotLegacyProperties,
} from '../src/database/legacy-write-guard';

describe('legacy properties shadow write guard', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO properties
      (hash,title,description,price,currency,type,location,city,photos,direct_contact,original_url,parsed_at,created_at,updated_at)
      VALUES ('fixture-hash','Fixture apartment','For rent',400,'USD','rent','Wat Bo','siem_reap','[]','{}','https://example.test/1','2026-01-01','2026-01-01','2026-01-01')`)
      .run();
  });

  afterEach(() => db.close());

  it('rejects legacy inserts, updates, and deletes and keeps a full-row digest stable', () => {
    const before = snapshotLegacyProperties(db);
    installLegacyPropertiesWriteGuard(db);

    expect(() => db.prepare("UPDATE properties SET description='mutated' WHERE id=1").run())
      .toThrow(/LegacyWriteForbiddenError/);
    expect(() => db.prepare("INSERT INTO properties (hash,title,description,price,currency,type,location,city,photos,direct_contact,original_url,parsed_at,created_at,updated_at) VALUES ('h2','t','d',1,'USD','rent','x','siem_reap','[]','{}','u','p','c','u')").run())
      .toThrow(/LegacyWriteForbiddenError/);
    expect(() => db.prepare('DELETE FROM properties WHERE id=1').run())
      .toThrow(/LegacyWriteForbiddenError/);

    expect(assertLegacyPropertiesUnchanged(db, before)).toEqual(before);
  });

  it('detects any legacy change, including updated_at, in the acceptance digest', () => {
    const before = snapshotLegacyProperties(db);
    db.prepare("UPDATE properties SET updated_at='2026-02-01' WHERE id=1").run();
    expect(() => assertLegacyPropertiesUnchanged(db, before)).toThrow(/Legacy properties mutated/);
  });

  it('keeps the legacy digest fixed across new, unchanged, irrelevant, and media-only shadow ingestion', async () => {
    const before = snapshotLegacyProperties(db);
    installLegacyPropertiesWriteGuard(db);
    let aiCalls = 0;

    class Kh24FixtureAdapter implements SourceAdapter<{ id: string; text: string; photo: string; irrelevant?: boolean }> {
      readonly sourceType = 'KHMER24' as const;
      constructor(private readonly row: { id: string; text: string; photo: string; irrelevant?: boolean }) {}
      async *fetchNewItems(_context: SourceRunContext) { yield this.row; }
      normalize(raw: typeof this.row): NormalizedSourceItem<typeof this.row> {
        const { createHash } = require('node:crypto') as typeof import('node:crypto');
        return {
          sourceIdentity: { sourceType: 'KHMER24', externalSourceId: 'siem-reap', name: 'fixture' },
          externalId: raw.id,
          raw,
          rawText: raw.text,
          contentHash: createHash('sha256').update(raw.text).digest('hex'),
          mediaHash: createHash('sha256').update(raw.photo).digest('hex'),
          classification: raw.irrelevant ? 'IRRELEVANT' : 'HOUSING_SUPPLY',
        };
      }
      async processNewOrChanged(_raw: typeof this.row, normalized: NormalizedSourceItem<typeof this.row>, context: { contentChanged: boolean }) {
        if (context.contentChanged) aiCalls++;
        return normalized;
      }
    }

    const ingestion = createContainer({ db }).ingestionService;
    const context: SourceRunContext = { runType: 'DISCOVERY', ingestionMethod: 'KHMER24_SCRAPER' };
    const first = await ingestion.ingestBatch(new Kh24FixtureAdapter({ id: 'supply-1', text: '2BR Wat Bo rent $400', photo: 'a.jpg' }), context);
    const unchanged = await ingestion.ingestBatch(new Kh24FixtureAdapter({ id: 'supply-1', text: '2BR Wat Bo rent $400', photo: 'a.jpg' }), context);
    const irrelevant = await ingestion.ingestBatch(new Kh24FixtureAdapter({ id: 'irrelevant-1', text: 'motorbike for sale', photo: 'b.jpg', irrelevant: true }), context);
    const mediaOnly = await ingestion.ingestBatch(new Kh24FixtureAdapter({ id: 'supply-1', text: '2BR Wat Bo rent $400', photo: 'a-new.jpg' }), context);

    expect(first.newSourceItems).toBe(1);
    expect(unchanged.unchangedSourceItems).toBe(1);
    expect(irrelevant.classificationCounts.IRRELEVANT).toBe(1);
    expect(mediaOnly.updatedSourceItems).toBe(1);
    expect(aiCalls).toBe(2); // New supply and irrelevant content are classified; unchanged and media-only do not repeat enrichment.
    expect(assertLegacyPropertiesUnchanged(db, before)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) count FROM properties').get()).toEqual({ count: 1 });
  });
});
