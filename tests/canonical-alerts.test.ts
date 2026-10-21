import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContainer, type AppContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { CanonicalAlertsRepository } from '../src/database/repositories/canonical-alerts.repo';
import { env } from '../src/config/env';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';

describe('durable canonical publication alerts', () => {
  let container: AppContainer;
  let db: DatabaseSync;
  let sourceRegistryId: number;
  let previousPath: typeof env.LISTING_READ_PATH;
  let previousCanaries: typeof env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
  let previousEnabled: typeof env.CANONICAL_ALERTS_ENABLED;

  beforeEach(() => {
    previousPath = env.LISTING_READ_PATH;
    previousCanaries = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;
    previousEnabled = env.CANONICAL_ALERTS_ENABLED;
    env.LISTING_READ_PATH = 'legacy';
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [991001];
    env.CANONICAL_ALERTS_ENABLED = false;
    container = createContainer({ dbPath: ':memory:' });
    db = container.db;
    runMigrations(db);
    sourceRegistryId = container.sourceIngestionRepo.upsertSource({
      sourceType: 'KHMER24', externalSourceId: 'alerts-test', name: 'Alert test',
    });
  });

  afterEach(() => {
    env.LISTING_READ_PATH = previousPath;
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = previousCanaries;
    env.CANONICAL_ALERTS_ENABLED = previousEnabled;
    db.close();
    jest.restoreAllMocks();
  });

  function addFilter(telegramId: number): void {
    const user = container.usersRepo.upsertUser(telegramId, String(telegramId));
    container.filtersRepo.createFilter({
      user_id: user.id, type: 'rent', city: 'siem_reap', category: null,
      requires_pool: false, min_lease_preferred: null, locations: [],
      min_price: null, max_price: null, bedrooms: null,
    });
  }

  function addListing(label: string): number {
    const seen = new Date().toISOString();
    const sourceId = container.sourceIngestionRepo.upsertSourceItemDetailed(sourceRegistryId, {
      sourceType: 'KHMER24', externalId: label, sourceUrl: `https://example.test/${label}`,
      rawText: 'One bedroom apartment for rent in Sala Kamreuk',
      contentHash: label, classification: 'HOUSING_SUPPLY',
      rawPayload: { listingFacts: { offer_type: 'rent', city: 'siem_reap', sangkat: 'Sala Kamreuk' } },
    }, seen).id;
    const listingId = Number(db.prepare(`INSERT INTO canonical_listings
      (public_ref,title,description,status,availability_status,price,currency,category,bedrooms,city,sangkat,first_seen_at,last_seen_at,listing_facts_json)
      VALUES('lst_'||lower(hex(randomblob(16))),?,'For rent','active','available',25000,'USD','apartment',1,'siem_reap','Sala Kamreuk',?,?,?)`)
      .run(label, seen, seen, JSON.stringify({ offer_type: 'rent' })).lastInsertRowid);
    const occurrenceId = Number(db.prepare(`INSERT INTO canonical_listing_source_occurrences
      (source_item_id,listing_id,source_registry_id,source_url,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?)`).run(sourceId, listingId, sourceRegistryId, `https://example.test/${label}`, seen, seen).lastInsertRowid);
    db.prepare('UPDATE canonical_listings SET primary_source_occurrence_id=? WHERE id=?').run(occurrenceId, listingId);
    db.prepare("INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES(?,'pending')").run(listingId);
    return listingId;
  }

  function approve(listingId: number): void {
    db.prepare(`UPDATE canonical_listing_moderation
      SET review_status='approved',decision_origin='EXPLICIT_CANONICAL' WHERE listing_id=?`).run(listingId);
  }

  function statuses(): Array<{ telegram_id: number; status: string }> {
    return db.prepare('SELECT telegram_id,status FROM canonical_alert_deliveries ORDER BY telegram_id')
      .all() as Array<{ telegram_id: number; status: string }>;
  }

  it('skips pre-activation history and publishes one durable event for later approval', () => {
    const oldListing = addListing('old');
    approve(oldListing);
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_publication_events').get()).toEqual({ n: 1 });
    container.canonicalAlertsRepo.activate();
    expect(container.canonicalAlertsRepo.materializeNext(() => [991001])).toBeUndefined();
    expect(statuses()).toEqual([]);
    const newListing = addListing('new');
    approve(newListing);
    approve(newListing);
    const event = container.canonicalAlertsRepo.materializeNext(() => [991001, 991001]);
    expect(event?.listingId).toBe(newListing);
    expect(container.canonicalAlertsRepo.materializeNext(() => [991001])).toBeUndefined();
    expect(statuses()).toEqual([{ telegram_id: 991001, status: 'pending' }]);
    container.canonicalAlertsRepo.activate();
    expect(statuses()).toHaveLength(1);
  });

  it('sends to matched canary only once and survives a worker restart', async () => {
    addFilter(991001);
    addFilter(991002);
    container.canonicalAlertsRepo.activate();
    const listingId = addListing('deliver');
    approve(listingId);
    expect(container.canonicalListingRepo.getPropertyById(listingId)?.public_listing_ref).toMatch(/^lst_/);
    const send = jest.spyOn(container.notifierService, 'sendCanonicalAlert').mockResolvedValue();
    await container.canonicalAlertsService.tick();
    await container.canonicalAlertsService.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(991001, expect.objectContaining({ id: listingId }));
    expect(statuses()).toEqual([{ telegram_id: 991001, status: 'sent' }]);
    container.canonicalAlertsRepo.markInterruptedUncertain();
    await container.canonicalAlertsService.tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending delivery if its recipient pauses notifications', async () => {
    addFilter(991001);
    container.canonicalAlertsRepo.activate();
    const listingId = addListing('pause');
    approve(listingId);
    container.canonicalAlertsRepo.materializeNext((id) =>
      container.matcherService.matchProperty(container.canonicalListingRepo.getPropertyById(id)!)
        .map(({ telegramId }) => telegramId));
    db.prepare('UPDATE users SET alerts_paused=1 WHERE telegram_id=991001').run();
    const send = jest.spyOn(container.notifierService, 'sendCanonicalAlert').mockResolvedValue();
    await container.canonicalAlertsService.tick();
    expect(send).not.toHaveBeenCalled();
    expect(statuses()).toEqual([{ telegram_id: 991001, status: 'cancelled' }]);
  });

  it('never automatically retries an ambiguous send or stale in-flight claim', async () => {
    addFilter(991001);
    container.canonicalAlertsRepo.activate();
    const listingId = addListing('failed');
    approve(listingId);
    const send = jest.spyOn(container.notifierService, 'sendCanonicalAlert')
      .mockRejectedValueOnce(new Error('Telegram response timed out'))
      .mockResolvedValue(undefined);
    await container.canonicalAlertsService.tick();
    await container.canonicalAlertsService.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual([{ telegram_id: 991001, status: 'uncertain' }]);
    expect(db.prepare('SELECT last_error FROM canonical_alert_deliveries').get()).toEqual({
      last_error: 'Telegram response timed out',
    });

    const nextListing = addListing('interrupted');
    approve(nextListing);
    container.canonicalAlertsRepo.materializeNext(() => [991001]);
    const claim = container.canonicalAlertsRepo.claimNext();
    expect(claim?.listingId).toBe(nextListing);
    expect(container.canonicalAlertsRepo.markInterruptedUncertain()).toBe(0);
    db.prepare("UPDATE canonical_alert_deliveries SET claimed_at=datetime('now','-10 minutes') WHERE id=?").run(claim!.id);
    expect(container.canonicalAlertsRepo.markInterruptedUncertain()).toBe(1);
    expect(container.canonicalAlertsRepo.claimNext()).toBeUndefined();
  });

  it('coordinates delivery claims across independent SQLite connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'homeasy-alert-claims-'));
    const file = join(dir, 'alerts.sqlite');
    const firstDb = new DatabaseSync(file);
    let secondDb: DatabaseSync | undefined;
    try {
      runMigrations(firstDb);
      secondDb = new DatabaseSync(file);
      const first = new CanonicalAlertsRepository(firstDb);
      const second = new CanonicalAlertsRepository(secondDb);
      const listingId = Number(firstDb.prepare(`INSERT INTO canonical_listings
        (public_ref,title,description,status,availability_status,price,currency,category,bedrooms,city,first_seen_at,last_seen_at)
        VALUES('lst_'||lower(hex(randomblob(16))),'New','For rent','active','available',20000,'USD','apartment',1,'siem_reap',datetime('now'),datetime('now'))`)
        .run().lastInsertRowid);
      firstDb.prepare('INSERT INTO canonical_alert_deliveries(listing_id,telegram_id) VALUES(?,?)')
        .run(listingId, 991001);
      const claim = second.claimNext();
      expect(claim).toEqual(expect.objectContaining({ listingId, telegramId: 991001 }));
      expect(first.claimNext()).toBeUndefined();
      expect(firstDb.prepare('SELECT status FROM canonical_alert_deliveries').get()).toEqual({ status: 'sending' });
      second.finish(claim!.id, 'sent');
      expect(first.claimNext()).toBeUndefined();
      expect(firstDb.prepare('SELECT status FROM canonical_alert_deliveries').get()).toEqual({ status: 'sent' });
    } finally {
      secondDb?.close();
      firstDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes live discovery sources, never manually imported historical sources, and stays idempotent on recrawl', () => {
    env.CANONICAL_ALERTS_ENABLED = true;
    container.canonicalAlertsRepo.activate();
    const shadow = new CanonicalShadowService(db);
    const addDiscovered = (label: string, runType: 'DISCOVERY' | 'MANUAL_IMPORT') => {
      const runId = Number(db.prepare('INSERT INTO processing_runs(run_type) VALUES(?)').run(runType).lastInsertRowid);
      return container.sourceIngestionRepo.upsertSourceItemDetailed(sourceRegistryId, {
        sourceType: 'KHMER24', externalId: label, sourceUrl: `https://example.test/${label}`,
        rawText: `Villa ${label} in Siem Reap available for rent`,
        contentHash: label, classification: 'HOUSING_SUPPLY', processingRunId: runId,
        rawPayload: { listingFacts: { title_en: `Villa ${label}`, city: 'siem_reap', sangkat: label,
          property_code: label, offer_type: 'rent', price: 350, currency: 'USD', category: 'house', bedrooms: 2 } },
      }).id;
    };
    const discovered = addDiscovered('new-live', 'DISCOVERY');
    shadow.run({ dryRun: false });
    const liveListing = (db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1')
      .get(discovered) as { listing_id: number }).listing_id;
    db.prepare(`UPDATE canonical_listing_moderation
      SET review_status='approved',decision_origin='INGESTION_VALIDATED_V1' WHERE listing_id=?`).run(liveListing);
    shadow.run({ dryRun: false });
    expect(db.prepare("SELECT listing_id,event_kind FROM canonical_publication_events WHERE event_kind='NEW_SOURCE'").all())
      .toEqual([{ listing_id: liveListing, event_kind: 'NEW_SOURCE' }]);
    shadow.run({ dryRun: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_publication_events').get()).toEqual({ n: 1 });

    const backfill = addDiscovered('old-manual', 'MANUAL_IMPORT');
    shadow.run({ dryRun: false });
    const manualListing = (db.prepare('SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND is_current=1')
      .get(backfill) as { listing_id: number }).listing_id;
    db.prepare(`UPDATE canonical_listing_moderation
      SET review_status='approved',decision_origin='INGESTION_VALIDATED_V1' WHERE listing_id=?`).run(manualListing);
    shadow.run({ dryRun: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM canonical_publication_events').get()).toEqual({ n: 1 });
  });
});
