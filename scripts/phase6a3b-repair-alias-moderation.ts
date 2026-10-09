import { existsSync, writeFileSync } from 'node:fs';
import { createDatabase, closeDatabase } from '../src/database/db';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';

const targetPath = process.env.PHASE6A3_TARGET ?? 'data/homeasy.db';
const backupPath = process.env.PHASE6A3_BACKUP_PATH ?? 'data/backups/homeasy_phase6a3b_prebackfill_20261007.db';
const policyVersion = 'INGESTION_VALIDATED_V1';
const baselineCount = 390;
const baselineDigest = '59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272';

function main(): void {
  if (!existsSync(targetPath) || !existsSync(backupPath)) throw new Error('Target database and checkpoint backup are required');
  const db = createDatabase(targetPath);
  try {
    const before = snapshotLegacyProperties(db);
    if (before.count !== baselineCount || before.digest !== baselineDigest) throw new Error('Legacy properties baseline mismatch');
    const candidates = db.prepare(`SELECT l.id,l.public_ref,l.title,m.review_status,m.decision_origin
      FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id
      WHERE m.review_status='approved' AND m.decision_origin='MIGRATED_LEGACY'
        AND NOT EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=l.id AND a.namespace='legacy_property_id')
      ORDER BY l.id`).all() as Array<{ id: number; public_ref: string; title: string; review_status: string; decision_origin: string }>;
    const now = new Date().toISOString();
    const update = db.prepare(`UPDATE canonical_listing_moderation SET review_status='pending',
      review_reason='Legacy identity alias conflict; manual review required',updated_at=?,decision_origin=?,policy_version=?,
      decision_evidence_json=?,previous_review_status='approved',decided_at=?,decision_actor='AUTO_POLICY'
      WHERE listing_id=? AND review_status='approved' AND decision_origin='MIGRATED_LEGACY'
        AND NOT EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=canonical_listing_moderation.listing_id AND a.namespace='legacy_property_id')`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of candidates) {
        const evidence = JSON.stringify({ policyVersion, disposition: 'MANUAL_REVIEW', reason: 'MIGRATED_LEGACY moderation was present without a resolvable legacy_property_id alias', previousReviewStatus: row.review_status, listingId: row.id, publicRef: row.public_ref });
        const result = update.run(now, policyVersion, policyVersion, evidence, now, row.id);
        if (Number(result.changes) !== 1) throw new Error(`Alias-conflict moderation repair failed for listing ${row.id}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const remaining = db.prepare(`SELECT COUNT(*) n FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id
      WHERE m.review_status='approved' AND m.decision_origin='MIGRATED_LEGACY'
        AND NOT EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=l.id AND a.namespace='legacy_property_id')`).get() as { n: number };
    const after = snapshotLegacyProperties(db);
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, string>>).map((row) => Object.values(row)[0]);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const report = { generatedAt: now, policyVersion, targetPath, backupPath, repairedCount: candidates.length, repaired: candidates.map((row) => ({ listingId: row.id, publicRef: row.public_ref, title: row.title })), remainingApprovedWithoutLegacyAlias: remaining.n,
      legacy: { before, after, unchanged: before.count === after.count && before.digest === after.digest }, integrity, foreignKeyViolations: foreignKeys };
    const out = 'reports/phase6a3b-alias-moderation-repair-20261007.json';
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ out, repairedCount: report.repairedCount, remainingApprovedWithoutLegacyAlias: remaining.n, legacyUnchanged: report.legacy.unchanged, integrity, foreignKeyViolations: foreignKeys.length }, null, 2));
    if (remaining.n || !report.legacy.unchanged || integrity.some((value) => value !== 'ok') || foreignKeys.length) throw new Error('Alias moderation repair acceptance failed');
  } finally {
    closeDatabase(db);
  }
}

main();
