import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';

const dbPath = process.env.PHASE6A_DB ?? 'data/rebuild/phase6a-checkpoint-20261007.db';
const db = new DatabaseSync(dbPath, { readOnly: true });
type Row = Record<string, unknown> & { id: number };
const rows = db.prepare(`
  SELECT l.id,l.status,l.availability_status,l.city,l.title,l.description,l.price,l.currency,
    l.category,l.property_type,l.bedrooms,l.bathrooms,l.sangkat,l.explicit_location,l.listing_facts_json,
    o.id occurrence_id,o.source_url,o.group_id,o.group_name,o.is_current,s.id source_item_id,
    s.source_type,s.external_id,s.classification,s.raw_text,s.raw_payload_json,
    p.city property_city,p.sangkat property_sangkat,p.explicit_location property_explicit_location,p.canonical_address,
    json_extract(l.listing_facts_json,'$.offer_type') offer_type,
    json_extract(l.listing_facts_json,'$.city') facts_city,
    json_extract(l.listing_facts_json,'$.explicit_location') facts_explicit_location
  FROM canonical_listings l
  LEFT JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id AND o.is_current=1
  LEFT JOIN source_items s ON s.id=o.source_item_id
  LEFT JOIN canonical_properties p ON p.id=l.property_id
  WHERE l.status='active' AND l.city='siem_reap'
`).all() as Row[];

const compact = (x: unknown) => typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : '';
function parsePayload(value: unknown): Record<string,unknown> { try { return typeof value==='string'?JSON.parse(value) as Record<string,unknown>:{}; } catch { return {}; } }
const stripSensitive = (text: string) => text
  .replace(/https?:\/\/\S+/gi, '[link]')
  .replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
const cityNames = ['phnom penh','phnompenh','ភ្នំពេញ','kandal','ខេត្តកណ្ដាល','sihanoukville','preah sihanouk','battambang','kampot','kep','poipet','kampong cham','kampong thom','kampong speu','kampong chhnang','koh kong','kratie','mondulkiri','ratanakiri','pursat','takeo','svay rieng','bavet','stung treng','pailin','banteay meanchey','prey veng','tbong khmum'];
function detectGeography(row: Row): { kind: 'OUT_OF_AREA'|'GEOGRAPHY_CONFLICT'; city: string; evidence: string } | undefined {
  const explicitFields = [row.explicit_location,row.property_explicit_location,row.sangkat,row.property_sangkat,row.canonical_address,row.facts_explicit_location,row.facts_city]
    .map(compact).filter(Boolean);
  const title = compact(row.title).toLowerCase();
  const raw = `${compact(row.raw_text)} ${compact(row.description)}`.toLowerCase();
  const titleCity = cityNames.find((name) => title.includes(name));
  const bodySiemReap = /siem\s*reap|siemreap|សៀមរាប|pub street|old market/i.test(raw)
    || explicitFields.some((value) => /siem\s*reap|siemreap|សៀមរាប/i.test(value));
  if (titleCity && bodySiemReap) return { kind:'GEOGRAPHY_CONFLICT', city:titleCity, evidence:`title=${compact(row.title)}; body/location has Siem Reap evidence` };
  for (const field of explicitFields) {
    const match = cityNames.find((name) => field.toLowerCase().includes(name));
    if (match) return { kind:'OUT_OF_AREA', city:match, evidence:`structured location: ${field}` };
  }
  if (titleCity) {
    const contextual = new RegExp(`(?:in|located in|location:)\\s*${titleCity.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}`, 'i');
    if (contextual.test(title)) return { kind:'OUT_OF_AREA', city:titleCity, evidence:`title: ${compact(row.title)}` };
  }
  return undefined;
}
function offerSignals(row: Row) {
  const text = `${compact(row.title)} ${compact(row.raw_text)} ${compact(row.description)}`;
  const rental = /\bfor rent\b|\brental\b|\brent\b|lease|ជួល/i.test(text);
  const sale = /\bfor sale\b|\bselling\b|\bsale\b|\bsell\b|លក់/i.test(text);
  return { rental, sale, label: rental&&sale?'RENT_AND_SALE_LANGUAGE':rental?'RENT_LANGUAGE':sale?'SALE_LANGUAGE':'NO_CLEAR_OFFER_LANGUAGE' };
}
function redactSample(row: Row) {
  const text = stripSensitive(`${compact(row.raw_text)} ${compact(row.description)}`).slice(0,420);
  const signals = offerSignals(row);
  return { id:row.id,sourceType:row.source_type,sourceGroup:row.group_name,title:compact(row.title),
    offerType:row.offer_type??null,classification:row.classification,category:row.category??null,
    propertyType:row.property_type??null,price:typeof row.price==='number'&&row.price>0?row.price:null,currency:row.currency??null,
    bedrooms:row.bedrooms??null,location:compact(row.explicit_location)||compact(row.sangkat)||compact(row.property_explicit_location)||compact(row.property_sangkat)||null,
    signals,text }; 
}
function deterministicSample(bucket: Row[], n: number): Row[] {
  return [...bucket].sort((a,b)=>createHash('sha256').update(`phase6a2-exclusion-sample:${a.id}`).digest('hex')
    .localeCompare(createHash('sha256').update(`phase6a2-exclusion-sample:${b.id}`).digest('hex'))).slice(0,n);
}

const excluded: Record<string,Row[]> = { GEOGRAPHY_CONFLICT:[], EXPLICIT_OUT_OF_AREA:[], AVAILABILITY_EXCLUDED:[], NON_SUPPLY:[], OFFER_TYPE_UNKNOWN:[], SALE_ONLY:[], RENT_PRICE_UNKNOWN:[], OTHER:[] };
const kept: Row[]=[];
for (const row of rows) {
  const geo=detectGeography(row);
  if (geo?.kind==='GEOGRAPHY_CONFLICT') { excluded.GEOGRAPHY_CONFLICT!.push(row); continue; }
  if (geo?.kind==='OUT_OF_AREA') { excluded.EXPLICIT_OUT_OF_AREA!.push(row); continue; }
  if (['rented','removed'].includes(String(row.availability_status))) { excluded.AVAILABILITY_EXCLUDED!.push(row); continue; }
  if (row.classification!=='HOUSING_SUPPLY') { excluded.NON_SUPPLY!.push(row); continue; }
  if (row.offer_type!=='rent' && row.offer_type!=='sale') { excluded.OFFER_TYPE_UNKNOWN!.push(row); continue; }
  kept.push(row);
}
for (const row of kept) {
  if (row.offer_type==='sale') excluded.SALE_ONLY!.push(row);
  else if (row.price===null || Number(row.price)<=0) excluded.RENT_PRICE_UNKNOWN!.push(row);
}
const repository=new CanonicalListingRepository(db);
const policyRows=rows.filter((row)=>!detectGeography(row)&&!['rented','removed'].includes(String(row.availability_status))&&row.classification==='HOUSING_SUPPLY');
const policyTier=(row:Row):'EXACT'|'PROBABLE'|'UNKNOWN'|'CONTRADICTION'=>{
  const offer=String(row.offer_type??'').toLowerCase(); const signal=offerSignals(row);
  if(offer==='sale'||((!['rent','rent_or_sale','mixed','rent_and_sale'].includes(offer))&&signal.sale&&!signal.rental))return 'CONTRADICTION';
  if(offer==='rent')return 'EXACT';
  if(['rent_or_sale','mixed','rent_and_sale'].includes(offer)||signal.rental)return 'PROBABLE';
  return 'UNKNOWN';
};
const policyTierCounts=policyRows.reduce((acc,row)=>{const tier=policyTier(row);acc[tier]++;return acc;},{EXACT:0,PROBABLE:0,UNKNOWN:0,CONTRADICTION:0});
const policyRent=repository.searchProperties({city:'siem_reap',type:'rent',limit:500});
const policyExpectedIds=new Set(policyRows.filter((row)=>policyTier(row)!=='CONTRADICTION').map((row)=>Number(row.id)));
const policyReturnedIds=new Set(policyRent.items.map((item)=>item.id));

const bucketReport=Object.fromEntries(Object.entries(excluded).map(([name,bucket])=>[name,{count:bucket.length,
  sample:deterministicSample(bucket,name==='OFFER_TYPE_UNKNOWN'||name==='SALE_ONLY'?25:bucket.length).map(redactSample)}]));
const bedroomUnknown=kept.filter((row)=>row.bedrooms===null||row.bedrooms===undefined);
bucketReport.BEDROOM_FILTER_UNKNOWN={count:bedroomUnknown.length,excludedFromBroad:false,
  note:'These remain in broad search but are excluded by an exact bedroom filter.',sample:deterministicSample(bedroomUnknown,bedroomUnknown.length).map(redactSample)};
const missingPriceTyped=kept.filter((row)=>row.price===null||Number(row.price)<=0);
const offerSignalCounts=excluded.OFFER_TYPE_UNKNOWN!.reduce((acc,row)=>{const label=offerSignals(row).label;acc[label]=(acc[label]??0)+1;return acc;},{} as Record<string,number>);
const offerProvenance=rows.reduce((acc,row)=>{
  const offer=typeof row.offer_type==='string'?row.offer_type:'UNKNOWN';
  const bucket=acc[offer]??(acc[offer]={items:0,sourceTypes:{},payloadOfferEvidence:0,aiResults:{CLASSIFICATION:0,SUPPLY_EXTRACTION:0,DEMAND_EXTRACTION:0}});
  bucket.items++;const sourceType=String(row.source_type??'MISSING');bucket.sourceTypes[sourceType]=(bucket.sourceTypes[sourceType]??0)+1;
  const payload=parsePayload(row.raw_payload_json);
  const payloadFacts=(payload.listingFacts??payload.listing_facts??payload.listing) as Record<string,unknown>|undefined;
  if(typeof payloadFacts?.offer_type==='string')bucket.payloadOfferEvidence++;
  if(row.source_item_id!==null&&row.source_item_id!==undefined){
    const attempts=db.prepare(`SELECT stage,COUNT(*) n FROM ai_processing_results WHERE source_item_id=? GROUP BY stage`).all(row.source_item_id) as Array<{stage:keyof typeof bucket.aiResults;n:number}>;
    for(const attempt of attempts)if(attempt.stage in bucket.aiResults)bucket.aiResults[attempt.stage]+=attempt.n;
  }
  return acc;
},{} as Record<string,{items:number;sourceTypes:Record<string,number>;payloadOfferEvidence:number;aiResults:Record<'CLASSIFICATION'|'SUPPLY_EXTRACTION'|'DEMAND_EXTRACTION',number>}>);
const unknownItemIds=rows.filter((row)=>!['rent','sale'].includes(String(row.offer_type))).map((row)=>Number(row.source_item_id)).filter((id)=>Number.isFinite(id));
const aiProviderTrace=unknownItemIds.length?db.prepare(`SELECT a.stage,a.provider,a.model,a.success,a.error_code,COUNT(*) attempts
  FROM ai_processing_results a WHERE a.source_item_id IN (${unknownItemIds.map(()=>'?').join(',')})
  GROUP BY a.stage,a.provider,a.model,a.success,a.error_code ORDER BY a.stage,a.provider,a.model`).all(...unknownItemIds):[];
const report={generatedAt:new Date().toISOString(),database:dbPath,mode:'read_only_no_source_or_canonical_writes',sampleMethod:'deterministic pseudo-random order from SHA-256(id + fixed seed)',
  definitions:{startingSet:'active canonical listings with l.city=siem_reap and a current primary occurrence/source item joined where available',
    geographyConflict:'other-city title with saved Siem Reap body/location evidence; withheld from location-specific results pending review',
    unknownOfferType:'listing_facts_json.offer_type missing or outside rent/sale; source classification is still HOUSING_SUPPLY',
    rentPriceUnknown:'offer_type=rent and price null/zero; eligible for no-budget discovery under proposed policy, not an exact budget match'},
  funnel:{activeSiemReap:rows.length,availabilityExcluded:excluded.AVAILABILITY_EXCLUDED!.length,nonSupply:excluded.NON_SUPPLY!.length,
    missingCurrentPrimaryOccurrence:rows.filter((row)=>row.occurrence_id===null||row.occurrence_id===undefined).length,
    missingSourceItem:rows.filter((row)=>row.source_item_id===null||row.source_item_id===undefined).length,
    explicitOutOfArea:excluded.EXPLICIT_OUT_OF_AREA!.length,geographyConflict:excluded.GEOGRAPHY_CONFLICT!.length,
    offerTypeUnknown:excluded.OFFER_TYPE_UNKNOWN!.length,typedSupplyAfterGeography:kept.length,
    activeRowsAvailabilityUnknown:rows.filter((row)=>row.availability_status==='unknown').length,
    missingCategoryInActiveRows:rows.filter((row)=>!row.category).length,missingPropertyTypeInActiveRows:rows.filter((row)=>!row.property_type).length,
    missingCategoryInTypedSupply:kept.filter((row)=>!row.category).length,missingPropertyTypeInTypedSupply:kept.filter((row)=>!row.property_type).length,
    missingBedroomsInTypedSupply:bedroomUnknown.length,
    typedSupplyRent:kept.filter((row)=>row.offer_type==='rent').length,typedSupplySale:kept.filter((row)=>row.offer_type==='sale').length,
    saleExcludedFromRent:excluded.SALE_ONLY!.length,rentUnknownPrice:excluded.RENT_PRICE_UNKNOWN!.length,
  },
  proposedReadPolicy:{geographicallyEligible:policyRows.length,matchTierCounts:policyTierCounts,
    expectedIncludedCount:policyExpectedIds.size,repositoryReturnedCount:policyReturnedIds.size,
    repositoryOnlyIds:[...policyReturnedIds].filter((id)=>!policyExpectedIds.has(id)),auditOnlyIds:[...policyExpectedIds].filter((id)=>!policyReturnedIds.has(id)),
    repositoryReturned:policyRent.total,repositoryTierCounts:policyRent.items.reduce((acc,item)=>{const tier=item.match_tier??'UNKNOWN';acc[tier]++;return acc;},{EXACT:0,PROBABLE:0,UNKNOWN:0} as Record<'EXACT'|'PROBABLE'|'UNKNOWN',number>),
    defaultRentIncludingUnknownPrice:policyRent.items.filter((item)=>item.price<=0).length,
    budgetUnder400:{total:repository.searchProperties({city:'siem_reap',type:'rent',maxPrice:40000,limit:500}).total,
      probableUnknownPrice:repository.searchProperties({city:'siem_reap',type:'rent',maxPrice:40000,limit:500}).items.filter((item)=>item.price<=0).length},
    twoBedrooms:{total:repository.searchProperties({city:'siem_reap',type:'rent',bedrooms:[2],limit:500}).total,
      unknownBedroom:repository.searchProperties({city:'siem_reap',type:'rent',bedrooms:[2],limit:500}).items.filter((item)=>item.bedrooms===null).length}},
  typeSignalsForUnknownOffer:offerSignalCounts,
  offerTypeProvenance:offerProvenance,
  unknownOfferAiProviderTrace:aiProviderTrace,
  typedSupplyMissingPrice:{total:missingPriceTyped.length,rent:missingPriceTyped.filter((row)=>row.offer_type==='rent').length,sale:missingPriceTyped.filter((row)=>row.offer_type==='sale').length,
    samples:missingPriceTyped.map(redactSample)},
  exclusionBuckets:bucketReport,
  notes:['No data was changed. Read policy is derived at query time; canonical rows were not rewritten.',
    'Offer language counts are keyword signals only; sample text is redacted and must be reviewed before treating offer_type as a hard gate.',
    'Source/group rental orientation is context, not proof. It is reported with each sampled source group for manual review.',
    'The proposed read policy excludes explicit SALE and unknown sale-only evidence, includes rental-language unknowns as PROBABLE, and keeps unclear unknowns in UNKNOWN.']};
const output='reports/phase6a2-exclusion-funnel-20261007.json';
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,funnel:report.funnel,typeSignalsForUnknownOffer:offerSignalCounts,
  samples:{unknownOffer:bucketReport.OFFER_TYPE_UNKNOWN?.sample?.length,saleOnly:bucketReport.SALE_ONLY?.sample?.length}},null,2));
db.close();
