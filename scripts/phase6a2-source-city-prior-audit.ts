import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';

const dbPath=process.env.PHASE6A_DB??'data/rebuild/phase6a-checkpoint-20261007.db';
const db=new DatabaseSync(dbPath,{readOnly:true});
const repo=new CanonicalListingRepository(db);
const results=repo.searchProperties({city:'siem_reap',type:'rent',limit:500});
const legacyCityIds=new Set((db.prepare("SELECT id FROM canonical_listings WHERE status='active' AND city='siem_reap'").all() as Array<{id:number}>).map((r)=>Number(r.id)));
const candidates=results.items.filter((p)=>!legacyCityIds.has(p.id));
const ids=results.items.map((p)=>p.id);
type Row=Record<string,unknown>;
const rows=ids.length?db.prepare(`SELECT l.id,l.city listing_city,p.city property_city,l.explicit_location,l.sangkat,p.explicit_location property_explicit_location,
    p.sangkat property_sangkat,p.canonical_address,l.title,l.description,s.raw_text,s.source_type,o.group_id,o.group_name,sr.city source_registry_city,
    json_extract(l.listing_facts_json,'$.offer_type') offer_type,l.listing_facts_json,l.status
  FROM canonical_listings l LEFT JOIN canonical_properties p ON p.id=l.property_id
  JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id AND o.is_current=1
  JOIN source_items s ON s.id=o.source_item_id LEFT JOIN source_registry sr ON sr.id=o.source_registry_id
  WHERE l.id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as Row[]:[];
const clean=(v:unknown)=>typeof v==='string'?v.trim().replace(/\s+/g,' '):'';
const strip=(v:string)=>v.replace(/https?:\/\/\S+/gi,'[link]').replace(/\+?\d[\d\s().-]{6,}\d/g,'[phone]').slice(0,280);
const outside=['phnom penh','phnompenh','ភ្នំពេញ','kandal','ខេត្តកណ្ដាល','sihanoukville','preah sihanouk','battambang','kampot','kep','poipet','kampong cham','kampong thom','kampong speu','kampong chhnang','koh kong','kratie','mondulkiri','ratanakiri','pursat','takeo','svay rieng','bavet','stung treng','pailin','banteay meanchey','prey veng','tbong khmum'];
const local=['wat bo','sala kamreuk','sala kamraeuk','svay dangkum','sla kram','chreav','chong kaosou','phare circus','pub street','old market','wat damnak','wat polanka','bakong','pradak','kandaek','siem reap'];
function cityTier(r:Row):'EXACT_CITY'|'PROBABLE_CITY'|'UNKNOWN_CITY'|'CONTRADICTION_CITY'|'GEOGRAPHY_CONFLICT' {
  const fields=[r.listing_city,r.property_city,r.explicit_location,r.sangkat,r.property_explicit_location,r.property_sangkat,r.canonical_address].map(clean).filter(Boolean);
  const title=clean(r.title).toLowerCase(), body=`${clean(r.raw_text)} ${clean(r.description)}`.toLowerCase();
  const all=`${fields.join(' ')} ${title} ${body}`.toLowerCase();
  const other=outside.find((x)=>all.includes(x));
  const siemEvidence=/siem\s*reap|siemreap|សៀមរាប/i.test(fields.join(' '))||/(?:in|located in|location:)\s*siem\s*reap|សៀមរាប/.test(`${title} ${body}`);
  const titleOther=outside.find((x)=>title.includes(x));
  if(titleOther&&siemEvidence)return 'GEOGRAPHY_CONFLICT';
  const structuredOther=fields.find((x)=>outside.some((city)=>x.toLowerCase().includes(city)));
  if(structuredOther||titleOther)return 'CONTRADICTION_CITY';
  if((typeof r.listing_city==='string'&&r.listing_city==='siem_reap')||(typeof r.property_city==='string'&&r.property_city==='siem_reap')||siemEvidence)return 'EXACT_CITY';
  if(local.some((x)=>all.includes(x))||r.source_registry_city==='siem_reap')return 'PROBABLE_CITY';
  return 'UNKNOWN_CITY';
}
const classify=(r:Row)=>{
  const p=results.items.find((x)=>x.id===Number(r.id));
  const tier=cityTier(r);
  return {canonicalListingId:Number(r.id),sourceType:clean(r.source_type),sourceGroup:clean(r.group_name)||null,groupId:clean(r.group_id)||null,
    listingCity:clean(r.listing_city)||null,propertyCity:clean(r.property_city)||null,explicitLocation:clean(r.explicit_location)||clean(r.property_explicit_location)||null,
    sangkat:clean(r.sangkat)||clean(r.property_sangkat)||null,address:clean(r.canonical_address)||null,title:clean(r.title),
    rawTextGeographySignals:{siemReap:/siem\s*reap|siemreap|សៀមរាប/i.test(`${clean(r.raw_text)} ${clean(r.description)}`),otherCities:outside.filter((x)=>`${clean(r.raw_text)} ${clean(r.description)}`.toLowerCase().includes(x)),localAreas:local.filter((x)=>`${clean(r.raw_text)} ${clean(r.description)} ${clean(r.title)}`.toLowerCase().includes(x))},
    rawTextExcerpt:strip(`${clean(r.raw_text)} ${clean(r.description)}`),sourceRegistryCity:clean(r.source_registry_city)||null,
    offerTier:p?.match_tier??'UNKNOWN',proposedGeographyTier:tier};
};
const allEnriched=rows.map(classify);
const enriched=allEnriched.filter((x)=>candidates.some((c)=>c.id===x.canonicalListingId));
const counts=allEnriched.reduce((acc,r)=>{acc[r.proposedGeographyTier]++;return acc;},{EXACT_CITY:0,PROBABLE_CITY:0,UNKNOWN_CITY:0,CONTRADICTION_CITY:0,GEOGRAPHY_CONFLICT:0});
const offerCityCrossTab=allEnriched.reduce((acc,r)=>{const key=`${r.proposedGeographyTier}__${r.offerTier}`;acc[key]=(acc[key]??0)+1;return acc;},{} as Record<string,number>);
const extraCounts=enriched.reduce((acc,r)=>{acc[r.proposedGeographyTier]++;return acc;},{EXACT_CITY:0,PROBABLE_CITY:0,UNKNOWN_CITY:0,CONTRADICTION_CITY:0,GEOGRAPHY_CONFLICT:0});
const report={generatedAt:new Date().toISOString(),database:dbPath,mode:'read_only',sourceRegistryPolicy:'acquisition prior only; never exact city evidence',baseline:{repositoryReturned:results.total,repositoryOnlyCount:candidates.length,repositoryOnlyIds:candidates.map((p)=>p.id)},counts,offerCityCrossTab,
  repositoryOnlyCityCounts:extraCounts,acceptedByProposedCityPolicy:allEnriched.filter((x)=>['EXACT_CITY','PROBABLE_CITY','UNKNOWN_CITY'].includes(x.proposedGeographyTier)).length,
  excludedOrHeld:allEnriched.filter((x)=>['CONTRADICTION_CITY','GEOGRAPHY_CONFLICT'].includes(x.proposedGeographyTier)).length,records:enriched};
const out='reports/phase6a2-source-city-prior-audit-20261007.json';
writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({out,repositoryReturned:results.total,repositoryOnlyCount:candidates.length,counts,offerCityCrossTab,repositoryOnlyCityCounts:extraCounts},null,2));
db.close();
