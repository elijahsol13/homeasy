import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { SourceIngestionRepository } from '../src/database/repositories/source-ingestion.repo';
import { RepostClusteringService } from '../src/modules/parser/repost-clustering';

describe('RepostClusteringService', () => {
  let db: DatabaseSync;
  let sources: SourceIngestionRepository;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    sources = new SourceIngestionRepository(db);
    const groups = [
      sources.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'group-a', name: 'Group A' }),
      sources.upsertSource({ sourceType: 'FACEBOOK_GROUP', externalSourceId: 'group-b', name: 'Group B' }),
    ];
    const items = [
      {
        source: groups[0]!, id: 'supply-a', text: '2BR apartment in Wat Bo for rent at $350. Property code: DV123. Phone 012 345 678.',
        hash: 'original-a', group: 'Group A', author: 'https://facebook.com/profile.php?id=777', classification: 'HOUSING_SUPPLY' as const,
        ids: [
          { type: 'PROPERTY_CODE' as const, normalizedValue: 'DV123' },
          { type: 'PHONE' as const, normalizedValue: '+85512345678' },
        ],
      },
      {
        source: groups[1]!, id: 'supply-b', text: '2BR apartment in Wat Bo for rent at $350. Property code DV123. Phone +855 12 345 678.',
        hash: 'original-b', group: 'Group B', author: 'https://facebook.com/profile.php?id=777', classification: 'HOUSING_SUPPLY' as const,
        ids: [
          { type: 'PROPERTY_CODE' as const, normalizedValue: 'DV123' },
          { type: 'PHONE' as const, normalizedValue: '+85512345678' },
        ],
      },
      {
        source: groups[0]!, id: 'supply-c', text: '1BR wooden house near Wat Damnak. $500 monthly, furnished with garden and parking.',
        hash: 'original-c', group: 'Group A', author: 'https://facebook.com/profile.php?id=777', classification: 'HOUSING_SUPPLY' as const,
        ids: [{ type: 'PHONE' as const, normalizedValue: '+85512345678' }],
      },
      {
        source: groups[0]!, id: 'demand-a', text: 'Looking for an apartment under $300 with two bedrooms for a family.',
        hash: 'demand-a', group: 'Group A', author: 'https://facebook.com/profile.php?id=111', classification: 'HOUSING_DEMAND' as const, ids: [],
      },
      {
        source: groups[1]!, id: 'demand-b', text: 'Looking for an apartment under $300 with two bedrooms for a family.',
        hash: 'demand-b', group: 'Group B', author: 'https://facebook.com/profile.php?id=222', classification: 'HOUSING_DEMAND' as const, ids: [],
      },
    ];
    for (const item of items) {
      const result = sources.upsertSourceItemDetailed(item.source, {
        sourceType: 'FACEBOOK_GROUP', externalId: item.id, rawText: item.text, contentHash: item.hash,
        rawPayload: { imageUrls: [] }, groupId: item.group, groupName: item.group,
        authorExternalId: item.author, publishedAt: '2026-10-06T10:00:00Z', classification: item.classification,
      });
      sources.replaceIdentifiers(result.id, item.ids.map((identifier) => ({ ...identifier, rawValue: identifier.normalizedValue })));
    }
  });

  afterEach(() => db.close());

  it('clusters reposts, keeps different listings from a shared agent separate, and preserves demand identity', () => {
    const service = new RepostClusteringService(db);
    const preview = service.run('repost-v1', { dryRun: true });
    expect(preview.entities.SUPPLY_REPOST).toMatchObject({
      sourceItems: 3, clusters: 2, singletonClusters: 1, multiMemberClusters: 1, postsCollapsed: 1,
    });
    expect(preview.entities.DEMAND_REPOST).toMatchObject({ sourceItems: 2, clusters: 2, multiMemberClusters: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM dedupe_clusters').get()).toEqual({ count: 0 });

    const committed = service.run('repost-v1', { dryRun: false });
    expect(committed.entities.SUPPLY_REPOST.postsCollapsed).toBe(1);
    expect(committed.entities.DEMAND_REPOST.postsCollapsed).toBe(0);
    const clusterRows = db.prepare(`
      SELECT c.id, c.cluster_key, c.representative_source_item_id, group_concat(m.source_item_id, ',') AS members
      FROM dedupe_clusters c JOIN dedupe_cluster_members m ON m.cluster_id=c.id
      GROUP BY c.id ORDER BY c.entity_type, c.cluster_key
    `).all();
    const itemCount = db.prepare('SELECT COUNT(*) AS count FROM source_items').get();
    const versionCount = db.prepare('SELECT COUNT(*) AS count FROM source_item_versions').get();
    const rerun = new RepostClusteringService(db).run('repost-v1', { dryRun: false });
    const rerunRows = db.prepare(`
      SELECT c.id, c.cluster_key, c.representative_source_item_id, group_concat(m.source_item_id, ',') AS members
      FROM dedupe_clusters c JOIN dedupe_cluster_members m ON m.cluster_id=c.id
      GROUP BY c.id ORDER BY c.entity_type, c.cluster_key
    `).all();
    expect(rerunRows).toEqual(clusterRows);
    expect(rerun.persistedClusterCount).toBe(4);
    const rebuilt = new RepostClusteringService(db).run('repost-v1', { dryRun: false, rebuild: true });
    expect(rebuilt.persistedClusterCount).toBe(4);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dedupe_clusters WHERE algorithm_version = ?').get('repost-v1'))
      .toEqual({ count: 4 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_items').get()).toEqual(itemCount);
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_item_versions').get()).toEqual(versionCount);
    expect(db.prepare('SELECT representative_source_item_id FROM dedupe_clusters WHERE cluster_key = ?')
      .get(committed.clusters.find((row) => row.members === 2)!.clusterKey))
      .toEqual({ representative_source_item_id: committed.clusters.find((row) => row.members === 2)!.representativeSourceItemId });
  });

  it('incrementally attaches a new repost and reassigns a changed member without rebuilding unrelated clusters', () => {
    const service = new RepostClusteringService(db);
    const sourceA = sources.findSourceId('facebook_group:group-a')!;
    const sourceB = sources.findSourceId('facebook_group:group-b')!;
    const first = Number(db.prepare("SELECT id FROM source_items WHERE external_id='supply-a'").get() &&
      (db.prepare("SELECT id FROM source_items WHERE external_id='supply-a'").get() as { id: number }).id);
    service.run('repost-v1', { dryRun: false });
    const original = db.prepare(`SELECT c.id,c.representative_source_item_id FROM dedupe_clusters c
      JOIN dedupe_cluster_members m ON m.cluster_id=c.id WHERE m.source_item_id=?`).get(first) as { id:number;representative_source_item_id:number };
    const inserted = sources.upsertSourceItemDetailed(sourceB, { sourceType: 'FACEBOOK_GROUP', externalId: 'supply-new-repost',
      rawText: '2BR apartment in Wat Bo for rent at $350. Property code DV123. Phone +855 12 345 678.',
      contentHash: 'new-repost-hash', groupId: 'Group B', groupName: 'Group B', authorExternalId: 'https://facebook.com/profile.php?id=777',
      classification: 'HOUSING_SUPPLY' });
    sources.replaceIdentifiers(inserted.id, [
      { type: 'PROPERTY_CODE', normalizedValue: 'DV123' }, { type: 'PHONE', normalizedValue: '+85512345678' },
    ]);
    const attached = service.runIncremental('repost-v1', [inserted.id]);
    const assignmentA = attached.assignments.find((entry) => entry.sourceItemId === first)!;
    const assignmentB = attached.assignments.find((entry) => entry.sourceItemId === inserted.id)!;
    expect(assignmentA.clusterId).toBe(original.id);
    expect(assignmentB.clusterId).toBe(original.id);
    expect(attached.clustersCreated).toBe(0);
    expect(db.prepare('SELECT COUNT(*) count FROM source_items').get()).toEqual({ count: 6 });

    const beforeUnrelated = db.prepare(`SELECT c.id FROM dedupe_clusters c JOIN dedupe_cluster_members m ON m.cluster_id=c.id
      WHERE m.source_item_id=(SELECT id FROM source_items WHERE external_id='supply-c')`).get() as { id:number };
    const oldText = (db.prepare('SELECT raw_text FROM source_items WHERE id=?').get(inserted.id) as {raw_text:string}).raw_text;
    sources.upsertSourceItemDetailed(sourceB, { sourceType: 'FACEBOOK_GROUP', externalId: 'supply-new-repost',
      rawText: '4BR villa Svay Dangkum for rent $900, code NEW999. Phone 099 999 999.',
      contentHash: 'repurposed-hash', groupId: 'Group B', groupName: 'Group B', classification: 'HOUSING_SUPPLY' });
    sources.replaceIdentifiers(inserted.id, [
      { type: 'PROPERTY_CODE', normalizedValue: 'NEW999' }, { type: 'PHONE', normalizedValue: '+85599999999' },
    ]);
    const reassigned = service.runIncremental('repost-v1', [inserted.id]);
    expect(reassigned.assignments.find((entry) => entry.sourceItemId === first)?.clusterId).toBe(original.id);
    expect(reassigned.assignments.find((entry) => entry.sourceItemId === inserted.id)?.clusterId).not.toBe(original.id);
    expect(db.prepare(`SELECT c.id FROM dedupe_clusters c JOIN dedupe_cluster_members m ON m.cluster_id=c.id
      WHERE m.source_item_id=(SELECT id FROM source_items WHERE external_id='supply-c')`).get()).toEqual(beforeUnrelated);
    expect(db.prepare('SELECT raw_text FROM source_items WHERE id=?').get(inserted.id)).not.toEqual({ raw_text: oldText });
  });
});
