import type { DatabaseSync } from 'node:sqlite';

export type SourceType = 'FACEBOOK_GROUP' | 'KHMER24' | 'AGENT' | 'LANDLORD' | 'REAL_ESTATE_PORTAL' | 'MANUAL';
export type IngestionMethod = 'BRIGHTDATA' | 'CAMOUFOX' | 'KHMER24_SCRAPER' | 'DIRECT_SUBMISSION' | 'MANUAL' | 'REPLAY';
export type SourceIdentifierType = 'PHONE' | 'TELEGRAM' | 'WHATSAPP' | 'EMAIL' | 'PROPERTY_CODE' | 'AGENCY_CODE' | 'MAPS_URL' | 'MAPS_PLACE_ID';

export interface SourceIdentityInput {
  sourceType: SourceType;
  externalSourceId: string;
  name: string;
  url?: string | null;
  city?: 'siem_reap' | 'phnom_penh' | null;
}

export interface SourceItemInput {
  sourceType: SourceType;
  externalId: string;
  canonicalUrl?: string | null;
  sourceUrl?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  authorExternalId?: string | null;
  authorName?: string | null;
  authorUrl?: string | null;
  rawText?: string | null;
  rawPayload?: unknown;
  contentHash?: string | null;
  mediaHash?: string | null;
  publishedAt?: string | null;
  classification?: 'HOUSING_SUPPLY' | 'HOUSING_DEMAND' | 'HOUSING_ADJACENT' | 'IRRELEVANT' | 'UNCLASSIFIED' | null;
  parserVersion?: string | null;
  processingRunId?: number | null;
}

export interface SourceIdentifierInput {
  type: SourceIdentifierType;
  rawValue?: string | null;
  normalizedValue: string;
}

export interface SourceItemUpsertResult {
  id: number;
  inserted: boolean;
  updated: boolean;
  unchanged: boolean;
  newVersion: boolean;
}

export interface AiProcessingResultInput {
  sourceItemId: number;
  stage: 'CLASSIFICATION' | 'SUPPLY_EXTRACTION' | 'DEMAND_EXTRACTION';
  provider?: string | null;
  model?: string | null;
  fallbackDepth?: number | null;
  callId?: string | null;
  attemptIndex?: number | null;
  promptVersion?: string | null;
  success?: boolean;
  errorCode?: string | null;
  latencyMs?: number | null;
}

/** Database operations for the raw ingestion layer. Callers can group writes atomically. */
export class SourceIngestionRepository {
  constructor(private readonly db: DatabaseSync) {}

  transaction<T>(work: () => T): T {
    this.db.exec('SAVEPOINT source_ingestion');
    try {
      const result = work();
      this.db.exec('RELEASE source_ingestion');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO source_ingestion');
      this.db.exec('RELEASE source_ingestion');
      throw error;
    }
  }

  makeSourceKey(identity: Pick<SourceIdentityInput, 'sourceType' | 'externalSourceId'>): string {
    return `${identity.sourceType.toLowerCase()}:${identity.externalSourceId}`;
  }

  upsertSource(identity: SourceIdentityInput): number {
    return this.upsertSourceDetailed(identity).id;
  }

  findSourceId(sourceKey: string): number | undefined {
    const row = this.db.prepare('SELECT id FROM source_registry WHERE source_key = ?').get(sourceKey) as { id: number } | undefined;
    return row?.id;
  }

  upsertSourceDetailed(identity: SourceIdentityInput): { id: number; inserted: boolean } {
    const sourceKey = this.makeSourceKey(identity);
    const existingId = this.findSourceId(sourceKey);
    this.db.prepare(`
      INSERT INTO source_registry (source_key, source_type, external_source_id, name, url, city)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        name = excluded.name, url = COALESCE(excluded.url, source_registry.url),
        city = COALESCE(excluded.city, source_registry.city),
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `).run(sourceKey, identity.sourceType, identity.externalSourceId, identity.name,
      identity.url ?? null, identity.city ?? null);
    const row = this.db.prepare('SELECT id FROM source_registry WHERE source_key = ?').get(sourceKey) as { id: number };
    return { id: row.id, inserted: existingId === undefined };
  }

  createRun(runType: 'DISCOVERY' | 'REPLAY' | 'REPARSE' | 'FRESHNESS_CHECK' | 'MANUAL_IMPORT', sourceRegistryId?: number): number {
    const result = this.db.prepare('INSERT INTO processing_runs (run_type, source_registry_id) VALUES (?, ?)')
      .run(runType, sourceRegistryId ?? null);
    return Number(result.lastInsertRowid);
  }

  recordAiResult(processingRunId: number, result: AiProcessingResultInput): void {
    this.db.prepare(`
      INSERT INTO ai_processing_results
        (processing_run_id, source_item_id, stage, provider, model, fallback_depth, call_id, attempt_index, prompt_version, success, error_code, latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(processingRunId, result.sourceItemId, result.stage, result.provider ?? null,
      result.model ?? null, result.fallbackDepth ?? null, result.callId ?? null, result.attemptIndex ?? null, result.promptVersion ?? null,
      result.success === false ? 0 : 1, result.errorCode ?? null, result.latencyMs ?? null);
  }

  recordProviderUsage(input: {
    provider: string; operation: string; requestedItems: number; returnedItems: number;
    failedItems: number; records: number; processingRunId?: number;
    estimatedCost?: number | null; actualCost?: number | null;
  }): void {
    this.db.prepare(`INSERT INTO external_provider_usage
      (provider,operation,requested_items,returned_items,failed_items,records,estimated_cost,actual_cost,processing_run_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(input.provider, input.operation, input.requestedItems, input.returnedItems,
      input.failedItems, input.records, input.estimatedCost ?? null, input.actualCost ?? null, input.processingRunId ?? null);
  }

  /** Discovery is natural freshness evidence; availability confirmation remains untouched. */
  recordNaturalRediscovery(sourceItemId: number, observedAt: string): void {
    this.db.prepare(`UPDATE canonical_listing_source_occurrences SET last_seen_at=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE source_item_id=? AND is_current=1`).run(observedAt, sourceItemId);
    this.db.prepare(`UPDATE canonical_listings SET last_seen_at=MAX(last_seen_at,?),
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id IN (SELECT listing_id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND listing_id IS NOT NULL AND is_current=1)`)
      .run(observedAt, sourceItemId);
    this.db.prepare(`UPDATE canonical_properties SET last_observed_at=MAX(COALESCE(last_observed_at,''),?),
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id IN (SELECT l.property_id FROM canonical_listing_source_occurrences o
        JOIN canonical_listings l ON l.id=o.listing_id WHERE o.source_item_id=? AND o.is_current=1 AND l.property_id IS NOT NULL)`)
      .run(observedAt, sourceItemId);
  }

  /** Ends a derived binding while keeping its occurrence and media history intact. */
  closeCurrentCanonicalBindings(sourceItemId: number, sourceEntityKey: string, endedAt: string): number {
    const rows = this.db.prepare(`SELECT id,listing_id FROM canonical_listing_source_occurrences
      WHERE source_item_id=? AND source_entity_key=? AND is_current=1`).all(sourceItemId, sourceEntityKey) as Array<{ id: number; listing_id: number | null }>;
    if (!rows.length) return 0;
    this.db.prepare(`UPDATE canonical_listing_source_occurrences SET is_current=0,ended_at=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE source_item_id=? AND source_entity_key=? AND is_current=1`)
      .run(endedAt, sourceItemId, sourceEntityKey);
    const affectedListings = [...new Set(rows.map((row) => row.listing_id).filter((id): id is number => id !== null))];
    const updatePrimary = this.db.prepare(`UPDATE canonical_listings SET primary_source_occurrence_id=(
      SELECT o.id FROM canonical_listing_source_occurrences o WHERE o.listing_id=? AND o.is_current=1
      ORDER BY o.first_seen_at,o.id LIMIT 1),
      status=CASE WHEN EXISTS(SELECT 1 FROM canonical_listing_source_occurrences o WHERE o.listing_id=? AND o.is_current=1) THEN status ELSE 'inactive' END
      WHERE id=?`);
    for (const listingId of affectedListings) updatePrimary.run(listingId, listingId, listingId);
    return rows.length;
  }

  hasRepostAssignment(sourceItemId: number, algorithmVersion = 'repost-v1'): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM dedupe_cluster_members m JOIN dedupe_clusters c ON c.id=m.cluster_id
      WHERE m.source_item_id=? AND c.algorithm_version=? AND c.entity_type IN ('SUPPLY_REPOST','DEMAND_REPOST') LIMIT 1`)
      .get(sourceItemId, algorithmVersion));
  }

  hasCurrentCanonicalOccurrence(sourceItemId: number, sourceEntityKey = 'canonical-dedupe-v1'): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM canonical_listing_source_occurrences
      WHERE source_item_id=? AND source_entity_key=? AND is_current=1 LIMIT 1`).get(sourceItemId, sourceEntityKey));
  }

  hasCurrentCanonicalBinding(sourceItemId:number,contentHash:string|null,mediaHash:string|null,sourceEntityKey='canonical-dedupe-v1'):boolean{
    return Boolean(this.db.prepare(`SELECT 1 FROM canonical_listing_source_occurrences WHERE source_item_id=? AND source_entity_key=?
      AND is_current=1 AND content_hash IS ? AND media_hash IS ? LIMIT 1`).get(sourceItemId,sourceEntityKey,contentHash,mediaHash));
  }

  /** Applies only explicit, high-confidence unavailability language in edited source content. */
  recordExplicitAvailabilityEdit(sourceItemId: number, rawText: string, observedAt: string): number {
    const text = rawText.normalize('NFKC').toLowerCase();
    if (/\b(?:not rented|never rented|looking for rent|for rent)\b/.test(text)) return 0;
    const rented = /\b(?:already\s+)?(?:rented|taken)\b|\bno longer available\b|\bunavailable\b/.test(text);
    const available = !rented && !/\b(?:not available|no longer available)\b/.test(text) && /\bavailable\b/.test(text);
    if (!rented && !available) return 0;
    const rows = this.db.prepare(`SELECT o.id AS occurrence_id,o.listing_id,l.availability_status
      FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
      WHERE o.source_item_id=? AND o.is_current=1 AND o.listing_id IS NOT NULL`).all(sourceItemId) as Array<{
        occurrence_id: number; listing_id: number; availability_status: string | null;
      }>;
    const status=rented?'rented':'available';const signal=rented?'unavailable':'available';const result=rented?'UNAVAILABLE':'ALIVE';
    const updateOccurrence = this.db.prepare(`UPDATE canonical_listing_source_occurrences SET availability_signal=?,availability_signal_at=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`);
    const updateListing = this.db.prepare(`UPDATE canonical_listings SET availability_status=?,availability_last_confirmed_at=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`);
    const check = this.db.prepare(`INSERT INTO availability_checks(listing_id,source_occurrence_id,check_type,provider,previous_status,new_status,result,checked_at,raw_response)
      VALUES(?,?,'CONTENT_CHANGE','SOURCE_CONTENT',?,?,?, ?,?)`);
    for (const row of rows) {
      updateOccurrence.run(signal, observedAt, row.occurrence_id);
      updateListing.run(status, observedAt, row.listing_id);
      check.run(row.listing_id, row.occurrence_id, row.availability_status ?? 'unknown', status, result, observedAt, rawText.slice(0, 2000));
    }
    return rows.length;
  }

  finishRun(runId: number, counts: { input: number; processed: number; success: number; failed: number }): void {
    this.db.prepare(`
      UPDATE processing_runs SET finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        items_input=?, items_processed=?, items_success=?, items_failed=?,
        status=?, error_summary=? WHERE id=?
    `).run(counts.input, counts.processed, counts.success, counts.failed,
      counts.failed > 0 && counts.success === 0 ? 'failed' : 'completed',
      counts.failed ? `${counts.failed} item(s) failed; see replay report` : null, runId);
  }

  addRunSourceCounts(runId: number, sourceId: number, method: IngestionMethod,
    counts: { input: number; success: number; failed: number }): void {
    this.db.prepare(`
      INSERT INTO processing_run_sources
        (processing_run_id, source_registry_id, ingestion_method, records_input, records_success, records_failed)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(processing_run_id, source_registry_id, ingestion_method) DO UPDATE SET
        records_input=excluded.records_input, records_success=excluded.records_success,
        records_failed=excluded.records_failed,
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `).run(runId, sourceId, method, counts.input, counts.success, counts.failed);
  }

  upsertRunSource(runId: number, sourceRegistryId: number, method: IngestionMethod): void {
    this.db.prepare(`
      INSERT INTO processing_run_sources (processing_run_id, source_registry_id, ingestion_method)
      VALUES (?, ?, ?)
      ON CONFLICT(processing_run_id, source_registry_id, ingestion_method) DO NOTHING
    `).run(runId, sourceRegistryId, method);
  }

  upsertSourceItem(sourceRegistryId: number, item: SourceItemInput, observedAt = new Date().toISOString()): number {
    return this.upsertSourceItemDetailed(sourceRegistryId, item, observedAt).id;
  }

  previewSourceItem(sourceRegistryId: number, externalId: string, contentHash?: string | null, mediaHash?: string | null): 'new' | 'updated' | 'unchanged' {
    if (!sourceRegistryId) return 'new';
    const row = this.db.prepare(`SELECT content_hash,media_hash FROM source_items WHERE source_registry_id=? AND external_id=?`)
      .get(sourceRegistryId, externalId) as { content_hash: string | null; media_hash: string | null } | undefined;
    if (!row) return 'new';
    return row.content_hash === (contentHash ?? null) && row.media_hash === (mediaHash ?? null) ? 'unchanged' : 'updated';
  }

  findSourceItemState(sourceRegistryId: number, externalId: string): { id: number; classification: string | null;
    contentHash: string | null; mediaHash: string | null; rawPayloadJson: string } | undefined {
    return this.db.prepare('SELECT id,classification,content_hash AS contentHash,media_hash AS mediaHash,raw_payload_json AS rawPayloadJson FROM source_items WHERE source_registry_id=? AND external_id=?')
      .get(sourceRegistryId, externalId) as { id: number; classification: string | null; contentHash: string | null;
        mediaHash: string | null; rawPayloadJson: string } | undefined;
  }

  upsertSourceItemDetailed(sourceRegistryId: number, item: SourceItemInput, observedAt = new Date().toISOString()): SourceItemUpsertResult {
    const payload = JSON.stringify(item.rawPayload ?? {});
    const existing = this.db.prepare(`
      SELECT id, content_hash, raw_text, raw_payload_json, media_hash
      FROM source_items WHERE source_registry_id = ? AND external_id = ?
    `).get(sourceRegistryId, item.externalId) as {
      id: number; content_hash: string | null; raw_text: string | null;
      raw_payload_json: string; media_hash: string | null;
    } | undefined;

    const changed = Boolean(existing && (existing.content_hash !== item.contentHash || existing.media_hash !== (item.mediaHash ?? null)));
    if (existing && changed) {
      this.db.prepare(`
        INSERT OR IGNORE INTO source_item_versions
          (source_item_id, content_hash, raw_text, raw_payload_json, media_hash, observed_at, parser_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(existing.id, existing.content_hash, existing.raw_text, existing.raw_payload_json,
        existing.media_hash, observedAt, item.parserVersion ?? null);
    }

    this.db.prepare(`
      INSERT INTO source_items (
        source_registry_id, source_type, external_id, canonical_url, source_url,
        group_id, group_name, author_external_id, author_name, author_url,
        raw_text, raw_payload_json, content_hash, media_hash, published_at,
        last_seen_at, classification, parser_version, processing_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_registry_id, external_id) DO UPDATE SET
        canonical_url=excluded.canonical_url, source_url=excluded.source_url,
        group_id=excluded.group_id, group_name=excluded.group_name,
        author_external_id=excluded.author_external_id, author_name=excluded.author_name,
        author_url=excluded.author_url, raw_text=excluded.raw_text,
        raw_payload_json=excluded.raw_payload_json, content_hash=excluded.content_hash,
        media_hash=excluded.media_hash, published_at=COALESCE(excluded.published_at, source_items.published_at),
        last_seen_at=excluded.last_seen_at,
        classification=COALESCE(excluded.classification, source_items.classification),
        parser_version=excluded.parser_version,
        processing_run_id=COALESCE(excluded.processing_run_id, source_items.processing_run_id),
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `).run(sourceRegistryId, item.sourceType, item.externalId, item.canonicalUrl ?? null,
      item.sourceUrl ?? null, item.groupId ?? null, item.groupName ?? null,
      item.authorExternalId ?? null, item.authorName ?? null, item.authorUrl ?? null,
      item.rawText ?? null, payload, item.contentHash ?? null, item.mediaHash ?? null,
      item.publishedAt ?? null, observedAt, item.classification ?? null,
      item.parserVersion ?? null, item.processingRunId ?? null);

    const row = this.db.prepare('SELECT id FROM source_items WHERE source_registry_id = ? AND external_id = ?')
      .get(sourceRegistryId, item.externalId) as { id: number };
    const isNew = !existing;
    const isChanged = Boolean(existing && changed);
    const newVersion = !existing || changed;
    if (newVersion) {
      this.db.prepare(`
        INSERT OR IGNORE INTO source_item_versions
          (source_item_id, content_hash, raw_text, raw_payload_json, media_hash, observed_at, parser_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, item.contentHash ?? null, item.rawText ?? null, payload,
        item.mediaHash ?? null, observedAt, item.parserVersion ?? null);
    }
    return { id: row.id, inserted: isNew, updated: isChanged, unchanged: Boolean(existing && !changed), newVersion };
  }

  replaceIdentifiers(sourceItemId: number, identifiers: SourceIdentifierInput[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO source_item_identifiers (source_item_id, type, raw_value, normalized_value)
      VALUES (?, ?, ?, ?)
    `);
    this.transaction(() => {
      this.db.prepare('DELETE FROM source_item_identifiers WHERE source_item_id = ?').run(sourceItemId);
      for (const identifier of identifiers) {
        if (identifier.normalizedValue.trim()) {
          insert.run(sourceItemId, identifier.type, identifier.rawValue ?? null, identifier.normalizedValue.trim());
        }
      }
    });
  }
}
