/** Read-only source-evidence audit of every Pending canonical listing under policy v11. */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  evaluateModerationCandidate,
  evaluateCorroboratedCrossposts,
  MODERATION_POLICY_VERSION,
} = require(path.join(process.cwd(), 'dist/modules/parser/canonical-moderation-policy.js'));

const dbPath = process.env.HOMEASY_AUDIT_DB || '/app/data/homeasy.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

try {
  const rows = db.prepare(`SELECT l.id,l.status,l.availability_status,l.title,l.description,l.price,l.bedrooms,l.bathrooms,
    l.city,l.category,l.property_type,
    CASE WHEN m.decision_origin='INGESTION_VALIDATED_V1'
      AND m.review_reason LIKE 'INGESTION_VALIDATED_V1: held for manual review (%'
      THEN NULL ELSE m.review_reason END review_reason,
    m.decision_origin,s.source_type,l.primary_source_occurrence_id,
    COALESCE(o.source_url,s.canonical_url,s.source_url) source_url,
    s.raw_text,s.raw_payload_json,
    (SELECT COALESCE(h.posted_at,t.published_at) FROM canonical_listing_source_occurrences h
      JOIN source_items t ON t.id=h.source_item_id WHERE h.listing_id=l.id
      AND COALESCE(julianday(h.posted_at),julianday(t.published_at)) IS NOT NULL
      ORDER BY COALESCE(julianday(h.posted_at),julianday(t.published_at)),h.id LIMIT 1) original_published_at,
    (SELECT h.first_seen_at FROM canonical_listing_source_occurrences h WHERE h.listing_id=l.id
      ORDER BY julianday(h.first_seen_at),h.id LIMIT 1) first_source_seen_at,
    (SELECT COUNT(*) FROM canonical_listings other WHERE other.id<>l.id AND other.status='active'
      AND lower(trim(other.title))=lower(trim(l.title)) AND other.price=l.price
      AND COALESCE(other.city,'')=COALESCE(l.city,'')
      AND COALESCE(other.bedrooms,-1)=COALESCE(l.bedrooms,-1)) matching_active_listings,
    (SELECT COUNT(*) FROM canonical_listing_source_occurrences x WHERE x.listing_id=l.id AND x.is_current=1) current_count,
    EXISTS(SELECT 1 FROM canonical_listing_source_occurrences x JOIN canonical_listing_source_occurrences y
      ON y.source_url=x.source_url AND y.listing_id<>x.listing_id AND y.is_current=1
      WHERE x.listing_id=l.id AND x.is_current=1 AND x.source_url IS NOT NULL) conflicting_url,
    (SELECT COUNT(*) FROM canonical_listing_aliases a WHERE a.listing_id=l.id AND a.namespace='legacy_property_id') legacy_aliases
    FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id
    LEFT JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id
    LEFT JOIN source_items s ON s.id=o.source_item_id
    WHERE m.review_status='pending' ORDER BY l.id`).all();

  const currentSources = db.prepare(`SELECT o.id occurrence_id,o.source_item_id,s.source_type,
    COALESCE(o.source_url,s.canonical_url,s.source_url) source_url,s.raw_text,s.raw_payload_json
    FROM canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
    WHERE o.listing_id=? AND o.is_current=1 ORDER BY o.id`);
  const reasonCounts = {};
  const listings = rows.map((row) => {
    const sources = row.current_count > 1 ? currentSources.all(row.id) : [];
    const decision = row.current_count > 1
      ? evaluateCorroboratedCrossposts(row, sources)
      : evaluateModerationCandidate(row);
    for (const reason of decision.reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    return {
      id: row.id,
      origin: row.decision_origin,
      sourceType: row.source_type,
      currentSources: row.current_count,
      city: row.city,
      price: row.price,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      reasons: decision.reasons,
    };
  });

  console.log(JSON.stringify({
    policy: MODERATION_POLICY_VERSION,
    dbPath,
    totalPending: rows.length,
    wouldAutoApprove: listings.filter((row) => row.reasons.length === 0).map((row) => row.id),
    reasonCounts: Object.fromEntries(Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])),
    listings,
  }, null, 2));
} finally {
  db.close();
}
