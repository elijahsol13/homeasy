import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createDatabase, closeDatabase } from '../src/database/db';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';

const targetPath = process.env.PHASE6A3_TARGET ?? 'data/homeasy.db';
const triagePath = process.env.PHASE6A3B_TRIAGE_REPORT ?? 'reports/phase6a3b-moderation-triage-20261007.json';
const backupPath = process.env.PHASE6A3_BACKUP_PATH ?? 'data/backups/homeasy_phase6a3b_prebackfill_20261007.db';
const baselineCount = 390;
const baselineDigest = '59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272';
const policyVersion = 'INGESTION_VALIDATED_V1';

type TriageRow = {
  listing_id: number;
  public_ref: string;
  title: string;
  source_type: string;
  source_name: string | null;
  source_url: string | null;
  current_occurrences: number;
  current_alive: number;
  geoTier: string;
  offerTier: string;
  flags: string[];
  triage: 'AUTO_APPROVE_CANDIDATE' | 'MANUAL_REVIEW' | 'REJECT';
  in_search: boolean;
  moderation: string;
  price: number | null;
  bedrooms: number | null;
  city: string | null;
  property_city: string | null;
  explicit_location: string | null;
  sangkat: string | null;
};

function main(): void {
  if (!existsSync(targetPath) || !existsSync(triagePath) || !existsSync(backupPath)) throw new Error('Target, triage report, and verified checkpoint backup must exist');
  const triage = JSON.parse(readFileSync(triagePath, 'utf8')) as { allRows: TriageRow[]; candidateCount: number; generatedAt: string };
  if (!triage.allRows || !triage.generatedAt || triage.candidateCount < 200) throw new Error('Triage report is missing or incomplete');
  const db = createDatabase(targetPath);
  try {
    const migration = db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as { version: number };
    if (migration.version < 50) throw new Error(`Expected moderation provenance migration v50, got v${migration.version}`);
    const before = snapshotLegacyProperties(db);
    if (before.count !== baselineCount || before.digest !== baselineDigest) throw new Error('Legacy properties baseline changed before moderation policy application');
    const decisions = triage.allRows.filter((row) => row.in_search && row.moderation === 'pending');
    if (!decisions.length) throw new Error('No in-search canonical-only pending rows in the triage report');
    const update = db.prepare(`UPDATE canonical_listing_moderation SET review_status=?,review_reason=?,updated_at=?,
      decision_origin=?,policy_version=?,decision_evidence_json=?,previous_review_status=?,decided_at=?,decision_actor='AUTO_POLICY'
      WHERE listing_id=? AND review_status='pending'
      AND NOT EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=canonical_listing_moderation.listing_id AND a.namespace='legacy_property_id')`);
    const now = new Date().toISOString();
    const resultCounts: Record<string, number> = { approved: 0, pending: 0, rejected: 0 };
    const applied: Array<{ listingId: number; publicRef: string; disposition: string; status: string; flags: string[] }> = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of decisions) {
        const live = db.prepare(`SELECT l.public_ref,l.city,l.price,l.bedrooms,m.review_status,
          (SELECT COUNT(*) FROM canonical_listing_source_occurrences o WHERE o.listing_id=l.id AND o.is_current=1) current_occurrences
          FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id WHERE l.id=?`).get(row.listing_id) as
          { public_ref: string; city: string | null; price: number | null; bedrooms: number | null; review_status: string; current_occurrences: number } | undefined;
        if (!live || live.public_ref !== row.public_ref || live.review_status !== 'pending' || live.current_occurrences < 1) {
          throw new Error(`Triage row ${row.listing_id} no longer matches pending canonical state`);
        }
        const status = row.triage === 'AUTO_APPROVE_CANDIDATE' ? 'approved' : row.triage === 'REJECT' ? 'rejected' : 'pending';
        const evidence = {
          policyVersion,
          disposition: row.triage,
          priorReviewStatus: row.moderation,
          source: { type: row.source_type, name: row.source_name, url: row.source_url },
          geography: { tier: row.geoTier, listingCity: row.city, propertyCity: row.property_city, explicitLocation: row.explicit_location, sangkat: row.sangkat },
          offerTier: row.offerTier,
          currentOccurrences: row.current_occurrences,
          currentAlive: row.current_alive,
          flags: row.flags,
          triageReport: triagePath,
          triageGeneratedAt: triage.generatedAt,
        };
        const reason = row.triage === 'AUTO_APPROVE_CANDIDATE'
          ? `${policyVersion}: current housing supply passed deterministic safety checks`
          : row.triage === 'REJECT'
            ? `${policyVersion}: excluded from Siem Reap rental search (${row.flags.join(', ') || 'explicit exclusion'})`
            : `${policyVersion}: held for manual review (${row.flags.join(', ') || 'policy hold'})`;
        const result = update.run(status, reason, now, policyVersion, policyVersion, JSON.stringify(evidence), row.moderation, now, row.listing_id);
        if (Number(result.changes) !== 1) throw new Error(`Could not persist moderation provenance for listing ${row.listing_id}`);
        resultCounts[status] = (resultCounts[status] ?? 0) + 1;
        applied.push({ listingId: row.listing_id, publicRef: row.public_ref, disposition: row.triage, status, flags: row.flags });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const after = snapshotLegacyProperties(db);
    const provenance = db.prepare(`SELECT decision_origin,policy_version,decision_actor,previous_review_status,review_status,COUNT(*) n
      FROM canonical_listing_moderation WHERE policy_version=? GROUP BY 1,2,3,4,5 ORDER BY 1,5`).all(policyVersion);
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, string>>).map((row) => Object.values(row)[0]);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const report = {
      generatedAt: now,
      policyVersion,
      targetPath,
      backupPath,
      triagePath,
      triageGeneratedAt: triage.generatedAt,
      searchCandidateCount: triage.candidateCount,
      appliedCount: applied.length,
      resultCounts,
      provenance,
      legacy: { before, after, unchanged: before.count === after.count && before.digest === after.digest },
      integrity,
      foreignKeyViolations: foreignKeys,
      decisions: applied,
    };
    const out = 'reports/phase6a3b-moderation-apply-20261007.json';
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ out, resultCounts, appliedCount: applied.length, legacyUnchanged: report.legacy.unchanged, integrity, foreignKeyViolations: foreignKeys.length }, null, 2));
    if (!report.legacy.unchanged || integrity.some((value) => value !== 'ok') || foreignKeys.length) throw new Error('Moderation policy verification failed');
  } finally {
    closeDatabase(db);
  }
}

main();
