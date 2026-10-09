import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { PropertiesRepository, type Property, type PropertyFilterOptions } from '../src/database/repositories/properties.repo';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';
import { snapshotLegacyProperties } from '../src/database/legacy-write-guard';

const dbPath = process.env.PHASE6A_DB ?? 'data/rebuild/phase6a-checkpoint-20261007.db';
const db = new DatabaseSync(dbPath, { readOnly: true });
const legacy = new PropertiesRepository(db);
const canonical = new CanonicalListingRepository(db);

const queries: Array<{ name: string; options: PropertyFilterOptions }> = [
  { name: 'cheap_room', options: { city: 'siem_reap', type: 'rent', category: 'room', maxPrice: 30000, sort: 'price_asc' } },
  { name: 'one_bedroom_apartment', options: { city: 'siem_reap', type: 'rent', category: 'apartment', bedrooms: [1] } },
  { name: 'two_bedroom_apartment', options: { city: 'siem_reap', type: 'rent', category: 'apartment', bedrooms: [2] } },
  { name: 'house', options: { city: 'siem_reap', type: 'rent', category: 'house' } },
  { name: 'budget_under_400', options: { city: 'siem_reap', type: 'rent', maxPrice: 40000 } },
  { name: 'budget_400_to_800', options: { city: 'siem_reap', type: 'rent', minPrice: 40000, maxPrice: 80000 } },
  { name: 'sala_kamreuk', options: { city: 'siem_reap', type: 'rent', locations: ['Sala Kamreuk'] } },
  { name: 'wat_bo', options: { city: 'siem_reap', type: 'rent', locations: ['Wat Bo'] } },
  { name: 'svay_dangkum', options: { city: 'siem_reap', type: 'rent', locations: ['Svay Dangkum'] } },
  { name: 'pet_friendly', options: { city: 'siem_reap', type: 'rent', petFriendly: true } },
  { name: 'long_term_lease_up_to_12m', options: { city: 'siem_reap', type: 'rent', minLeaseMax: 12 } },
  { name: 'broad_no_area', options: { city: 'siem_reap', type: 'rent' } },
  { name: 'current_active_request', options: { city: 'siem_reap', type: 'rent' } },
];

function norm(value: string): string { return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim(); }
function tokens(value: string): Set<string> { return new Set(norm(value).split(/\s+/).filter((x) => x.length > 2)); }
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const token of a) if (b.has(token)) shared++;
  return shared / Math.max(a.size, b.size);
}
function sourceIdentity(value: string | undefined): string | null {
  if (!value) return null;
  const k24 = value.match(/adid[:\-_/]?(\d+)/i);
  if (/khmer24/i.test(value) && k24) return `KHMER24:${k24[1]}`;
  const fb = value.match(/facebook\.com\/groups\/([^/?#]+)\/posts?\/([^/?#]+)/i);
  if (fb) return `FACEBOOK_GROUP:${fb[1]}:${fb[2]}`;
  return null;
}
function matchScore(a: Property, b: Property): number {
  const sourceA=sourceIdentity(a.original_url||a.source_url); const sourceB=sourceIdentity(b.original_url||b.source_url);
  if (sourceA && sourceA===sourceB) return 1.1;
  const url = (value: string) => { try { const parsed=new URL(value); return `${parsed.hostname.toLowerCase().replace(/^www\./,'')}${parsed.pathname.replace(/\/$/,'')}`; } catch { return norm(value); } };
  if (a.original_url && b.original_url && url(a.original_url) === url(b.original_url)) return 1;
  if (a.city !== b.city || a.type !== b.type || (a.category ?? '') !== (b.category ?? '')) return 0;
  const phone = (value: string | undefined) => value?.replace(/\D/g,'').slice(-8);
  if (phone(a.direct_contact.phone) && phone(a.direct_contact.phone) === phone(b.direct_contact.phone)) return 0.92;
  let score = 0;
  if (a.bedrooms === b.bedrooms) score += 0.2;
  if (a.price === b.price || (a.price > 0 && b.price > 0 && Math.abs(a.price-b.price)/Math.max(a.price,b.price) < 0.08)) score += 0.2;
  if (norm(a.location) === norm(b.location) || norm(a.location).includes(norm(b.location)) || norm(b.location).includes(norm(a.location))) score += 0.25;
  score += overlap(tokens(a.title), tokens(b.title)) * 0.35;
  return score;
}
function compare(a: Property[], b: Property[]) {
  const unmatched = new Set(b.map((_, i) => i)); const pairs: Array<[number, number, number]> = [];
  for (let ai=0; ai<a.length; ai++) {
    const identity=sourceIdentity(a[ai].original_url||a[ai].source_url);
    const exact=identity ? b.findIndex((item)=>sourceIdentity(item.original_url||item.source_url)===identity) : -1;
    if (exact>=0) { pairs.push([ai,exact,1.1]); unmatched.delete(exact); continue; }
    let best = -1; let bestScore = 0;
    for (const bi of unmatched) { const score = matchScore(a[ai], b[bi]); if (score > bestScore) { best=bi; bestScore=score; } }
    if (best >= 0 && bestScore >= 0.55) { pairs.push([ai,best,bestScore]); unmatched.delete(best); }
  }
  const matchedA = new Set(pairs.map(([ai]) => ai));
  return { pairs, legacyOnly: a.filter((_,i)=>!matchedA.has(i)), canonicalOnly: [...unmatched].map(i=>b[i]) };
}
function summary(property: Property) {
  const dto = { id:property.id, title:property.title, price:property.price, category:property.category, bedrooms:property.bedrooms,
    location:property.location, photos:property.photos.length, hasPhone:Boolean(property.direct_contact.phone),
    source:property.source_url?.includes('facebook') ? 'facebook' : property.source_url?.includes('khmer24') ? 'khmer24' : 'other',
    sourceUrl:property.source_url,
    observedAgeDays: Math.max(0, Math.floor((Date.now()-Date.parse(property.updated_at))/86400000)),
    reviewHint: /phnom penh|kandal/i.test(`${property.title} ${property.location}`) ? 'location conflicts with Siem Reap query; verify source geography'
      : property.price <= 0 ? 'missing or zero price'
        : property.bedrooms === null ? 'bedroom count absent'
          : !property.direct_contact.phone && !property.direct_contact.telegram && !property.direct_contact.whatsapp ? 'direct contact absent'
            : 'candidate needs source review' };
  return dto;
}
function median(values:number[]):number { const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.floor(sorted.length/2)]??0; }

const queryResults = queries.map(({name,options}) => {
  const legacyTimes:number[]=[]; let l=legacy.searchProperties({...options,limit:100});
  for(let i=0;i<5;i++){const started=performance.now();l=legacy.searchProperties({...options,limit:100});legacyTimes.push(performance.now()-started);}
  const canonicalTimes:Array<{wall:number;diagnostics:typeof canonical.lastDiagnostics}>=[]; let c=canonical.searchProperties({...options,limit:500});
  for(let i=0;i<5;i++){const started=performance.now();c=canonical.searchProperties({...options,limit:500});canonicalTimes.push({wall:performance.now()-started,diagnostics:{...canonical.lastDiagnostics}});}
  const canonicalDiag=canonicalTimes[Math.floor(canonicalTimes.length/2)]!.diagnostics;
  const comparison=compare(l.items,c.items);
  return { name, legacy:{count:l.total, returned:l.items.length, latencyMs:+median(legacyTimes).toFixed(2),runs:legacyTimes.map(x=>+x.toFixed(2))},
    canonical:{count:c.total, returned:c.items.length, matchTiers:c.items.reduce((acc,item)=>{const tier=item.match_tier??'UNKNOWN';acc[tier]++;return acc;},{EXACT:0,PROBABLE:0,UNKNOWN:0} as Record<'EXACT'|'PROBABLE'|'UNKNOWN',number>),cityTiers:c.items.reduce((acc,item)=>{const tier=item.city_tier??'UNKNOWN_CITY';acc[tier]++;return acc;},{EXACT_CITY:0,PROBABLE_CITY:0,UNKNOWN_CITY:0} as Record<'EXACT_CITY'|'PROBABLE_CITY'|'UNKNOWN_CITY',number>),latencyMs:+median(canonicalTimes.map(x=>x.wall)).toFixed(2),runs:canonicalTimes.map(x=>({wallMs:+x.wall.toFixed(2),...x.diagnostics})),...canonicalDiag},
    overlap:comparison.pairs.length, overlapPercent:l.items.length ? +(comparison.pairs.length/l.items.length*100).toFixed(1) : null,
    canonicalOnlyCount:comparison.canonicalOnly.length, legacyOnlyCount:comparison.legacyOnly.length,
    top10Differences:{legacyOnly:comparison.legacyOnly.slice(0,10).map(summary),canonicalOnly:comparison.canonicalOnly.slice(0,10).map(summary)},
    sampledCanonicalOnly:comparison.canonicalOnly.slice(0,10).map(summary),
    sampledLegacyOnly:comparison.legacyOnly.slice(0,10).map(summary), explain:canonical.explainSearch(options) };
});

const baseline = db.prepare(`SELECT
 (SELECT COUNT(*) FROM properties) legacy_properties,
 (SELECT COUNT(*) FROM canonical_properties) canonical_properties,
 (SELECT COUNT(*) FROM canonical_listings) canonical_listings,
 (SELECT COUNT(*) FROM canonical_listings WHERE status='active' AND availability_status NOT IN ('rented','removed')) active_listings,
 (SELECT COUNT(*) FROM canonical_listing_source_occurrences WHERE is_current=1) current_occurrences,
 (SELECT COUNT(*) FROM canonical_listing_source_occurrences WHERE is_current=0) historical_occurrences,
 (SELECT COUNT(*) FROM source_items) source_items,
 (SELECT COUNT(*) FROM source_item_versions) versions`).get();
const duplicateBindings = db.prepare(`SELECT COUNT(*) n FROM (SELECT source_item_id,source_entity_key FROM canonical_listing_source_occurrences WHERE is_current=1 GROUP BY 1,2 HAVING COUNT(*)>1)`).get() as {n:number};
const duplicateCanonical = db.prepare(`SELECT COUNT(*) n FROM (SELECT algorithm_version,canonical_key FROM canonical_listings WHERE canonical_key IS NOT NULL GROUP BY 1,2 HAVING COUNT(*)>1)`).get() as {n:number};
const legacySnapshot = snapshotLegacyProperties(db);
const activeFilters = db.prepare('SELECT * FROM search_filters WHERE is_active=1 ORDER BY created_at DESC').all();
const allLegacy=legacy.searchProperties({city:'siem_reap',type:'rent',limit:100});
const allCanonical=canonical.searchProperties({city:'siem_reap',type:'rent',limit:500});
const cityCandidates=canonical.searchProperties({city:'siem_reap',limit:500});
const overall=compare(allLegacy.items,allCanonical.items);
const legacyOnlyAudit=overall.legacyOnly.map((property)=>{
  const identity=sourceIdentity(property.original_url||property.source_url);
  let sourceItems:Record<string,unknown>[]=[];
  if(identity?.startsWith('KHMER24:')) sourceItems=db.prepare(`SELECT * FROM source_items WHERE source_type='KHMER24' AND external_id IN (?,?)`).all(identity.slice(8),`adid:${identity.slice(8)}`) as Record<string,unknown>[];
  else if(identity?.startsWith('FACEBOOK_GROUP:')) { const [,group,post]=identity.split(':'); sourceItems=db.prepare(`SELECT * FROM source_items WHERE source_type='FACEBOOK_GROUP' AND (external_id=? OR canonical_url LIKE ? OR source_url LIKE ?) AND (group_id=? OR group_id IS NULL)`).all(post,`%${post}%`,`%${post}%`,group) as Record<string,unknown>[]; }
  const ids=sourceItems.map((x)=>Number(x.id));
  const occurrences=ids.length?db.prepare(`SELECT o.id,o.source_item_id,o.listing_id,o.is_current,o.ended_at,o.dedupe_decision_id,o.repost_cluster_id,o.source_url,l.status,l.availability_status,l.city,l.title
    FROM canonical_listing_source_occurrences o LEFT JOIN canonical_listings l ON l.id=o.listing_id WHERE o.source_item_id IN (${ids.map(()=>'?').join(',')}) ORDER BY o.is_current DESC,o.id`).all(...ids) as Record<string,unknown>[]:[];
  const identityCanonicalCandidates=allCanonical.items.filter((x)=>identity&&sourceIdentity(x.original_url||x.source_url)===identity).map((x)=>x.id);
  const currentCanonicalCandidates=occurrences.filter((x)=>Number(x.is_current)===1).map((x)=>Number(x.listing_id));
  const classification=sourceItems.some((x)=>x.classification==='IRRELEVANT')?'IRRELEVANT'
    :sourceItems.length===0?'NO_SOURCE_ITEM'
      :identityCanonicalCandidates.length?'COMPARATOR_MISMATCH'
        :occurrences.some((x)=>Number(x.is_current)===1)?'CORRECTLY_EXCLUDED'
          :occurrences.length?'CLOSED_OCCURRENCE':'MATERIALIZATION_GAP';
  return {legacyId:property.id,title:property.title,sourceUrl:property.original_url||property.source_url,sourceIdentity:identity,category:classification,
    sourceItems:sourceItems.map((x)=>({id:x.id,classification:x.classification,source_type:x.source_type,external_id:x.external_id,group_id:x.group_id,canonical_url:x.canonical_url})),
    occurrences,identityCanonicalCandidates,currentCanonicalCandidates,
    clusterMemberships:ids.length?db.prepare(`SELECT cm.source_item_id,cm.cluster_id,cm.occurrence_id,cm.occurrence_type,cm.score,cm.reason FROM dedupe_cluster_members cm WHERE cm.source_item_id IN (${ids.map(()=>'?').join(',')})`).all(...ids):[],
    decisionIds:occurrences.map((x)=>x.dedupe_decision_id).filter(Boolean)};
});
const fieldStats = allCanonical.items.reduce((acc,p)=>{
  acc.total++;
  if(p.title)acc.title++; if(p.description)acc.description++; if(p.price>0)acc.price++; if(p.category||p.property_type)acc.type++;
  if(p.bedrooms!==null)acc.bedrooms++; if(p.location)acc.location++; if(p.amenities?.length)acc.amenities++;
  if(p.photos.length)acc.photos++; if(p.source_url)acc.sourceLink++; if(p.direct_contact.phone||p.direct_contact.telegram||p.direct_contact.whatsapp)acc.contact++;
  if(p.last_verified_at||p.updated_at)acc.freshness++;
  return acc;
},{total:0,title:0,description:0,price:0,type:0,bedrooms:0,location:0,amenities:0,photos:0,sourceLink:0,contact:0,freshness:0});
const matchTopology=cityCandidates.items.reduce((acc,p)=>{const key=`${p.city_tier??'UNKNOWN_CITY'}__${p.match_tier??'UNKNOWN'}`;acc[key]=(acc[key]??0)+1;return acc;},{} as Record<string,number>);
const canonicalOnlyAudit=overall.canonicalOnly.map((p)=>{
  const hint=`${p.title} ${p.location} ${p.raw_text??''}`.toLowerCase();
  const explicitOutside=/phnom\s*penh|ភ្នំពេញ|\bkandal\b|ខេត្តកណ្ដាល|sihanoukville/.test(`${p.title} ${p.location}`.toLowerCase());
  const age=Math.max(0,Math.floor((Date.now()-Date.parse(p.updated_at))/86400000));
  const label=explicitOutside?'OUT_OF_AREA':age>60?'STALE':(!p.direct_contact.phone&&!p.direct_contact.telegram&&!p.direct_contact.whatsapp)||p.bedrooms===null?'INCOMPLETE_BUT_VALID':'VALID_NEW_INVENTORY';
  return {...summary(p),label,evidence:explicitOutside?'explicit city in title/location':label==='STALE'?`last seen ${age} days ago`:label==='INCOMPLETE_BUT_VALID'?'contact or bedrooms missing':'priced listing with source link'};
});
const outOfAreaReturned=allCanonical.items.filter((p)=>/phnom\s*penh|ភ្នំពេញ|\bkandal\b|ខេត្តកណ្ដាល|sihanoukville/i.test(`${p.title} ${p.location}`)).map(summary);
const report = {
  generatedAt:new Date().toISOString(), database:dbPath,
  checkpoint:{...baseline, legacyDigest:legacySnapshot.digest, duplicateCurrentBindings:duplicateBindings.n, duplicateCanonicalKeys:duplicateCanonical.n,
    integrity:db.prepare('PRAGMA integrity_check').get(), foreignKeyViolations:db.prepare('PRAGMA foreign_key_check').all().length},
  currentActiveRequests:activeFilters,
  queryResults,
  legacyOnlyAudit,
  canonicalOnlyAudit,
  overallSiemReapRent:{legacyReturned:allLegacy.items.length,canonicalReturned:allCanonical.items.length,
    semanticOverlap:overall.pairs.length,legacyOnly:overall.legacyOnly.length,canonicalOnly:overall.canonicalOnly.length,
    cityTiers:cityCandidates.items.reduce((acc,p)=>{const tier=p.city_tier??'UNKNOWN_CITY';acc[tier]++;return acc;},{EXACT_CITY:0,PROBABLE_CITY:0,UNKNOWN_CITY:0} as Record<'EXACT_CITY'|'PROBABLE_CITY'|'UNKNOWN_CITY',number>),
    offerTiers:cityCandidates.items.reduce((acc,p)=>{const tier=p.match_tier??'UNKNOWN';acc[tier]++;return acc;},{EXACT:0,PROBABLE:0,UNKNOWN:0} as Record<'EXACT'|'PROBABLE'|'UNKNOWN',number>),cityOfferCrossTab:matchTopology,
    sampledLegacyOnly:overall.legacyOnly.slice(0,25).map(summary),sampledCanonicalOnly:overall.canonicalOnly.slice(0,25).map(summary),
    explicitOutOfAreaReturned:outOfAreaReturned},
  dtoCompleteness:fieldStats,
  displayability:{candidateCount:cityCandidates.total,missingOrZeroPrice:cityCandidates.items.filter((p)=>p.price<=0).length,
    missingBedrooms:cityCandidates.items.filter((p)=>p.bedrooms===null).length,
    missingDirectContact:cityCandidates.items.filter((p)=>!p.direct_contact.phone&&!p.direct_contact.telegram&&!p.direct_contact.whatsapp).length,
    missingPhoto:cityCandidates.items.filter((p)=>!p.photos.length).length,
    defaultRentSearch:{displayed:allCanonical.total,missingOrZeroPrice:allCanonical.items.filter((p)=>p.price<=0).length,
      unknownBedrooms:allCanonical.items.filter((p)=>p.bedrooms===null).length,
      missingDirectContact:allCanonical.items.filter((p)=>!p.direct_contact.phone&&!p.direct_contact.telegram&&!p.direct_contact.whatsapp).length,
      missingPhoto:allCanonical.items.filter((p)=>!p.photos.length).length},
    rules:['explicit sale and unknown sale-only evidence are excluded from rent search','confirmed rent ranks EXACT; rental language or mixed offer ranks PROBABLE; unclear offer ranks UNKNOWN','unknown price remains eligible and ranks below priced matches when budget filters are present','unknown bedrooms remain eligible and rank below exact bedroom matches','explicit contradictory geography remains excluded'],
  },
  readSurfaceInventory:{
    listSearch:'GET /api/v1/properties uses legacy by default; canonical read shadow runs only when LISTING_READ_SHADOW=true; canonical serving requires LISTING_READ_PATH=canonical.',
    detail:'GET /api/v1/properties/:id switches with LISTING_READ_PATH; canonical IDs are not yet compatible with saved legacy favorite IDs.',
    map:'GET /api/v1/properties/map remains on PropertiesRepository legacy IDs.',
    favorites:'Favorites list/toggle storage and lookup remain legacy property IDs.',
    moderation:'Admin review actions and moderation reads remain tied to legacy properties.review_status.',
    tracking:'Tracking/contact analytics references property/listing identifiers; canonical compatibility mapping is not yet established.',
    productionCutover:false},
  acceptance:{unexpectedMissing:legacyOnlyAudit.filter((x)=>!['CORRECTLY_EXCLUDED','NO_SOURCE_ITEM','CLOSED_OCCURRENCE','IRRELEVANT','COMPARATOR_MISMATCH','CANONICAL_DEDUPE_MERGE'].includes(x.category)).map((x)=>x.legacyId),
    suspectedFalseMerges:'not inferable from IDs; requires visual/source review',suspectedFalseSplits:'not inferable from IDs; requires source-level review',miniAppCutover:false}
};
const out='reports/phase6a-canonical-read-parity-20261007.json';
writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({out,checkpoint:report.checkpoint,currentActiveRequests:activeFilters.length,queryResults:queryResults.map(q=>({name:q.name,legacy:q.legacy.count,canonical:q.canonical.count,overlap:q.overlap,legacyOnly:q.legacyOnlyCount,canonicalOnly:q.canonicalOnlyCount})),dtoCompleteness:fieldStats,overall:report.overallSiemReapRent},null,2));
db.close();
