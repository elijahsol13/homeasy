/** Read-only geography evidence audit. Never prints listing prose or map URLs. */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { extractMapsUrl } = require(path.join(process.cwd(), 'dist/modules/parser/extractor.js'));
const { extractCoordinatesFromMapsUrl, isCoordinateInSanityBounds } = require(
  path.join(process.cwd(), 'dist/config/locations.js'));
const { assessSiemReapGeography } = require(path.join(process.cwd(), 'dist/modules/parser/source-geography.js'));

const dbPath = process.env.HOMEASY_AUDIT_DB || '/app/data/homeasy.db';
const db = new DatabaseSync(dbPath, { readOnly: true });
const cityMention = /\bsiem\s*reap\b|សៀមរាប/i;
const otherCityMention = /\b(?:phnom\s*penh|phnompenh|battambang|poipet|kampot|sihanoukville|takeo|kep)\b|ភ្នំពេញ/i;
const marketingDistance = /(?:\b\d+\s*(?:min(?:ute)?s?|km)\b|\b(?:walk|walking|drive|driving)\b|\bnear\b|\bclose\s+to\b)[^\n]{0,100}\b(?:pub\s*street|old\s*market|angkor\s*wat|night\s*market)\b/i;
const namedArea = /\b(?:sala\s*kam(?:reuk|roek)|svay\s*dangkum|sl[ao]r?\s*kram|wat\s*bo|wat\s*damnak|wat\s*polanka|chreav|bakong|kok\s*chak)\b|សាលាកំរើក|ស្លក្រាម/i;
const explicitLabel = /(?:^|\n)\s*(?:property\s+)?(?:location|address|area|sangkat|commune|ទីតាំង)\s*[:：=-]/im;

function mapKind(url) {
  if (!url) return 'none';
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* classify using original */ }
  if (/!3d-?\d+\.\d+!4d-?\d+\.\d+/i.test(decoded)) return 'selected_place_pin';
  if (/[?&](?:query|q)=-?\d+\.\d+%?2?c?-?\d+\.\d+/i.test(decoded)) return 'explicit_coordinate_query';
  if (/[?&]ll=-?\d+\.\d+%?2?c?-?\d+\.\d+/i.test(decoded)) return 'll_coordinate';
  if (/@-?\d+\.\d+,-?\d+\.\d+/i.test(decoded)) return 'camera_center_only';
  if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(decoded)) return 'short_link_unresolved';
  return 'place_or_address_query';
}

try {
  const requestedIds = (process.env.HOMEASY_AUDIT_IDS ?? '').split(',').map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  const idFilter = requestedIds.length ? ` AND l.id IN (${requestedIds.map(() => '?').join(',')})` : '';
  const listings = db.prepare(`SELECT l.id,l.city,m.review_status
    FROM canonical_listings l JOIN canonical_listing_moderation m ON m.listing_id=l.id
    WHERE m.review_status='pending'${idFilter} ORDER BY l.id`).all(...requestedIds);
  const occurrences = db.prepare(`SELECT o.listing_id,s.source_type,s.group_name,s.raw_text,s.raw_payload_json
    FROM canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
    WHERE o.listing_id=? AND o.is_current=1 ORDER BY o.id`);
  const evidence = listings.map((listing) => {
    const sources = occurrences.all(listing.id);
    const perSource = sources.map((source) => {
      const raw = source.raw_text ?? '';
      let payload = {};
      try { payload = JSON.parse(source.raw_payload_json ?? '{}'); } catch { /* continue with literal source text */ }
      const extraction = payload.listingExtraction ?? payload.listingFacts ?? payload.listing ?? {};
      const payloadMaps = Array.isArray(extraction.maps_urls)
        ? extraction.maps_urls.filter((value) => typeof value === 'string') : [];
      const mapUrls = [...new Set([extractMapsUrl(raw), ...payloadMaps].filter(Boolean))];
      const mapKinds = mapUrls.map(mapKind);
      const coordinateProofs = mapUrls.map((url) => {
        const coords = extractCoordinatesFromMapsUrl(url);
        return Boolean(coords && isCoordinateInSanityBounds(coords.latitude, coords.longitude, 'siem_reap')
          && mapKind(url) !== 'camera_center_only' && mapKind(url) !== 'short_link_unresolved');
      });
      return {
        sourceType: source.source_type,
        groupSignalsSiemReap: /siem\s*reap/i.test(source.group_name ?? ''),
        sourceTextMentionsSiemReap: cityMention.test(raw),
        sourceTextMentionsOtherCity: otherCityMention.test(raw),
        explicitLocationLabel: explicitLabel.test(raw),
        recognizedSangkatOrAreaTerm: namedArea.test(raw),
        promotionalDistanceToLandmark: marketingDistance.test(raw),
        sourceTextHasMapsUrl: Boolean(extractMapsUrl(raw)),
        payloadHasMapsUrls: payloadMaps.length > 0,
        sourceMapKinds: mapKinds,
        mapPinCoordinatesInSiemReapBounds: coordinateProofs.some(Boolean),
        payloadHasSangkat: Boolean(extraction.sangkat),
        payloadHasExplicitLocation: Boolean(extraction.explicit_location),
        sourceGeography: assessSiemReapGeography({ rawText: raw }).tier,
      };
    });
    return { id: listing.id, canonicalCity: listing.city, sourceCount: sources.length, sources: perSource };
  });
  console.log(JSON.stringify({ totalPending: listings.length, evidence }, null, 2));
} finally {
  db.close();
}
