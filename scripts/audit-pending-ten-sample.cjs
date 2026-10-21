/** Read-only inspection of ten varied current DEFAULT_PENDING records. */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { evaluateModerationCandidate } = require(process.cwd() + '/dist/modules/parser/canonical-moderation-policy.js');
const { sourceRoomCounts } = require(process.cwd() + '/dist/modules/parser/source-room-counts.js');

const ids = [6080, 6990, 7445, 9778, 9889, 11308, 8558, 8964, 8861, 8832];
const db = new DatabaseSync(process.env.HOMEASY_AUDIT_DB || '/app/data/homeasy.db', { readOnly: true });
const scrub = (value) => String(value || '').replace(/(?:\+?855|0)(?:[\s-]?\d){8,10}/g, '[phone redacted]');
const cases = [];
try {
  const sql = `SELECT l.id,l.public_ref,l.status,l.availability_status,l.title,l.description,l.price,l.bedrooms,l.bathrooms,
    l.city,l.category,l.property_type,l.listing_facts_json,m.review_reason,m.decision_origin,m.policy_version,s.id source_item_id,s.external_id,s.source_type,
    COALESCE(o.source_url,s.canonical_url,s.source_url) source_url,s.raw_text,s.raw_payload_json,
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
    WHERE l.id=?`;
  const get = db.prepare(sql);
  const occurrences = db.prepare(`SELECT o.id,o.source_item_id,o.external_id,o.source_url,o.is_current,o.posted_at,o.source_entity_key,
    s.source_type,s.external_id item_external_id,s.canonical_url,s.published_at,s.raw_text
    FROM canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
    WHERE o.listing_id=? ORDER BY o.is_current DESC,o.id`);
  const sameUrl = db.prepare(`SELECT o.listing_id,l.title,l.price,m.review_status FROM canonical_listing_source_occurrences o
    JOIN canonical_listings l ON l.id=o.listing_id JOIN canonical_listing_moderation m ON m.listing_id=l.id
    WHERE o.source_url=? AND o.is_current=1 ORDER BY o.listing_id LIMIT 8`);
  const possibleDuplicates = db.prepare(`SELECT id, title,price,bedrooms FROM canonical_listings
    WHERE id<>? AND status='active' AND lower(trim(title))=lower(trim(?)) AND price=? AND COALESCE(city,'')=COALESCE(?,'')
    ORDER BY id LIMIT 8`);
  for (const id of ids) {
    const row = get.get(id);
    if (!row) { cases.push({id, missing:true}); continue; }
    const payload = JSON.parse(row.raw_payload_json || '{}');
    const listing = payload.listing || payload.listingFacts || payload.listingExtraction || {};
    const occ = occurrences.all(id);
    let facts = {};
    try { facts = JSON.parse(row.listing_facts_json || '{}'); } catch {}
    const sourceText = `${listing.source_title || ''}\n${row.raw_text || ''}`;
    const matchingUrls = row.source_url ? sameUrl.all(row.source_url) : [];
    cases.push({
      id,publicRef:row.public_ref,canonical:{title:row.title,priceUSD:row.price/100,bedrooms:row.bedrooms,bathrooms:row.bathrooms,
        city:row.city,category:row.category,status:row.status,availability:row.availability_status},
      moderation:{decisionOrigin:row.decision_origin,reviewReason:row.review_reason,policyVersion:row.policy_version,
        reasons:evaluateModerationCandidate(row).reasons},
      source:{type:row.source_type,url:row.source_url,externalId:row.external_id,itemId:row.source_item_id,
        originalPublishedAt:row.original_published_at,firstSeen:row.first_source_seen_at,
        headline:listing.source_title || null,fields:{type:listing.type,price:listing.price,source_price:listing.source_price,
          source_price_origin:listing.source_price_origin,source_price_currency:listing.source_price_currency,
          city:listing.city,bedrooms:listing.bedrooms,bathrooms:listing.bathrooms},
        payloadKeys:Object.keys(payload),listingKeys:Object.keys(listing),payloadLocation:payload.location || null,
        sourceRoomCounts:sourceRoomCounts(sourceText),rawText:scrub(row.raw_text).slice(0,2800),rawLength:row.raw_text?.length || 0},
      persistedFacts:{keys:Object.keys(facts),rooms:facts.bedrooms??facts.bedroom_count??null,bathrooms:facts.bathrooms??null,
        city:facts.city??null,price:facts.price??null,location:facts.location??null,source:facts.source??null},
      binding:{currentCount:row.current_count,conflictingUrl:row.conflicting_url,
        sourceOccurrences:occ.map(o=>({id:o.id,itemId:o.source_item_id,externalId:o.external_id,sourceUrl:o.source_url,
          isCurrent:o.is_current,postedAt:o.posted_at,itemPublished:o.published_at,sourceEntityKey:o.source_entity_key,
          textLength:o.raw_text?.length || 0,textHash:createHash('sha256').update((o.raw_text || '').replace(/^English below\s*/gi,'').trim()).digest('hex').slice(0,12),
          snippet:scrub(o.raw_text).slice(0,160)})),
        urlMatches:matchingUrls,possibleDuplicates:possibleDuplicates.all(id,row.title,row.price,row.city),
        matchingActiveCount:row.matching_active_listings},
    });
  }
  for (const relatedId of [381,8995]) {
    const row = get.get(relatedId);
    if (!row) continue;
    const payload = JSON.parse(row.raw_payload_json || '{}');
    const listing = payload.listing || payload.listingFacts || payload.listingExtraction || {};
    cases.push({relatedCase:true,id:relatedId,canonical:{title:row.title,priceUSD:row.price/100,bedrooms:row.bedrooms,bathrooms:row.bathrooms},
      moderation:{origin:row.decision_origin,reasons:evaluateModerationCandidate(row).reasons},source:{type:row.source_type,url:row.source_url,
        fields:{price:listing.price,source_title:listing.source_title,city:listing.city},rawText:scrub(row.raw_text).slice(0,2400)},
      binding:{sourceOccurrences:occurrences.all(relatedId).map(o=>({itemId:o.source_item_id,externalId:o.external_id,url:o.source_url,current:o.is_current}))}});
  }
  console.log(JSON.stringify({dbPath:process.env.HOMEASY_AUDIT_DB || '/app/data/homeasy.db',cases},null,2));
} finally { db.close(); }
