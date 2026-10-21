import type { DatabaseSync } from 'node:sqlite';
import { ListingIdentityRepository } from './repositories/listing-identity.repo';

/** Only recognized Khmer24 listing URLs count as source identity evidence. */
export function khmer24AdId(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)
      || !['khmer24.com', 'www.khmer24.com'].includes(url.hostname.toLowerCase())
      || url.username || url.password || url.port) return null;
    const match = /^\/(?:post-adid-|en\/(?!post-adid-)[a-z0-9-]+-adid-)([1-9]\d*)\/?$/i.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

interface LegacyRow {
  id: number; original_url: string; source_url: string | null;
  title: string; bedrooms: number | null;
  type: string; city: string; category: string | null; price: number;
  currency: string; is_active: number; review_status: string;
}

interface SourceRow {
  listing_id: number; external_id: string; canonical_url: string | null; source_url: string | null;
  title: string; bedrooms: number | null;
  public_ref: string; status: string; availability_status: string;
  price: number | null; currency: string | null; city: string | null;
  category: string | null; review_status: string;
}

export type Khmer24AliasAssessment = {
  legacyId: number;
  status: 'safe' | 'already_mapped' | 'blocked';
  reason: string;
  adId?: string;
  listingId?: number;
  publicRef?: string;
  siblingLegacyId?: number;
};

function consistentAdId(urls: Array<string | null | undefined>): string | null {
  const present = urls.filter((value): value is string => Boolean(value?.trim()));
  if (!present.length) return null;
  const ids = present.map(khmer24AdId);
  return ids[0] && ids.every((id) => id === ids[0]) ? ids[0] : null;
}

function isEligibleLegacy(row: LegacyRow): boolean {
  return row.is_active === 1 && row.review_status === 'approved'
    && row.type === 'rent' && row.price > 0 && Boolean(row.category);
}

/** Deliberately fail closed: matching an adid alone is never enough to create an alias. */
export function assessKhmer24Alias(db: DatabaseSync, legacyId: number): Khmer24AliasAssessment {
  const blocked = (reason: string, adId?: string): Khmer24AliasAssessment =>
    ({ legacyId, status: 'blocked', reason, ...(adId ? { adId } : {}) });
  if (!Number.isSafeInteger(legacyId) || legacyId <= 0) return blocked('invalid_legacy_id');
  const legacy = db.prepare(`SELECT id,original_url,source_url,title,bedrooms,type,city,category,price,currency,is_active,review_status
    FROM properties WHERE id=?`).get(legacyId) as LegacyRow | undefined;
  if (!legacy) return blocked('legacy_not_found');
  const adId = consistentAdId([legacy.original_url, legacy.source_url]);
  if (!adId) return blocked('legacy_url_missing_or_conflicting');
  if (!isEligibleLegacy(legacy)) return blocked('legacy_not_approved_active_rental', adId);

  const sourceRows = db.prepare(`SELECT o.listing_id,s.external_id,s.canonical_url,s.source_url,
    l.public_ref,l.title,l.bedrooms,l.status,l.availability_status,l.price,l.currency,l.city,l.category,m.review_status
    FROM source_items s JOIN canonical_listing_source_occurrences o ON o.source_item_id=s.id AND o.is_current=1
    JOIN canonical_listings l ON l.id=o.listing_id
    JOIN canonical_listing_moderation m ON m.listing_id=l.id
    WHERE s.source_type='KHMER24' AND s.external_id IN (?,?)`)
    .all(`adid:${adId}`, adId) as unknown as SourceRow[];
  if (!sourceRows.length) return blocked('canonical_source_not_found', adId);
  if (sourceRows.some((row) => consistentAdId([row.canonical_url, row.source_url]) !== adId))
    return blocked('canonical_source_url_mismatch', adId);
  const listingIds = new Set(sourceRows.map((row) => row.listing_id));
  if (listingIds.size !== 1) return blocked('ambiguous_canonical_source', adId);
  const canonical = sourceRows[0]!;
  if (canonical.status !== 'active' || !['available', 'unknown'].includes(canonical.availability_status)
    || canonical.review_status !== 'approved') return blocked('canonical_not_visible', adId);
  if (canonical.price !== legacy.price || canonical.currency !== legacy.currency
    || canonical.city !== legacy.city || canonical.category !== legacy.category)
    return blocked('canonical_fields_mismatch', adId);

  const own = db.prepare(`SELECT listing_id FROM canonical_listing_aliases
    WHERE namespace='legacy_property_id' AND alias=?`).get(String(legacyId)) as { listing_id: number } | undefined;
  if (own && own.listing_id !== canonical.listing_id) return blocked('legacy_alias_collision', adId);

  const aliasRows = db.prepare(`SELECT p.id,p.original_url,p.source_url,p.title,p.bedrooms,p.type,p.city,p.category,p.price,
    p.currency,p.is_active,p.review_status,a.listing_id
    FROM properties p JOIN canonical_listing_aliases a
      ON a.namespace='legacy_property_id' AND a.alias=CAST(p.id AS TEXT)
    WHERE p.original_url LIKE ? OR p.source_url LIKE ?`)
    .all(`%adid-${adId}%`, `%adid-${adId}%`) as unknown as Array<LegacyRow & { listing_id: number }>;
  const sameAdSiblings = aliasRows.filter((row) => consistentAdId([row.original_url, row.source_url]) === adId);
  if (sameAdSiblings.some((row) => row.listing_id !== canonical.listing_id))
    return blocked('source_identity_alias_collision', adId);

  const compatibleSibling = (row: LegacyRow & { listing_id: number }) => row.id !== legacyId
    && row.listing_id === canonical.listing_id && isEligibleLegacy(row)
    && row.currency === legacy.currency && row.city === legacy.city
    && row.category === legacy.category && row.type === legacy.type;
  const sibling = sameAdSiblings.find((row) => compatibleSibling(row) && row.price === legacy.price);
  // Same trusted source listing can be published again at a new price. Only accept a
  // changed-price sibling when title and bedrooms independently match the new legacy
  // record AND the current canonical listing. Same adid on its own is insufficient.
  const normalizeTitle = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();
  const normalizedLegacyTitle = normalizeTitle(legacy.title);
  const revisedSibling = sibling ? undefined : sameAdSiblings.find((row) => compatibleSibling(row)
    && row.price !== legacy.price && legacy.bedrooms != null && legacy.bedrooms > 0
    && row.bedrooms === legacy.bedrooms && canonical.bedrooms === legacy.bedrooms
    && normalizedLegacyTitle.length > 0
    && normalizeTitle(row.title) === normalizedLegacyTitle
    && normalizeTitle(canonical.title) === normalizedLegacyTitle);
  if (!own && !sibling && !revisedSibling) return blocked('trusted_sibling_alias_not_found', adId);

  return { legacyId, adId, listingId: canonical.listing_id, publicRef: canonical.public_ref,
    ...(sibling || revisedSibling ? { siblingLegacyId: (sibling ?? revisedSibling)!.id } : {}),
    status: own ? 'already_mapped' : 'safe',
    reason: own ? 'existing_verified_alias' : revisedSibling
      ? 'verified_price_revision_same_source' : 'verified_duplicate_source_identity' };
}

/** Discover candidates without modifying source data, moderation or aliases. */
export function auditUnmappedKhmer24Aliases(db: DatabaseSync): Khmer24AliasAssessment[] {
  const rows = db.prepare(`SELECT p.id FROM properties p
    WHERE (p.original_url LIKE '%khmer24.com/%' OR p.source_url LIKE '%khmer24.com/%')
      AND NOT EXISTS(SELECT 1 FROM canonical_listing_aliases a
        WHERE a.namespace='legacy_property_id' AND a.alias=CAST(p.id AS TEXT))
    ORDER BY p.id`).all() as Array<{ id: number }>;
  return rows.map((row) => assessKhmer24Alias(db, row.id));
}

/** Transactional write used only against an explicitly selected, writable DB. */
export function applyKhmer24AliasRepairs(db: DatabaseSync, ids: readonly number[]): Khmer24AliasAssessment[] {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('A nonempty, unique legacy ID set is required');
  db.exec('BEGIN IMMEDIATE');
  try {
    const assessments = ids.map((id) => assessKhmer24Alias(db, id));
    const blocked = assessments.find((entry) => entry.status === 'blocked');
    if (blocked) throw new Error(`Unsafe Khmer24 alias ${blocked.legacyId}: ${blocked.reason}`);
    const repo = new ListingIdentityRepository(db);
    for (const entry of assessments) if (entry.status === 'safe') {
      repo.register('legacy_property_id', entry.legacyId, entry.listingId!);
    }
    db.exec('COMMIT');
    return assessments;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
