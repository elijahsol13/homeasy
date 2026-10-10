import { DatabaseSync } from 'node:sqlite';
import { createContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import type { SourceAdapter, SourceRunContext, NormalizedSourceItem } from '../src/modules/parser/ingestion-contracts';
import { FacebookLiveAdapter } from '../src/modules/parser/live-source-adapters';
import { RepostClusteringService } from '../src/modules/parser/repost-clustering';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';

interface FixturePost { id: string; text: string; }

class FixtureAdapter implements SourceAdapter<FixturePost> {
  readonly sourceType = 'FACEBOOK_GROUP' as const;
  constructor(private readonly post: FixturePost) {}
  async *fetchNewItems(_context: SourceRunContext): AsyncIterable<FixturePost> { yield this.post; }
  normalize(post: FixturePost): NormalizedSourceItem<FixturePost> {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return {
      sourceIdentity: { sourceType: 'FACEBOOK_GROUP', externalSourceId: 'siem-reap-rentals',
        name: 'Siem Reap Rentals', url: 'https://facebook.com/groups/siem-reap-rentals', city: 'siem_reap' },
      externalId: post.id, raw: post, rawText: post.text,
      contentHash: createHash('sha256').update(post.text).digest('hex'),
      classification: 'HOUSING_SUPPLY',
    };
  }
}

describe('IngestionService.ingestBatch', () => {
  let db: DatabaseSync;
  let ingestion: ReturnType<typeof createContainer>['ingestionService'];

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    ingestion = createContainer({ db }).ingestionService;
  });
  afterEach(() => db.close());

  const context = (ingestionMethod: SourceRunContext['ingestionMethod']): SourceRunContext => ({
    runType: 'REPLAY', ingestionMethod, observedAt: '2026-10-07T00:00:00.000Z',
  });

  it('keeps one source item and preserves the previous version after an edit', async () => {
    const first = await ingestion.ingestBatch(new FixtureAdapter({ id: '123', text: 'For rent $400' }), context('REPLAY'));
    const second = await ingestion.ingestBatch(new FixtureAdapter({ id: '123', text: 'For rent $350' }), {
      ...context('REPLAY'), observedAt: '2026-10-07T01:00:00.000Z',
    });
    expect(first.newSourceItems).toBe(1);
    expect(second.updatedSourceItems).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM source_items').get()).toEqual({ count: 1 });
    const versions = db.prepare('SELECT raw_text FROM source_item_versions ORDER BY id').all();
    expect(versions).toEqual([{ raw_text: 'For rent $400' }, { raw_text: 'For rent $350' }]);
    const lastSeen = db.prepare('SELECT last_seen_at FROM source_items').get() as { last_seen_at: string };
    expect(lastSeen.last_seen_at).toBe('2026-10-07T01:00:00.000Z');
  });

  it('keeps bounded discovery writes scoped for five new and five unchanged items', async () => {
    const posts = Array.from({ length: 10 }, (_, index) => ({
      id: `scope-${index + 1}`,
      text: `Apartment for rent $${400 + index} in Wat Bo, Siem Reap, property code SCOPE-${index + 1}`,
    }));
    const adapter = (items: FixturePost[]) => new (class implements SourceAdapter<FixturePost> {
      readonly sourceType = 'FACEBOOK_GROUP' as const;
      async *fetchNewItems(): AsyncIterable<FixturePost> { yield* items; }
      normalize(post: FixturePost) {
        const { createHash } = require('node:crypto') as typeof import('node:crypto');
        return { sourceIdentity: { sourceType: 'FACEBOOK_GROUP' as const, externalSourceId: 'scope-group',
          name: 'Scope Group', url: 'https://facebook.com/groups/scope-group', city: 'siem_reap' as const },
          externalId: post.id, raw: post, rawText: post.text,
          contentHash: createHash('sha256').update(post.text).digest('hex'), classification: 'HOUSING_SUPPLY' as const };
      }
    })();

    await ingestion.ingestBatch(adapter(posts.slice(0, 5)), { ...context('REPLAY'), runType: 'DISCOVERY' });
    const beforeOccurrences = db.prepare(`SELECT source_item_id,listing_id,is_current,updated_at FROM canonical_listing_source_occurrences
      ORDER BY source_item_id`).all();
    const beforeVersions = db.prepare('SELECT source_item_id,COUNT(*) AS n FROM source_item_versions GROUP BY source_item_id ORDER BY source_item_id').all();
    const beforeDecisions = db.prepare('SELECT * FROM dedupe_decisions ORDER BY id').all();
    const beforeLegacy = db.prepare('SELECT COUNT(*) AS n FROM properties').get();

    const result = await ingestion.ingestBatch(adapter(posts), {
      ...context('REPLAY'), runType: 'DISCOVERY', observedAt: '2026-10-08T00:00:00.000Z',
    });

    expect(result.newSourceItems).toBe(5);
    expect(result.unchangedSourceItems).toBe(5);
    expect(result.newVersions).toBe(5);
    expect(result.globalCanonicalRuns).toBe(0);
    expect(result.scopedCanonicalRuns).toBe(1);
    expect(result.mutationReport.unexpectedGlobalWrites).toBe(0);
    expect(db.prepare(`SELECT source_item_id,listing_id,is_current,updated_at FROM canonical_listing_source_occurrences
      WHERE source_item_id<=5 ORDER BY source_item_id`).all()).toEqual(beforeOccurrences);
    expect(db.prepare('SELECT source_item_id,COUNT(*) AS n FROM source_item_versions GROUP BY source_item_id ORDER BY source_item_id').all())
      .toEqual([...beforeVersions, ...Array.from({ length: 5 }, (_, i) => ({ source_item_id: i + 6, n: 1 }))]);
    expect(db.prepare('SELECT * FROM dedupe_decisions ORDER BY id').all()).toEqual(beforeDecisions);
    expect(db.prepare('SELECT COUNT(*) AS n FROM properties').get()).toEqual(beforeLegacy);

    const beforeCanonical = {
      properties: db.prepare('SELECT COUNT(*) AS n FROM canonical_properties').get(),
      listings: db.prepare('SELECT COUNT(*) AS n FROM canonical_listings').get(),
      occurrences: db.prepare('SELECT COUNT(*) AS n FROM canonical_listing_source_occurrences').get(),
    };
    const identical = await ingestion.ingestBatch(adapter(posts), {
      ...context('REPLAY'), runType: 'DISCOVERY', observedAt: '2026-10-09T00:00:00.000Z',
    });
    expect(identical.newSourceItems).toBe(0);
    expect(identical.updatedSourceItems).toBe(0);
    expect(identical.unchangedSourceItems).toBe(10);
    expect(identical.newVersions).toBe(0);
    expect(identical.scopedCanonicalRuns).toBe(0);
    expect(identical.mutationReport.directWrites.identifierSetsReplaced).toBe(0);
    expect(db.prepare('SELECT * FROM dedupe_decisions ORDER BY id').all()).toEqual(beforeDecisions);
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_item_versions').get()).toEqual({ n: 10 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_properties').get()).toEqual(beforeCanonical.properties);
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_listings').get()).toEqual(beforeCanonical.listings);
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_listing_source_occurrences').get()).toEqual(beforeCanonical.occurrences);
    expect(db.prepare('SELECT DISTINCT last_seen_at FROM canonical_listing_source_occurrences').all())
      .toEqual([{ last_seen_at: '2026-10-09T00:00:00.000Z' }]);
  });

  it('rolls back source, version, identifier, repost, and canonical writes when atomic reconciliation fails', async () => {
    const failOnce = jest.spyOn(CanonicalShadowService.prototype, 'reconcileSourceItemsScoped')
      .mockImplementationOnce(() => { throw new Error('simulated scoped reconciliation failure'); });
    await expect(ingestion.ingestBatch(new FixtureAdapter({ id: 'atomic-1',
      text: '2BR apartment Wat Bo for rent $400 monthly property code ATOMIC-1' }), {
      ...context('BRIGHTDATA'), runType: 'DISCOVERY', atomicDbStage: true,
    })).rejects.toThrow('simulated scoped reconciliation failure');
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_items').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_item_versions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_item_identifiers').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM dedupe_clusters').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_properties').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_listings').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_listing_source_occurrences').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM processing_runs').get()).toEqual({ n: 0 });
    failOnce.mockRestore();
  });

  it('returns mutation diagnostics and rolls back an unexpected alias write', async () => {
    await ingestion.ingestBatch(new FixtureAdapter({ id: 'guard-existing', text: 'Apartment for rent $700 in Wat Bo, property code EXISTING-1' }), {
      ...context('REPLAY'), runType: 'DISCOVERY',
    });
    const unrelatedListing = (db.prepare('SELECT id FROM canonical_listings').get() as { id: number }).id;
    const unrelatedSourceItem = (db.prepare("SELECT id FROM source_items WHERE external_id='guard-existing'").get() as { id: number }).id;
    const prototype = CanonicalShadowService.prototype as unknown as { persist: (...args: any[]) => unknown };
    const originalPersist = prototype.persist;
    const guardSpy = jest.spyOn(prototype, 'persist').mockImplementation(function (this: CanonicalShadowService, ...args: any[]) {
      const result = originalPersist.apply(this, args);
      db.prepare(`INSERT INTO canonical_listing_aliases(namespace,alias,listing_id)
        VALUES('public_listing_ref','unexpected-guard-alias',?)`).run(unrelatedListing);
      db.prepare(`INSERT INTO dedupe_decisions(candidate_a_type,candidate_a_id,candidate_b_type,candidate_b_id,
        decision,property_score,listing_score,reasons_json,details_json,algorithm_version)
        VALUES('SOURCE_ITEM',?, 'SOURCE_ITEM',999999,'DIFFERENT_PROPERTY',0,0,'[]','{}','canonical-dedupe-v1')`).run(unrelatedSourceItem);
      db.prepare(`INSERT INTO media_assets(source_item_id,source_url,normalized_url,first_seen_at,last_seen_at)
        VALUES(?,?,?,?,?)`).run(unrelatedSourceItem,'https://media.example/unexpected.jpg','https://media.example/unexpected.jpg',
          '2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z');
      const mediaId = (db.prepare("SELECT id FROM media_assets WHERE normalized_url='https://media.example/unexpected.jpg'").get() as { id: number }).id;
      db.prepare(`INSERT INTO media_asset_source_occurrences(media_asset_id,source_item_id,listing_id,property_id)
        VALUES(?,?,?,(SELECT property_id FROM canonical_listings WHERE id=?))`).run(mediaId,unrelatedSourceItem,unrelatedListing,unrelatedListing);
      return result;
    });

    let caught: unknown;
    try {
      await ingestion.ingestBatch(new FixtureAdapter({ id: 'guard-target', text: 'Room for rent $250 in Sla Kram, property code TARGET-2' }), {
        ...context('REPLAY'), runType: 'DISCOVERY', atomicDbStage: true,
      });
    } catch (error) { caught = error; }

    expect(caught).toMatchObject({ name: 'ScopedMutationViolationError' });
    expect((caught as { report?: { unexpectedWrites?: Array<{ table: string; key: string }> } }).report?.unexpectedWrites)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'canonical_listing_aliases', key: 'public_listing_ref:unexpected-guard-alias' }),
        expect.objectContaining({ table: 'dedupe_decisions' }),
        expect.objectContaining({ table: 'media_assets' }),
        expect.objectContaining({ table: 'media_asset_source_occurrences' }),
      ]));
    expect(db.prepare("SELECT COUNT(*) AS n FROM canonical_listing_aliases WHERE alias='unexpected-guard-alias'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM dedupe_decisions WHERE candidate_b_id=999999").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE normalized_url='https://media.example/unexpected.jpg'").get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM media_asset_source_occurrences mo JOIN media_assets ma ON ma.id=mo.media_asset_id
      WHERE ma.normalized_url='https://media.example/unexpected.jpg'`).get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_items WHERE external_id='guard-target'").get()).toEqual({ n: 0 });
    guardSpy.mockRestore();
  });

  it('detects an unrelated listing mutation during bound reconciliation and rolls back the batch', async () => {
    const target = new FixtureAdapter({ id: 'bound-target', text: 'Apartment for rent $700 in Wat Bo, property code BOUND-1' });
    const unrelated = new FixtureAdapter({ id: 'bound-unrelated', text: 'House for rent $1200 in Sla Kram, property code BOUND-2' });
    await ingestion.ingestBatch(target, { ...context('REPLAY'), runType: 'DISCOVERY' });
    await ingestion.ingestBatch(unrelated, { ...context('REPLAY'), runType: 'DISCOVERY' });
    const unrelatedListing = (db.prepare(`SELECT o.listing_id AS id FROM canonical_listing_source_occurrences o
      JOIN source_items s ON s.id=o.source_item_id WHERE s.external_id='bound-unrelated' AND o.is_current=1`).get() as { id: number }).id;
    const beforeTitle = (db.prepare('SELECT title FROM canonical_listings WHERE id=?').get(unrelatedListing) as { title: string }).title;
    const beforeVersions = db.prepare("SELECT COUNT(*) AS n FROM source_item_versions WHERE source_item_id=(SELECT id FROM source_items WHERE external_id='bound-target')").get();
    const originalBound = CanonicalShadowService.prototype.reconcileBoundSourceItems;
    const boundSpy = jest.spyOn(CanonicalShadowService.prototype, 'reconcileBoundSourceItems').mockImplementation(function (this: CanonicalShadowService, sourceItemIds, observedAt) {
      const result = originalBound.call(this, sourceItemIds, observedAt);
      db.prepare("UPDATE canonical_listings SET title='unrelated guard mutation' WHERE id=?").run(unrelatedListing);
      return result;
    });

    let caught: unknown;
    try {
      await ingestion.ingestBatch(new FixtureAdapter({ id: 'bound-target', text: 'Apartment for rent $650 in Wat Bo, property code BOUND-1' }), {
        ...context('REPLAY'), runType: 'DISCOVERY', atomicDbStage: true,
      });
    } catch (error) { caught = error; }

    expect(caught).toMatchObject({ name: 'ScopedMutationViolationError' });
    expect((caught as { report?: { unexpectedWrites?: Array<{ table: string; key: string }> } }).report?.unexpectedWrites)
      .toEqual(expect.arrayContaining([expect.objectContaining({ table: 'canonical_listings', key: String(unrelatedListing) })]));
    expect(db.prepare('SELECT title FROM canonical_listings WHERE id=?').get(unrelatedListing)).toEqual({ title: beforeTitle });
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_item_versions WHERE source_item_id=(SELECT id FROM source_items WHERE external_id='bound-target')").get())
      .toEqual(beforeVersions);
    boundSpy.mockRestore();
  });

  it.each(['occurrence', 'alias', 'moderation', 'media association', 'canonical listing', 'canonical property'] as const)(
    'rejects an unrelated pre-existing %s row reassigned into the batch scope', async (kind) => {
      await ingestion.ingestBatch(new FixtureAdapter({ id: `scope-unrelated-${kind}`,
        text: `House for rent $1200 in Sla Kram, property code UNRELATED-${kind}` }), {
        ...context('REPLAY'), runType: 'DISCOVERY',
      });
      const unrelated = db.prepare(`SELECT s.id AS source_item_id,o.id AS occurrence_id,o.listing_id,l.property_id,p.canonical_key AS property_key
        FROM source_items s JOIN canonical_listing_source_occurrences o ON o.source_item_id=s.id AND o.is_current=1
        JOIN canonical_listings l ON l.id=o.listing_id JOIN canonical_properties p ON p.id=l.property_id
        WHERE s.external_id=?`).get(`scope-unrelated-${kind}`) as {
          source_item_id:number;occurrence_id:number;listing_id:number;property_id:number;property_key:string;
        };
      const unrelatedAlias = `scope-unrelated-alias-${kind}`;
      db.prepare(`INSERT INTO canonical_listing_aliases(namespace,alias,listing_id) VALUES('public_listing_ref',?,?)`)
        .run(unrelatedAlias, unrelated.listing_id);
      const mediaId = Number(db.prepare(`INSERT INTO media_assets(source_item_id,source_url,normalized_url,first_seen_at,last_seen_at)
        VALUES(?,?,?,?,?)`).run(unrelated.source_item_id, `https://media.example/${kind}.jpg`, `https://media.example/${kind}.jpg`,
          '2026-10-01T00:00:00Z','2026-10-01T00:00:00Z').lastInsertRowid);
      const mediaAssociationId = Number(db.prepare(`INSERT INTO media_asset_source_occurrences(media_asset_id,source_item_id,listing_id,property_id)
        VALUES(?,?,?,?)`).run(mediaId, unrelated.source_item_id, unrelated.listing_id, unrelated.property_id).lastInsertRowid);
      const prototype = CanonicalShadowService.prototype as unknown as { persist: (...args: any[]) => unknown };
      const originalPersist = prototype.persist;
      const relinkSpy = jest.spyOn(prototype, 'persist').mockImplementation(function (this: CanonicalShadowService, ...args: any[]) {
        const persisted = originalPersist.apply(this, args);
        const targetSource = db.prepare("SELECT id FROM source_items WHERE external_id='scope-target'").get() as { id: number };
        const target = db.prepare(`SELECT o.listing_id,l.property_id FROM canonical_listing_source_occurrences o
          JOIN canonical_listings l ON l.id=o.listing_id WHERE o.source_item_id=? AND o.is_current=1`).get(targetSource.id) as {
            listing_id:number;property_id:number;
          };
        const targetProperty = db.prepare('SELECT canonical_key FROM canonical_properties WHERE id=?').get(target.property_id) as { canonical_key:string };
        if (kind === 'occurrence') db.prepare('UPDATE canonical_listing_source_occurrences SET listing_id=? WHERE id=?')
          .run(target.listing_id, unrelated.occurrence_id);
        if (kind === 'alias') db.prepare("UPDATE canonical_listing_aliases SET listing_id=? WHERE namespace='public_listing_ref' AND alias=?")
          .run(target.listing_id, unrelatedAlias);
        if (kind === 'moderation') {
          db.prepare('DELETE FROM canonical_listing_moderation WHERE listing_id=?').run(target.listing_id);
          db.prepare('UPDATE canonical_listing_moderation SET listing_id=? WHERE listing_id=?')
            .run(target.listing_id, unrelated.listing_id);
        }
        if (kind === 'media association') db.prepare('UPDATE media_asset_source_occurrences SET listing_id=?,property_id=?,source_item_id=? WHERE id=?')
          .run(target.listing_id, target.property_id, targetSource.id, mediaAssociationId);
        if (kind === 'canonical listing') db.prepare('UPDATE canonical_listings SET property_id=? WHERE id=?')
          .run(target.property_id, unrelated.listing_id);
        if (kind === 'canonical property') {
          db.prepare('UPDATE canonical_properties SET canonical_key=? WHERE id=?').run(`${targetProperty.canonical_key}-temporary`, target.property_id);
          db.prepare('UPDATE canonical_properties SET canonical_key=? WHERE id=?').run(targetProperty.canonical_key, unrelated.property_id);
        }
        return persisted;
      });
      let caught: unknown;
      try {
        await ingestion.ingestBatch(new FixtureAdapter({ id: 'scope-target',
          text: 'Apartment for rent $350 in Wat Bo, property code SCOPE-TARGET' }), {
          ...context('REPLAY'), runType: 'DISCOVERY', atomicDbStage: true,
        });
      } catch (error) { caught = error; }
      expect(caught).toMatchObject({ name: 'ScopedMutationViolationError' });
      expect(db.prepare("SELECT COUNT(*) AS n FROM source_items WHERE external_id='scope-target'").get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE id=?').get(unrelated.occurrence_id))
        .toEqual({ listing_id: unrelated.listing_id });
      expect(db.prepare("SELECT listing_id FROM canonical_listing_aliases WHERE namespace='public_listing_ref' AND alias=?").get(unrelatedAlias))
        .toEqual({ listing_id: unrelated.listing_id });
      expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_listing_moderation WHERE listing_id=?').get(unrelated.listing_id))
        .toEqual({ n: 1 });
      expect(db.prepare('SELECT listing_id,property_id,source_item_id FROM media_asset_source_occurrences WHERE id=?').get(mediaAssociationId))
        .toEqual({ listing_id: unrelated.listing_id, property_id: unrelated.property_id, source_item_id: unrelated.source_item_id });
      expect(db.prepare('SELECT property_id FROM canonical_listings WHERE id=?').get(unrelated.listing_id))
        .toEqual({ property_id: unrelated.property_id });
      expect(db.prepare('SELECT canonical_key FROM canonical_properties WHERE id=?').get(unrelated.property_id))
        .toEqual({ canonical_key: unrelated.property_key });
      relinkSpy.mockRestore();
    });

  it('resolves one Facebook group to the same source across Bright Data and Camoufox methods', async () => {
    await ingestion.ingestBatch(new FixtureAdapter({ id: 'a', text: 'House for rent' }), context('BRIGHTDATA'));
    await ingestion.ingestBatch(new FixtureAdapter({ id: 'b', text: 'Apartment for rent' }), context('CAMOUFOX'));
    expect(db.prepare('SELECT COUNT(*) count FROM source_registry').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) count FROM processing_run_sources').get()).toEqual({ count: 2 });
  });

  it('dry-run validates and counts without changing the database', async () => {
    const before = db.prepare('SELECT COUNT(*) count FROM source_registry').get();
    const result = await ingestion.ingestBatch(new FixtureAdapter({ id: 'x', text: 'Phone: 012 345 678' }), {
      ...context('REPLAY'), dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.newSourceItems).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM source_registry').get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) count FROM processing_runs').get()).toEqual({ count: 0 });
  });

  it('skips live AI processing on unchanged discovery while refreshing last_seen', async () => {
    let processCalls = 0;
    const fetcher = async function* () {
      yield { sourceId: 'group-1', sourceName: 'Group 1', groupId: 'group-1', groupName: 'Group 1',
        listing: { title: '2BR apartment Wat Bo', description: 'For rent $400 monthly', raw_text: 'For rent $400 monthly',
          source_url: 'https://facebook.com/groups/group-1/posts/123', city: 'siem_reap', photos: ['https://img.example/a.jpg'] } };
    };
    const adapter = new FacebookLiveAdapter(fetcher, async (_raw, item) => {
      processCalls++;
      return { ...item, aiResults: [{ stage: 'SUPPLY_EXTRACTION', provider: 'fixture', model: 'fixture-v1',
        fallbackDepth: 0, promptVersion: 'listing-v1', success: true, latencyMs: 5 }] };
    });
    const first = await ingestion.ingestBatch(adapter, { runType: 'DISCOVERY', ingestionMethod: 'BRIGHTDATA', observedAt: '2026-10-07T00:00:00Z' });
    const second = await ingestion.ingestBatch(adapter, { runType: 'DISCOVERY', ingestionMethod: 'BRIGHTDATA', observedAt: '2026-10-08T00:00:00Z' });
    expect(processCalls).toBe(1);
    expect(first.newSourceItems).toBe(1);
    expect(second.unchangedSourceItems).toBe(1);
    expect(second.providerCounts).toEqual({});
    expect(db.prepare('SELECT COUNT(*) count FROM ai_processing_results').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) count FROM source_item_versions').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT last_seen_at FROM source_items').get()).toEqual({ last_seen_at: '2026-10-08T00:00:00Z' });
    expect(db.prepare('SELECT COUNT(*) count FROM external_provider_usage').get()).toEqual({ count: 2 });
  });

  it('uses natural rediscovery as last_seen evidence without changing availability confirmation', async () => {
    const adapters = [new FixtureAdapter({ id: 'natural-63', text: 'Apartment for rent $400 in Wat Bo, code NATURAL-63' }),
      new FixtureAdapter({ id: 'natural-140', text: 'House for rent $900 in Sla Kram, code NATURAL-140' })];
    for (const adapter of adapters) await ingestion.ingestBatch(adapter, {
      runType: 'DISCOVERY', ingestionMethod: 'BRIGHTDATA', observedAt: '2026-10-01T00:00:00Z',
    });
    const rows = db.prepare(`SELECT s.id AS source_item_id,o.id AS occurrence_id,o.listing_id FROM source_items s
      JOIN canonical_listing_source_occurrences o ON o.source_item_id=s.id AND o.is_current=1 ORDER BY s.external_id`).all() as
      Array<{ source_item_id: number; occurrence_id: number; listing_id: number }>;
    expect(rows).toHaveLength(2);
    for (const [index, row] of rows.entries()) {
      const occurrenceId = index === 0 ? 63 : 140;
      db.prepare('UPDATE canonical_listing_source_occurrences SET id=? WHERE id=?').run(occurrenceId, row.occurrence_id);
      db.prepare(`UPDATE canonical_listing_source_occurrences SET consecutive_terminal_checks=1,
        terminal_check_last_seen_at='2026-10-06T00:00:00Z',terminal_check_confirm_after_at='2026-10-07T06:00:00Z',
        next_check_at='2026-10-07T06:00:00Z' WHERE id=?`).run(occurrenceId);
      db.prepare("UPDATE canonical_listings SET availability_status='available',availability_last_confirmed_at='2026-09-30T00:00:00Z' WHERE id=?").run(row.listing_id);
    }
    for (const adapter of adapters) await ingestion.ingestBatch(adapter, {
      runType: 'DISCOVERY', ingestionMethod: 'BRIGHTDATA', observedAt: '2026-10-07T00:00:00Z',
    });
    for (const row of rows) {
      expect(db.prepare('SELECT last_seen_at,availability_last_confirmed_at FROM canonical_listings WHERE id=?').get(row.listing_id))
        .toEqual({ last_seen_at: '2026-10-07T00:00:00Z', availability_last_confirmed_at: '2026-09-30T00:00:00Z' });
      expect(db.prepare(`SELECT consecutive_terminal_checks,terminal_check_last_seen_at,terminal_check_confirm_after_at,next_check_at
        FROM canonical_listing_source_occurrences WHERE id=?`).get(row.occurrence_id === rows[0]!.occurrence_id ? 63 : 140)).toEqual({
        consecutive_terminal_checks: 0, terminal_check_last_seen_at: null,
        terminal_check_confirm_after_at: null, next_check_at: null,
      });
    }
  });

  it('updates media-only state and history without repeating AI extraction', async () => {
    let processCalls = 0;
    const fetcher = async function* (photo: string) {
      yield { sourceId: 'group-media', sourceName: 'Media Group', groupId: 'group-media',
        listing: { title: '2BR apartment Wat Bo', description: 'For rent $400 monthly', raw_text: 'For rent $400 monthly',
          source_url: 'https://facebook.com/groups/group-media/posts/777', city: 'siem_reap', photos: [photo] } };
    };
    const adapter = (photo: string) => new FacebookLiveAdapter((ctx) => fetcher(photo), async (_raw, item) => {
      processCalls++;
      return { ...item, raw: { ...(item.raw as object), preservedExtraction: { bedrooms: 2 } } as unknown as typeof item.raw,
        aiResults: [{ stage: 'SUPPLY_EXTRACTION', provider: 'fixture', model: 'fixture-v1', success: true }] };
    });
    await ingestion.ingestBatch(adapter('https://img.example/old.jpg'), { ...context('BRIGHTDATA'), runType: 'DISCOVERY' });
    const changed = await ingestion.ingestBatch(adapter('https://img.example/new.jpg'), {
      ...context('BRIGHTDATA'), runType: 'DISCOVERY', observedAt: '2026-10-08T00:00:00Z',
    });
    expect(processCalls).toBe(1);
    expect(changed.updatedSourceItems).toBe(1);
    expect(db.prepare('SELECT media_hash FROM source_items').get()).not.toEqual({ media_hash: null });
    expect(db.prepare("SELECT COUNT(*) count FROM source_item_versions").get()).toEqual({ count: 2 });
    const payload = JSON.parse((db.prepare('SELECT raw_payload_json FROM source_items').get() as { raw_payload_json: string }).raw_payload_json);
    expect(payload.photos).toEqual(['https://img.example/new.jpg']);
    expect(payload.preservedExtraction).toEqual({ bedrooms: 2 });
    expect(changed.incrementalCanonicalItems).toBe(1);
    expect(db.prepare(`SELECT ma.normalized_url FROM media_asset_source_occurrences mo JOIN media_assets ma ON ma.id=mo.media_asset_id
      WHERE mo.source_item_id=(SELECT id FROM source_items WHERE external_id='777')`).all()).toEqual([{normalized_url:'https://img.example/new.jpg'}]);
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_properties').get()).toEqual({n:1});
    expect(db.prepare('SELECT COUNT(*) n FROM canonical_listings').get()).toEqual({n:1});
  });

  it('marks explicit rented edits as availability evidence and keeps source history', async () => {
    const first = new FixtureAdapter({ id: 'availability-1', text: 'For rent $400 Wat Bo' });
    await ingestion.ingestBatch(first, { ...context('REPLAY'), runType: 'DISCOVERY' });
    const source = db.prepare('SELECT id,source_registry_id FROM source_items').get() as { id: number; source_registry_id: number };
    const listingId=(db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1').get(source.id) as {listing_id:number}).listing_id;
    db.prepare("UPDATE canonical_listings SET availability_status='available' WHERE id=?").run(listingId);
    await ingestion.ingestBatch(new FixtureAdapter({ id: 'availability-1', text: 'RENTED — this unit is no longer available' }), {
      ...context('REPLAY'), runType: 'DISCOVERY', observedAt: '2026-10-08T00:00:00Z',
    });
    expect(db.prepare('SELECT availability_status,availability_last_confirmed_at FROM canonical_listings WHERE id=?').get(listingId))
      .toEqual({ availability_status: 'rented', availability_last_confirmed_at: '2026-10-08T00:00:00Z' });
    expect(db.prepare('SELECT availability_signal FROM canonical_listing_source_occurrences WHERE source_item_id=?').get(source.id))
      .toEqual({ availability_signal: 'unavailable' });
    expect(db.prepare('SELECT check_type,result FROM availability_checks WHERE listing_id=?').get(listingId))
      .toEqual({ check_type: 'CONTENT_CHANGE', result: 'UNAVAILABLE' });
    expect(db.prepare('SELECT COUNT(*) count FROM source_item_versions WHERE source_item_id=?').get(source.id)).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_properties').get()).toEqual({ count: 1 });
    await ingestion.ingestBatch(new FixtureAdapter({ id: 'availability-1', text: 'AVAILABLE now — same Wat Bo unit' }), {
      ...context('REPLAY'), runType: 'DISCOVERY', observedAt: '2026-10-20T00:00:00Z',
    });
    expect(db.prepare('SELECT availability_status,availability_last_confirmed_at FROM canonical_listings WHERE id=?').get(listingId))
      .toEqual({ availability_status: 'available', availability_last_confirmed_at: '2026-10-20T00:00:00Z' });
    expect(db.prepare('SELECT availability_signal FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1').get(source.id))
      .toEqual({ availability_signal: 'available' });
    expect(db.prepare('SELECT result,new_status FROM availability_checks WHERE listing_id=? ORDER BY id').all(listingId))
      .toEqual([{ result: 'UNAVAILABLE', new_status: 'rented' }, { result: 'ALIVE', new_status: 'available' }]);
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_properties').get()).toEqual({ count: 1 });
  });

  it('ingests a new repost into the existing repost cluster and canonical Listing', async () => {
    const fetcher = async function* (externalId: string) {
      yield { sourceId:'fb-repost-group',sourceName:'FB Reposts',groupId:'fb-repost-group',groupName:'FB Reposts',
        listing:{title:'2BR apartment Wat Bo',description:'For rent $400 monthly, property code WAT-42, phone 012 345 678',
          raw_text:'2BR apartment Wat Bo for rent $400 monthly property code WAT-42 phone 012 345 678',
          source_url:`https://facebook.com/groups/fb-repost-group/posts/${externalId}`,city:'siem_reap',photos:['https://img.example/repost.jpg'],
          price:400,currency:'USD',category:'apartment',property_type:'Apartment',bedrooms:2,location:'Wat Bo',
          listing_facts_json:JSON.stringify({title_en:'2BR apartment Wat Bo',description_en:'For rent $400 monthly',price:400,currency:'USD',
            category:'apartment',property_type:'Apartment',bedrooms:2,city:'siem_reap',sangkat:'Wat Bo',offer_type:'rent'})}};
    };
    const adapter = (id:string) => new FacebookLiveAdapter(() => fetcher(id));
    const first=await ingestion.ingestBatch(adapter('post-a'),{...context('BRIGHTDATA'),runType:'DISCOVERY'});
    const second=await ingestion.ingestBatch(adapter('post-b'),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-08T00:00:00Z'});
    expect(first.globalCanonicalRuns).toBe(0);
    expect(first.scopedCanonicalRuns).toBe(1);
    expect(second.incrementalRepostItems).toBe(1);
    expect(second.occurrencesAttached).toBe(1);
    expect(second.globalCanonicalRuns).toBe(0);
    expect(second.scopedCanonicalRuns).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM source_items').get()).toEqual({count:2});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_properties').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listings').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:2});
    const repeat=await ingestion.ingestBatch(adapter('post-b'),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-09T00:00:00Z'});
    expect(repeat.unchangedSourceItems).toBe(1);
    expect(repeat.incrementalRepostItems).toBe(0);
    expect(repeat.incrementalCanonicalItems).toBe(0);
    expect(repeat.globalCanonicalRuns).toBe(0);
    expect(repeat.scopedCanonicalRuns).toBe(0);
    expect(repeat.newVersions).toBe(0);
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:2});
  });

  it('keeps a changed price on its existing canonical binding through the complete ingestion path', async () => {
    let extractionCalls=0;
    const fetcher = async function* (price:number) {
      yield {sourceId:'fb-price-group',sourceName:'Price Group',groupId:'fb-price-group',groupName:'Price Group',
        listing:{title:'2BR apartment Wat Bo',description:`For rent $${price} monthly`,raw_text:`2BR apartment Wat Bo for rent $${price} monthly`,
          source_url:'https://facebook.com/groups/fb-price-group/posts/price-123',city:'siem_reap',price,currency:'USD',category:'apartment',property_type:'Apartment',bedrooms:2,
          photos:[],location:'Wat Bo',listing_facts_json:JSON.stringify({title_en:'2BR apartment Wat Bo',description_en:`For rent $${price} monthly`,price,currency:'USD',
            category:'apartment',property_type:'Apartment',bedrooms:2,city:'siem_reap',sangkat:'Wat Bo',offer_type:'rent'})}};
    };
    const adapter=(price:number)=>new FacebookLiveAdapter(()=>fetcher(price),async(_raw,item)=>{
      extractionCalls++;
      return {...item,aiResults:[{stage:'SUPPLY_EXTRACTION',provider:'fixture',model:'fixture-v1',success:true}]};
    });
    await ingestion.ingestBatch(adapter(400),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-01T00:00:00Z'});
    const before=db.prepare(`SELECT o.id occurrence_id,o.listing_id,l.property_id,l.price FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.is_current=1`).get() as {occurrence_id:number;listing_id:number;property_id:number;price:number};
    const changed=await ingestion.ingestBatch(adapter(350),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-02T00:00:00Z'});
    const after=db.prepare(`SELECT o.id occurrence_id,o.listing_id,l.property_id,l.price,o.price_seen,o.last_seen_at FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.is_current=1`).get();
    expect(extractionCalls).toBe(2);
    expect(changed.updatedSourceItems).toBe(1);
    expect(changed.canonicalBindingsUpdated).toBe(1);
    expect(changed.globalCanonicalRuns).toBe(0);
    expect(after).toEqual({...before,price:35000,price_seen:35000,last_seen_at:'2026-10-02T00:00:00Z'});
    expect(db.prepare('SELECT COUNT(*) count FROM source_items').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM source_item_versions').get()).toEqual({count:2});
    const repeated=await ingestion.ingestBatch(adapter(350),{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-03T00:00:00Z'});
    expect(repeated.unchangedSourceItems).toBe(1);
    expect(repeated.newVersions).toBe(0);
    expect(repeated.incrementalRepostItems).toBe(0);
    expect(repeated.incrementalCanonicalItems).toBe(0);
    expect(repeated.globalCanonicalRuns).toBe(0);
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:1});
  });

  it('recovers after an interruption immediately after SourceItem persistence', async () => {
    const fetcher=async function*(){yield {sourceId:'recovery-group',sourceName:'Recovery',groupId:'recovery-group',groupName:'Recovery',
      listing:{title:'2BR apartment Wat Bo',description:'For rent $400 monthly',raw_text:'2BR apartment Wat Bo for rent $400 monthly',
        source_url:'https://facebook.com/groups/recovery-group/posts/1',city:'siem_reap',photos:[]}};};
    const adapter=new FacebookLiveAdapter(fetcher);
    const failOnce=jest.spyOn(RepostClusteringService.prototype,'runIncremental').mockImplementationOnce(()=>{throw new Error('simulated interruption');});
    const first=await ingestion.ingestBatch(adapter,{...context('BRIGHTDATA'),runType:'DISCOVERY'});
    expect(first.errors).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) count FROM source_items').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM dedupe_cluster_members').get()).toEqual({count:0});
    const retried=await ingestion.ingestBatch(adapter,{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-08T00:00:00Z'});
    expect(retried.unchangedSourceItems).toBe(1);
    expect(retried.incrementalRepostItems).toBe(1);
    expect(retried.globalCanonicalRuns).toBe(0);
    expect(retried.scopedCanonicalRuns).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM dedupe_cluster_members').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:1});
    failOnce.mockRestore();
  });

  it('recovers after repost assignment when canonical occurrence materialization is interrupted', async () => {
    const fetcher=async function*(){yield {sourceId:'canonical-recovery',sourceName:'Canonical Recovery',groupId:'canonical-recovery',groupName:'Canonical Recovery',
      listing:{title:'2BR apartment Wat Bo',description:'For rent $400 monthly',raw_text:'2BR apartment Wat Bo for rent $400 monthly',
        source_url:'https://facebook.com/groups/canonical-recovery/posts/1',city:'siem_reap',photos:[]}};};
    const adapter=new FacebookLiveAdapter(fetcher);
    const failOnce=jest.spyOn(CanonicalShadowService.prototype,'reconcileSourceItemsScoped').mockImplementationOnce(()=>{throw new Error('simulated occurrence interruption');});
    await expect(ingestion.ingestBatch(adapter,{...context('BRIGHTDATA'),runType:'DISCOVERY'})).rejects.toThrow('simulated occurrence interruption');
    expect(db.prepare('SELECT COUNT(*) count FROM dedupe_cluster_members').get()).toEqual({count:1});
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:0});
    const retry=await ingestion.ingestBatch(adapter,{...context('BRIGHTDATA'),runType:'DISCOVERY',observedAt:'2026-10-08T00:00:00Z'});
    expect(retry.unchangedSourceItems).toBe(1);
    expect(retry.incrementalRepostItems).toBe(0);
    expect(retry.globalCanonicalRuns).toBe(0);
    expect(retry.scopedCanonicalRuns).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM canonical_listing_source_occurrences WHERE is_current=1').get()).toEqual({count:1});
    failOnce.mockRestore();
  });
});
