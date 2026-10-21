import type { DatabaseSync } from 'node:sqlite';

/** Complaints are separate from legacy reports and cannot auto-hide listings. */
export class CanonicalReportsRepository {
  constructor(private readonly db: DatabaseSync) {}

  report(listingId: number, userId: number): { added: boolean; total: number } {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO canonical_listing_reports(listing_id,user_id)
      VALUES(?,?)`).run(listingId, userId);
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM canonical_listing_reports WHERE listing_id=?')
      .get(listingId) as { total: number };
    return { added: inserted.changes === 1, total: row.total };
  }
}
