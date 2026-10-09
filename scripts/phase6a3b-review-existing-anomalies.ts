import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createDatabase, closeDatabase } from '../src/database/db';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';

const targetPath = process.env.PHASE6A3_TARGET ?? 'data/homeasy.db';
const triagePath = process.env.PHASE6A3B_TRIAGE_REPORT ?? 'reports/phase6a3b-moderation-triage-20261007.json';
const backupPath = process.env.PHASE6A3_BACKUP_PATH ?? 'data/backups/homeasy_phase6a3b_prebackfill_20261007.db';
const policyVersion = 'INGESTION_VALIDATED_V1';
const baselineCount = 390;
const baselineDigest = '59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272';

function main(): void {
  if (!existsSync(targetPath) || !existsSync(triagePath) || !existsSync(backupPath)) throw new Error('Target, triage report, and checkpoint backup are required');
  const reportInput = JSON.parse(readFileSync(triagePath, 'utf8')) as { generatedAt: string; currentVisibleExceptions: Array<Record<string, unknown>> };
  const anomalies = reportInput.currentVisibleExceptions.filter((row) => {
    const flags = row.flags as string[] | undefined;
    return Boolean(flags?.some((flag) => ['MIXED_RENT_SALE_REQUIRES_REVIEW', 'EXPLICIT_SALE_ONLY', 'GEOGRAPHY_CONTRADICTION'].includes(flag)));
  });
  const db = createDatabase(targetPath);
  try {
    const before = snapshotLegacyProperties(db);
    if (before.count !== baselineCount || before.digest !== baselineDigest) throw new Error('Legacy properties baseline mismatch');
    const now = new Date().toISOString();
    const update = db.prepare(`UPDATE canonical_listing_moderation SET review_status='pending',review_reason=?,updated_at=?,
      decision_origin=?,policy_version=?,decision_evidence_json=?,previous_review_status='approved',decided_at=?,decision_actor='AUTO_POLICY'
      WHERE listing_id=? AND review_status='approved' AND decision_origin IN ('MIGRATED_LEGACY','DEFAULT_PENDING','INGESTION_VALIDATED_V1')`);
    const reviewed: Array<{ listingId: number; publicRef: string; title: string; flags: string[] }> = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const anomaly of anomalies) {
        const listingId = Number(anomaly.listing_id);
        const flags = anomaly.flags as string[];
        const live = db.prepare(`SELECT l.public_ref,l.title,m.review_status FROM canonical_listings l
          JOIN canonical_listing_moderation m ON m.listing_id=l.id WHERE l.id=?`).get(listingId) as
          { public_ref: string; title: string; review_status: string } | undefined;
        if (!live || live.review_status !== 'approved' || live.title !== anomaly.title) throw new Error(`Anomaly ${listingId} changed since triage`);
        const reason = `${policyVersion}: held for manual review (${flags.join(', ')})`;
        const evidence = JSON.stringify({ policyVersion, disposition: 'MANUAL_REVIEW', priorReviewStatus: live.review_status, flags,
          sourceUrl: anomaly.source_url, source: anomaly.source, geographyTier: anomaly.geoTier, offerTier: anomaly.offerTier,
          rawTextEvidence: String(anomaly.raw_text ?? '').slice(0, 900), triageReport: triagePath, triageGeneratedAt: reportInput.generatedAt });
        const result = update.run(reason, now, policyVersion, policyVersion, evidence, now, listingId);
        if (Number(result.changes) !== 1) throw new Error(`Could not hold anomalous listing ${listingId}`);
        reviewed.push({ listingId, publicRef: live.public_ref, title: live.title, flags });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const after = snapshotLegacyProperties(db);
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, string>>).map((row) => Object.values(row)[0]);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const result = { generatedAt: now, policyVersion, targetPath, backupPath, triagePath, reviewedCount: reviewed.length, reviewed,
      legacy: { before, after, unchanged: before.count === after.count && before.digest === after.digest }, integrity, foreignKeyViolations: foreignKeys };
    const out = 'reports/phase6a3b-existing-anomaly-review-20261007.json';
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ out, reviewedCount: reviewed.length, reviewed, legacyUnchanged: result.legacy.unchanged, integrity, foreignKeyViolations: foreignKeys.length }, null, 2));
    if (!result.legacy.unchanged || integrity.some((value) => value !== 'ok') || foreignKeys.length) throw new Error('Anomaly review verification failed');
  } finally {
    closeDatabase(db);
  }
}

main();
