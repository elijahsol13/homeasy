import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api } from 'grammy';
import { createContainer, type AppContainer } from '../src/container';
import { runMigrations } from '../src/database/migrate';
import { CanonicalReviewAlertsRepository } from '../src/database/repositories/canonical-review-alerts.repo';
import { CanonicalReviewAlertsService } from '../src/services/canonical-review-alerts.service';
import { AlertService } from '../src/services/alert.service';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';

describe('canonical pending moderation notifications', () => {
  let container: AppContainer;
  let db: DatabaseSync;
  let sourceRegistryId: number;
  const admins = [991001, 991002];

  beforeEach(() => {
    container = createContainer({ dbPath: ':memory:' });
    db = container.db;
    runMigrations(db);
    sourceRegistryId = container.sourceIngestionRepo.upsertSource({
      sourceType: 'KHMER24', externalSourceId: 'review-alerts-test', name: 'Review alerts fixture',
    });
  });

  afterEach(() => {
    db.close();
    jest.restoreAllMocks();
  });

  function addListing(label: string, runType: 'DISCOVERY' | 'REPLAY' | 'MANUAL_IMPORT' = 'DISCOVERY') {
    const runId = container.sourceIngestionRepo.createRun(runType, sourceRegistryId);
    const sourceId = container.sourceIngestionRepo.upsertSourceItemDetailed(sourceRegistryId, {
      sourceType: 'KHMER24', externalId: label, sourceUrl: `https://example.test/${label}`,
      rawText: `Villa ${label} for rent`, contentHash: label, classification: 'HOUSING_SUPPLY',
      processingRunId: runId,
      rawPayload: { listingFacts: { title_en: `Villa ${label}`, city: 'siem_reap',
        sangkat: label, property_code: label, offer_type: 'rent', price: 350,
        currency: 'USD', category: 'house', bedrooms: 2 } },
    }).id;
    const listingId = Number(db.prepare(`INSERT INTO canonical_listings
      (public_ref,title,first_seen_at,last_seen_at,status,availability_status)
      VALUES('lst_'||lower(hex(randomblob(16))),?,datetime('now'),datetime('now'),'active','available')`)
      .run(label).lastInsertRowid);
    const occurrenceId = Number(db.prepare(`INSERT INTO canonical_listing_source_occurrences
      (source_item_id,listing_id,source_registry_id,source_url,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,datetime('now'),datetime('now'))`)
      .run(sourceId, listingId, sourceRegistryId, `https://example.test/${label}`).lastInsertRowid);
    db.prepare('UPDATE canonical_listings SET primary_source_occurrence_id=? WHERE id=?')
      .run(occurrenceId, listingId);
    db.prepare("INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES(?,'pending')")
      .run(listingId);
    return { listingId, sourceId, runId };
  }

  function events(): number[] {
    const rows = db.prepare('SELECT listing_id FROM canonical_review_alert_events ORDER BY id').all();
    return rows.map((row) => Number(row.listing_id));
  }

  function deliveries() {
    return db.prepare(`SELECT d.telegram_id AS telegramId,d.status,e.listing_id AS listingId
      FROM canonical_review_alert_deliveries d JOIN canonical_review_alert_events e ON e.id=d.event_id
      ORDER BY d.telegram_id,e.listing_id`).all();
  }

  it('requires activation and never creates alerts for historical inventory', () => {
    const historical = addListing('historical');
    expect(container.canonicalReviewAlertsRepo.recordNewPending()).toBe(0);
    container.canonicalReviewAlertsRepo.activate();
    container.canonicalReviewAlertsRepo.activate();
    expect(container.canonicalReviewAlertsRepo.recordNewPending()).toBe(0);
    expect(events()).toEqual([]);
    const rollout = db.prepare('SELECT listing_high_water,source_item_high_water,activated_at FROM canonical_review_alert_rollout').get();
    expect(rollout).toEqual(expect.objectContaining({
      listing_high_water: historical.listingId, source_item_high_water: historical.sourceId,
      activated_at: expect.any(String),
    }));
    expect(container.canonicalReviewAlertsRepo.materializeNext(admins)).toBeUndefined();
  });

  it('accepts only new discovery pending offers and ignores replays, older sources, and reviewed offers', () => {
    addListing('source-before');
    container.canonicalReviewAlertsRepo.activate();
    const newPending = addListing('new-pending');
    const replay = addListing('replay', 'REPLAY');
    addListing('imported', 'MANUAL_IMPORT');
    const reviewed = addListing('reviewed');
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?")
      .run(reviewed.listingId);
    const datedRun = addListing('pre-activation-run');
    db.prepare("UPDATE processing_runs SET started_at='2026-01-01T00:00:00Z' WHERE id=?")
      .run(datedRun.runId);
    const datedSource = addListing('pre-activation-first-seen');
    db.prepare("UPDATE source_items SET first_seen_at='2026-01-01T00:00:00Z' WHERE id=?")
      .run(datedSource.sourceId);
    expect(container.canonicalReviewAlertsRepo.recordNewPending()).toBe(1);
    expect(events()).toEqual([newPending.listingId]);
    expect(container.canonicalReviewAlertsRepo.recordNewPending()).toBe(0);
  });

  it('records new pending from actual shadow persistence, not dry-runs, and never duplicates on rebuild', () => {
    container.canonicalReviewAlertsRepo.activate();
    const runId = container.sourceIngestionRepo.createRun('DISCOVERY', sourceRegistryId);
    const sourceId = container.sourceIngestionRepo.upsertSourceItemDetailed(sourceRegistryId, {
      sourceType: 'KHMER24', externalId: 'real-shadow', sourceUrl: 'https://example.test/real-shadow',
      rawText: 'Villa real-shadow in Siem Reap for rent', contentHash: 'real-shadow',
      classification: 'HOUSING_SUPPLY', processingRunId: runId,
      rawPayload: { listingFacts: { title_en: 'Villa real-shadow', city: 'siem_reap',
        sangkat: 'Sala Kamreuk', property_code: 'SHADOW-REVIEW-ALERT', offer_type: 'rent',
        price: 350, currency: 'USD', category: 'house', bedrooms: 2 } },
    }).id;
    const shadow = new CanonicalShadowService(db);
    shadow.run({ dryRun: true });
    expect(events()).toEqual([]);
    shadow.run({ dryRun: false });
    const bound = db.prepare(`SELECT listing_id FROM canonical_listing_source_occurrences
      WHERE source_item_id=? AND is_current=1`).get(sourceId) as { listing_id: number };
    expect(events()).toEqual([bound.listing_id]);
    shadow.run({ dryRun: false });
    expect(events()).toEqual([bound.listing_id]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('keeps events atomic with the canonical savepoint', () => {
    container.canonicalReviewAlertsRepo.activate();
    addListing('savepoint');
    db.exec('SAVEPOINT simulated_canonical_build');
    expect(container.canonicalReviewAlertsRepo.recordNewPending()).toBe(1);
    db.exec('ROLLBACK TO simulated_canonical_build');
    db.exec('RELEASE simulated_canonical_build');
    expect(events()).toEqual([]);
    expect(container.canonicalReviewAlertsRepo.recordNewPending()).toBe(1);
  });

  it('retains an event without admins and materializes one delivery per admin on restart', async () => {
    const repo = container.canonicalReviewAlertsRepo;
    repo.activate();
    const target = addListing('later-admins');
    repo.recordNewPending();
    expect(repo.materializeNext([])).toBeUndefined();
    expect(db.prepare('SELECT processed_at FROM canonical_review_alert_events').get()).toEqual({ processed_at: null });
    repo.materializeNext([admins[0], admins[0], admins[1]]);
    repo.materializeNext(admins);
    expect(deliveries()).toEqual(admins.map((telegramId) => ({
      telegramId, status: 'pending', listingId: target.listingId,
    })));
    const send = jest.spyOn(container.alertService, 'sendCanonicalPending').mockResolvedValue();
    const service = new CanonicalReviewAlertsService(repo, container.alertService, admins);
    await service.tick();
    await service.tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(admins[0], 'later-admins', expect.stringMatching(/^lst_/));
    expect(deliveries()).toEqual(admins.map((telegramId) => ({
      telegramId, status: 'sent', listingId: target.listingId,
    })));
    await new CanonicalReviewAlertsService(repo, container.alertService, admins).tick();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('cancels no-longer-pending listings before delivery', async () => {
    const repo = container.canonicalReviewAlertsRepo;
    repo.activate();
    const reviewed = addListing('to-approve');
    repo.recordNewPending();
    repo.materializeNext([admins[0]]);
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?")
      .run(reviewed.listingId);
    const send = jest.spyOn(container.alertService, 'sendCanonicalPending').mockResolvedValue();
    await new CanonicalReviewAlertsService(repo, container.alertService, admins).tick();
    expect(send).not.toHaveBeenCalled();
    expect(deliveries()).toEqual([{ telegramId: admins[0], status: 'cancelled', listingId: reviewed.listingId }]);
  });

  it('treats ambiguous Telegram responses and stale claimed deliveries as uncertain without retry', async () => {
    const repo = container.canonicalReviewAlertsRepo;
    repo.activate();
    const first = addListing('timeout');
    repo.recordNewPending();
    const send = jest.spyOn(container.alertService, 'sendCanonicalPending')
      .mockRejectedValueOnce(new Error('Telegram timeout')).mockResolvedValue();
    const service = new CanonicalReviewAlertsService(repo, container.alertService, [admins[0]]);
    await service.tick();
    await service.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(deliveries()).toEqual([{ telegramId: admins[0], status: 'uncertain', listingId: first.listingId }]);
    expect(db.prepare('SELECT last_error FROM canonical_review_alert_deliveries').get())
      .toEqual({ last_error: 'Telegram timeout' });

    const second = addListing('interrupted');
    repo.recordNewPending();
    repo.materializeNext([admins[0]]);
    const claim = repo.claimNext();
    expect(claim?.listingId).toBe(second.listingId);
    expect(repo.markInterruptedUncertain()).toBe(0);
    db.prepare("UPDATE canonical_review_alert_deliveries SET claimed_at=datetime('now','-10 minutes') WHERE id=?")
      .run(claim!.id);
    expect(repo.markInterruptedUncertain()).toBe(1);
    expect(repo.claimNext()).toBeUndefined();
    await new CanonicalReviewAlertsService(repo, container.alertService, [admins[0]]).tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('coordinates claims across two SQLite connections', () => {
    const folder = mkdtempSync(join(tmpdir(), 'homeasy-review-alert-claims-'));
    const file = join(folder, 'review.sqlite');
    const firstDb = new DatabaseSync(file);
    let secondDb: DatabaseSync | undefined;
    try {
      runMigrations(firstDb);
      secondDb = new DatabaseSync(file);
      const first = new CanonicalReviewAlertsRepository(firstDb);
      const second = new CanonicalReviewAlertsRepository(secondDb);
      const listingId = Number(firstDb.prepare(`INSERT INTO canonical_listings
        (public_ref,title,first_seen_at,last_seen_at,status,availability_status)
        VALUES('lst_'||lower(hex(randomblob(16))),'Claim fixture',datetime('now'),datetime('now'),'active','available')`)
        .run().lastInsertRowid);
      firstDb.prepare('INSERT INTO canonical_review_alert_events(listing_id) VALUES(?)').run(listingId);
      firstDb.prepare('INSERT INTO canonical_review_alert_deliveries(event_id,telegram_id) VALUES(1,?)')
        .run(admins[0]);
      const claim = second.claimNext();
      expect(claim).toEqual(expect.objectContaining({ listingId, telegramId: admins[0] }));
      expect(first.claimNext()).toBeUndefined();
      second.finish(claim!.id, 'sent');
      expect(firstDb.prepare('SELECT status FROM canonical_review_alert_deliveries').get())
        .toEqual({ status: 'sent' });
    } finally {
      secondDb?.close();
      firstDb.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('escapes untrusted listing text in Telegram HTML and points to the existing admin filter', async () => {
    const api = { sendMessage: jest.fn().mockResolvedValue({}) } as unknown as Api;
    await new AlertService(api).sendCanonicalPending(admins[0], '<Villa & "rent">', 'lst_<&>');
    expect(api.sendMessage).toHaveBeenCalledWith(admins[0],
      expect.stringContaining('&lt;Villa &amp; &quot;rent&quot;&gt;'), { parse_mode: 'HTML' });
    expect(api.sendMessage).toHaveBeenCalledWith(admins[0],
      expect.stringContaining('Mini App → Фильтры → Pending'), { parse_mode: 'HTML' });
    expect(api.sendMessage).toHaveBeenCalledWith(admins[0],
      expect.stringContaining('lst_&lt;&amp;&gt;'), { parse_mode: 'HTML' });
  });
});
