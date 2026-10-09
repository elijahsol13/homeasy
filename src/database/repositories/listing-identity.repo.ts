import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export type ListingAliasNamespace = 'legacy_property_id' | 'canonical_listing_id' | 'public_listing_ref' | 'legacy_url';
export interface ListingIdentity { listingId: number; publicRef: string; namespace: ListingAliasNamespace; alias: string }

/** Resolve aliases only inside their declared namespace; integers are never guessed. */
export class ListingIdentityRepository {
  constructor(private readonly db: DatabaseSync) {}

  static generatePublicRef(): string {
    return `lst_${crypto.randomBytes(16).toString('hex')}`;
  }

  publicRef(listingId: number): string {
    const row = this.db.prepare('SELECT public_ref FROM canonical_listings WHERE id=?').get(listingId) as { public_ref: string | null } | undefined;
    if (!row?.public_ref) throw new Error(`Canonical listing ${listingId} has no public_ref`);
    return row.public_ref;
  }

  register(namespace: ListingAliasNamespace, alias: string | number, listingId: number): void {
    const value = String(alias).trim();
    if (!value || !Number.isSafeInteger(listingId) || listingId <= 0) throw new Error('Invalid listing alias');
    this.db.prepare(`INSERT OR IGNORE INTO canonical_listing_aliases(namespace,alias,listing_id) VALUES(?,?,?)`).run(namespace, value, listingId);
    const existing=this.db.prepare('SELECT listing_id FROM canonical_listing_aliases WHERE namespace=? AND alias=?').get(namespace,value) as {listing_id:number}|undefined;
    if(existing?.listing_id!==listingId)throw new Error(`Alias collision in ${namespace}: ${value}`);
  }

  resolve(namespace: ListingAliasNamespace, alias: string | number): ListingIdentity | undefined {
    const value = String(alias).trim();
    const row = this.db.prepare('SELECT listing_id FROM canonical_listing_aliases WHERE namespace=? AND alias=?').get(namespace, value) as { listing_id: number } | undefined;
    return row ? { listingId: row.listing_id, publicRef: this.publicRef(row.listing_id), namespace, alias: value } : undefined;
  }

  resolvePublicRef(ref: string): ListingIdentity | undefined {
    if (!/^lst_[a-f0-9]{32}$/.test(ref)) return undefined;
    return this.resolve('public_listing_ref', ref);
  }

  /** Dry-run map of saved legacy favorites; duplicate aliases collapse by canonical listing. */
  favoriteMigrationPreview(): Array<{ userId: number; legacyPropertyIds: number[]; listingId: number; publicRef: string }> {
    const rows = this.db.prepare(`SELECT uf.user_id,uf.property_id,a.listing_id FROM user_favorites uf
      LEFT JOIN canonical_listing_aliases a ON a.namespace='legacy_property_id' AND a.alias=CAST(uf.property_id AS TEXT)
      ORDER BY uf.user_id,uf.saved_at`).all() as Array<{ user_id: number; property_id: number; listing_id: number | null }>;
    const grouped = new Map<string, { userId: number; legacyPropertyIds: number[]; listingId: number }>();
    for (const row of rows) if (row.listing_id !== null) {
      const key = `${row.user_id}:${row.listing_id}`;
      const entry = grouped.get(key) ?? { userId: row.user_id, legacyPropertyIds: [], listingId: row.listing_id };
      entry.legacyPropertyIds.push(row.property_id); grouped.set(key, entry);
    }
    return [...grouped.values()].map((x) => ({ ...x, publicRef: this.publicRef(x.listingId) }));
  }

  /** Explicitly reports unresolved legacy favorites instead of silently dropping them. */
  favoriteMigrationAudit(): {
    mapped: Array<{ userId: number; legacyPropertyIds: number[]; listingId: number; publicRef: string }>;
    unresolved: Array<{ userId: number; legacyPropertyId: number }>;
  } {
    const rows = this.db.prepare(`SELECT uf.user_id,uf.property_id,a.listing_id FROM user_favorites uf
      LEFT JOIN canonical_listing_aliases a ON a.namespace='legacy_property_id' AND a.alias=CAST(uf.property_id AS TEXT)
      ORDER BY uf.user_id,uf.saved_at,uf.property_id`).all() as Array<{
        user_id: number; property_id: number; listing_id: number | null;
      }>;
    const unresolved = rows.filter((row) => row.listing_id === null)
      .map((row) => ({ userId: row.user_id, legacyPropertyId: row.property_id }));
    return { mapped: this.favoriteMigrationPreview(), unresolved };
  }
}
