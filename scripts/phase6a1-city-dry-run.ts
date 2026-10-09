import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const path = process.env.PHASE6A_DB ?? 'data/rebuild/phase6a-checkpoint-20261007.db';
const db = new DatabaseSync(path, { readOnly: true });
const rows = db.prepare(`
  SELECT l.id,l.city old_city,l.sangkat,l.explicit_location,l.title,l.listing_facts_json,
    p.city property_city,p.sangkat property_sangkat,p.explicit_location property_explicit_location,p.canonical_address,
    o.source_url,o.external_id,o.group_name,s.source_type,s.raw_text,s.raw_payload_json,s.classification
  FROM canonical_listings l
  JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id AND o.is_current=1
  JOIN source_items s ON s.id=o.source_item_id
  LEFT JOIN canonical_properties p ON p.id=l.property_id
  WHERE l.status='active' AND l.city='siem_reap'
`).all() as Array<Record<string, unknown>>;
const parse=(raw:unknown):Record<string,unknown>=>{try{return typeof raw==='string'?JSON.parse(raw) as Record<string,unknown>:{};}catch{return {};}};
const asString=(x:unknown)=>typeof x==='string'?x.trim():'';
const otherCities: Array<[string,string]> = [
  ['phnom penh','phnom_penh'],['phnompenh','phnom_penh'],['ភ្នំពេញ','phnom_penh'],['kandal','OUT_OF_AREA'],['ខេត្តកណ្ដាល','OUT_OF_AREA'],
  ['kampot','OUT_OF_AREA'],['kep','OUT_OF_AREA'],['sihanoukville','OUT_OF_AREA'],['preah sihanouk','OUT_OF_AREA'],['battambang','OUT_OF_AREA'],['poipet','OUT_OF_AREA'],
  ['kampong cham','OUT_OF_AREA'],['kampong thom','OUT_OF_AREA'],['kampong speu','OUT_OF_AREA'],['kampong chhnang','OUT_OF_AREA'],
  ['koh kong','OUT_OF_AREA'],['kratie','OUT_OF_AREA'],['mondulkiri','OUT_OF_AREA'],['ratanakiri','OUT_OF_AREA'],['pursat','OUT_OF_AREA'],
  ['takeo','OUT_OF_AREA'],['svay rieng','OUT_OF_AREA'],['bavet','OUT_OF_AREA'],['stung treng','OUT_OF_AREA'],['pailin','OUT_OF_AREA'],
  ['banteay meanchey','OUT_OF_AREA'],['prey veng','OUT_OF_AREA'],['tbong khmum','OUT_OF_AREA'],
];
const outArea=(value:string,contextual=false)=>otherCities.find(([name])=>{
  const text=value.toLowerCase().normalize('NFKC');
  if(!contextual)return text.includes(name);
  if(name==='kandal')return /(?:in|located in|location:|province of)\s+kandal\b|\bkandal,\s*cambodia\b/.test(text);
  if(name==='ខេត្តកណ្ដាល')return text.includes(name);
  return new RegExp(`(?:in|located in|location:)\\s*${name.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}\\b|\\b${name.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')},\\s*cambodia\\b`).test(text);
});
const isSiemReap=(value:string)=>/siem\s*reap|siemreap|សៀមរាប/i.test(value);
const findings=rows.flatMap((row)=>{
  const facts=parse(row.listing_facts_json); const payload=parse(row.raw_payload_json);
  const extracted=(payload.listingExtraction&&typeof payload.listingExtraction==='object'?payload.listingExtraction:{}) as Record<string,unknown>;
  const candidates=[
    {priority:1,field:'listing.explicit_location',value:asString(row.explicit_location)},
    {priority:1,field:'property.explicit_location',value:asString(row.property_explicit_location)},
    {priority:1,field:'listing.sangkat',value:asString(row.sangkat)},
    {priority:1,field:'property.sangkat',value:asString(row.property_sangkat)},
    {priority:1,field:'canonical_address',value:asString(row.canonical_address)},
    {priority:2,field:'listing_facts.city',value:asString(facts.city)},
    {priority:2,field:'source.listingExtraction.city',value:asString(extracted.city)},
    {priority:2,field:'listing_facts.explicit_location',value:asString(facts.explicit_location)},
    {priority:3,field:'title',value:asString(row.title)},
    {priority:3,field:'raw_text',value:asString(row.raw_text)},
  ].filter((candidate)=>candidate.value);
  const positive=candidates.flatMap((candidate)=>{
    const match=outArea(candidate.value,candidate.priority===3); return match?[{...candidate,matchedCity:match[0],proposedCity:match[1]}]:[];
  });
  if(!positive.length)return [];
  const strongSiemReap=candidates.filter((candidate)=>candidate.priority<=2&&isSiemReap(candidate.value));
  const body=row.raw_text?asString(row.raw_text):'';
  if(/siem\s*reap|siemreap|សៀមរាប|pub street|old market/i.test(body)&&!strongSiemReap.length)strongSiemReap.push({priority:2,field:'raw_text_si_reap_evidence',value:body});
  const selected=[...positive].sort((a,b)=>a.priority-b.priority)[0]!;
  const conflict=strongSiemReap.length>0;
  const safeStructured=positive.some((candidate)=>candidate.priority===1);
  return [{canonicalId:Number(row.id),oldCity:row.old_city,classification:conflict?'GEOGRAPHY_CONFLICT':'OUT_OF_AREA',
    proposedCity:conflict?null:selected.proposedCity,matchedCity:selected.matchedCity,
    evidenceField:selected.field,evidence:selected.value.slice(0,500),
    confidence:conflict?'conflict':safeStructured?'high':'medium',autoRepairCandidate:!conflict&&safeStructured,
    siemReapEvidence:strongSiemReap.map(({field,value})=>({field,value:value.slice(0,180)})),
    otherOutOfAreaEvidence:positive.map(({field,value})=>({field,value:value.slice(0,180)})),
    sourceType:row.source_type,sourceUrl:row.source_url,externalId:row.external_id,sourceClassification:row.classification}];
});
const report={generatedAt:new Date().toISOString(),database:path,mode:'dry_run_only_no_database_writes',activeSiemReapListingsScanned:rows.length,
  outOfAreaFindings:findings.length,geographyConflicts:findings.filter((row)=>row.classification==='GEOGRAPHY_CONFLICT').length,
  highConfidenceNonConflictingRepairCandidates:findings.filter((row)=>row.autoRepairCandidate).length,
  policy:'title-only geography never rewrites canonical city; conflicting strong signals are marked GEOGRAPHY_CONFLICT',findings};
const out='reports/phase6a2-geography-dry-run-20261007.json';
writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({out,activeSiemReapListingsScanned:rows.length,outOfAreaFindings:findings.length,geographyConflicts:report.geographyConflicts,highConfidenceNonConflictingRepairCandidates:report.highConfidenceNonConflictingRepairCandidates,findings},null,2));
db.close();
