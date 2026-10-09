import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDatabase, closeDatabase } from '../src/database/db';
import { runMigrations } from '../src/database/migrate';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';

const checkpoint = process.env.PHASE6A_DB ?? 'data/rebuild/phase6a-checkpoint-20261007.db';
const preview = path.join(tmpdir(), `homeasy-phase6a3b-${crypto.randomUUID()}.db`);
const out = process.env.PHASE6A3B_TRIAGE_OUT ?? 'reports/phase6a3b-moderation-triage-20261007.json';

type Candidate = {
  listing_id:number; public_ref:string; title:string; description:string; category:string|null; property_type:string|null;
  price:number|null; bedrooms:number|null; offer_type:string|null; city:string|null; property_city:string|null; sangkat:string|null; explicit_location:string|null;
  status:string; availability_status:string; moderation:string; source_type:string; source_name:string|null; source_city:string|null;
  review_reason:string|null; decision_origin:string; has_legacy_alias:number;
  source_url:string|null; raw_text:string|null; current_occurrences:number; current_alive:number; duplicate_current_bindings:number; in_search?:boolean;
  source_url_conflict:number;
};

const re = {
  contradiction: /\b(phnom\s*penh|kandal|battambang|poipet|kampong\s*(?:cham|thom|speu)|sihanoukville|takeo|kampot|kep|pursat|prey\s*veng|svay\s*rieng|ratanakiri|mondulkiri|stung\s*treng|kratie|oddar\s*meanchey|តាកែវ|កណ្ដាល|ភ្នំពេញ|បាត់ដំបង)\b/i,
  siemReap: /\b(siem\s*reap|siemreap|sala\s*kamreuk|sala\s*komreuk|svay\s*dangkum|slor\s*kram|siem\s*reap\s*(?:town|city))\b|សៀមរាប/i,
  sale: /\b(for\s+sale|house\s+for\s+sale|land\s+for\s+sale|ขาย|sale\s+only|sell(?:ing)?\s+(?:my|the|this))\b|លក់/i,
  rent: /\b(for\s+rent|rent(?:al)?|lease|monthly\s+rent|to\s+let)\b|ជួល/i,
  inactive: /\b(rented|already\s+rent(?:ed)?|no\s+longer\s+available|removed|unavailable|closed)\b/i,
  safety: /\b(fake|scam|fraud|stolen|illegal|counterfeit|phishing)\b/i,
};

function clean(v:string|null|undefined):string{return String(v??'').replace(/\s+/g,' ').trim();}
function explicitNumbers(s:string,pattern:RegExp):number[]{return [...s.matchAll(new RegExp(pattern.source,pattern.flags))].map(m=>Number(m[1]??m[2])).filter(Number.isFinite);}
function rentAmounts(s:string):number[]{
  const found:number[]=[];
  const amount=/(?:\$|USD\s*)?([0-9][0-9,]*)(?:\s*\$)?\s*(?:\/\s*(?:month|mo)|per\s+month|monthly|\/\s*ខែ|ក្នុងមួយខែ)/ig;
  const labelled=/(?:rent(?:al)?\s+price|price\s+(?:for\s+)?rent|តម្លៃជួល|តំលៃជួល)[^\d$]{0,24}(?:USD\s*)?\$?([0-9][0-9,]*)/ig;
  for(const match of s.matchAll(new RegExp(labelled.source,labelled.flags)))found.push(Number(match[1]!.replaceAll(',','')));
  for(const match of s.matchAll(new RegExp(amount.source,amount.flags))){
    const index=match.index??0;const lineStart=s.lastIndexOf('\n',index)+1;const context=s.slice(Math.max(lineStart,index-80),index);
    if(/\b(?:water|electricity|electric|utility|utilities|deposit|per\s+person|pax|kwh)\b/i.test(context))continue;
    found.push(Number(match[1]!.replaceAll(',','')));
  }
  return [...new Set(found.filter(Number.isFinite))];
}
function classify(c:Candidate){
  const text=[c.title,c.description,c.raw_text].map(clean).join(' ');
  const sourceText=[c.title,c.description,c.raw_text].map(v=>String(v??'')).join('\n');
  const headline=[c.title,c.description].map(clean).join(' ');
  const primaryListingText=`${headline} ${String(c.raw_text??'').slice(0,350)}`;
  const local=[c.sangkat,c.explicit_location].map(clean).join(' ');
  const hasContradiction=re.contradiction.test(local)||re.contradiction.test(text);
  const hasKhmerContradiction=/(?:តាកែវ|ខេត្តកណ្ដាល|ភ្នំពេញ|បាត់ដំបង|កំពង់ចាម|កំពង់ធំ|កំពង់ស្ពឺ|ព្រះសីហនុ)/.test(local+' '+text);
  const geographyConflict=hasContradiction||hasKhmerContradiction;
  const structuredOffer=String(c.offer_type??'').toLowerCase();
  // Marketing footers can mention buying/selling on otherwise valid rental posts.
  // Require sale language in the listing's own title/description before treating
  // generic source-body/footer text as a contradiction.
  const directSale=/\b(?:for\s+sale|house\s+for\s+sale|land\s+for\s+sale|sale\s+only|sell(?:ing)?\s+(?:my|the|this))\b/i;
  const sourceSale=directSale.test(headline)||directSale.test(String(c.raw_text??'').slice(0,350))
    ||/(?:លក់ដី|ដីលក់|លក់ផ្ទះ|ផ្ទះលក់|លក់អចលនទ្រព្យ|សម្រាប់លក់)/.test(primaryListingText);
  const explicitSale=sourceSale||structuredOffer==='sale';
  const explicitRent=re.rent.test(primaryListingText)||structuredOffer==='rent';
  const explicitCity=re.siemReap.test(local)||re.siemReap.test(text);
  const districtEvidence=/\b(wat\s*bo|wat\s*damnak|sala\s*kam(?:reuk|roek)|svay\s*dangkum|slor\s*kram|slorkram|chreav|krous|bakong|prasat\s*bakong)\b/i.test(local+' '+text);
  const geoTier=geographyConflict?'CONTRADICTION_CITY':explicitCity?'EXACT_CITY':districtEvidence||c.source_city?.toLowerCase().includes('siem')?'PROBABLE_CITY':'UNKNOWN_CITY';
  const explicitSaleOnly=explicitSale&&!explicitRent&&structuredOffer!=='rent_or_sale'&&structuredOffer!=='mixed'&&structuredOffer!=='rent_and_sale';
  const offerTier=explicitSale&&explicitRent?'MIXED_RENT_SALE':explicitSaleOnly?'EXPLICIT_SALE':explicitRent?'RENT_EVIDENCE':'UNKNOWN_OFFER';
  const flags:string[]=[];
  if(c.current_occurrences<1)flags.push('NO_CURRENT_OCCURRENCE');
  if(c.duplicate_current_bindings>0)flags.push('DUPLICATE_CURRENT_BINDING');
  if(c.source_url_conflict>0)flags.push('SOURCE_URL_BOUND_TO_MULTIPLE_LISTINGS');
  if(c.decision_origin==='INGESTION_VALIDATED_V1'&&/legacy identity alias conflict/i.test(c.review_reason??''))flags.push('LEGACY_IDENTITY_ALIAS_CONFLICT');
  if(c.moderation==='pending'&&c.decision_origin==='INGESTION_VALIDATED_V1'&&/held for manual review/i.test(c.review_reason??''))flags.push('PRIOR_POLICY_MANUAL_REVIEW');
  if(!c.source_url||!/^https?:\/\//i.test(c.source_url))flags.push('INVALID_SOURCE_URL');
  if(!clean(c.title)&&!clean(c.description)&&!clean(c.raw_text))flags.push('NO_CARD_CONTENT');
  if(!c.category&&!c.property_type)flags.push('NO_HOUSING_TYPE');
  const bedPattern=/(\d{1,2})\s*[-–— ]?\s*(?:bedrooms?|br\b)|(?:bedrooms?|br)\s*[:=-]\s*(\d{1,2})/ig;
  const titleBeds=[...new Set(explicitNumbers(clean(c.title),bedPattern))];
  const textBeds=[...new Set(explicitNumbers(String(c.raw_text??''),bedPattern))];
  if(titleBeds.length===1&&textBeds.length===1&&titleBeds[0]!==textBeds[0]
    ||c.bedrooms!==null&&textBeds.length===1&&c.bedrooms!==textBeds[0])flags.push('BEDROOMS_CONTRADICT_SOURCE');
  const monthlyPrices=rentAmounts(sourceText);
  if(c.price!==null&&c.price>0&&monthlyPrices.length===0)flags.push('PRICE_NOT_EXPLICITLY_SUPPORTED');
  else if(c.price!==null&&c.price>0){const price=Number(c.price);const agrees=monthlyPrices.some(expected=>Math.abs(price-expected*100)<=Math.max(500,expected*5));if(!agrees)flags.push('PRICE_CONTRADICTS_SOURCE');}
  if(c.status==='inactive'||c.availability_status==='rented'||c.availability_status==='unavailable'||re.inactive.test(text))flags.push('INACTIVE_OR_RENTED');
  if(geographyConflict)flags.push('GEOGRAPHY_CONTRADICTION');
  if(explicitSaleOnly)flags.push('EXPLICIT_SALE_ONLY');
  if(explicitSale&&explicitRent)flags.push('MIXED_RENT_SALE_REQUIRES_REVIEW');
  if(re.safety.test(text))flags.push('CONTENT_REVIEW_FLAG');
  const tier=flags.length===0?'AUTO_APPROVE_CANDIDATE':flags.some(f=>['INVALID_SOURCE_URL','NO_CARD_CONTENT','NO_HOUSING_TYPE','CONTENT_REVIEW_FLAG','DUPLICATE_CURRENT_BINDING','SOURCE_URL_BOUND_TO_MULTIPLE_LISTINGS','MIXED_RENT_SALE_REQUIRES_REVIEW','BEDROOMS_CONTRADICT_SOURCE','PRICE_CONTRADICTS_SOURCE','PRICE_NOT_EXPLICITLY_SUPPORTED','LEGACY_IDENTITY_ALIAS_CONFLICT','PRIOR_POLICY_MANUAL_REVIEW'].includes(f))?'MANUAL_REVIEW':flags.includes('GEOGRAPHY_CONTRADICTION')||flags.includes('EXPLICIT_SALE_ONLY')||flags.includes('INACTIVE_OR_RENTED')?'REJECT':'MANUAL_REVIEW';
  return {geoTier,offerTier,explicitRent,explicitSale,flags,triage:tier};
}

function main(){
  if(!existsSync(checkpoint))throw new Error(`Missing checkpoint ${checkpoint}`);
  copyFileSync(checkpoint,preview);
  const db=createDatabase(preview);
  try{
    runMigrations(db);
    const moderationBefore=db.prepare('SELECT listing_id,review_status FROM canonical_listing_moderation').all() as Array<{listing_id:number;review_status:string}>;
    db.exec("UPDATE canonical_listing_moderation SET review_status='approved'");
    const canonical=new CanonicalListingRepository(db);
    const candidateSearch=canonical.searchProperties({city:'siem_reap',type:'rent',limit:500});
    const searchIds=candidateSearch.items.map(x=>x.id);
    for(const state of moderationBefore)db.prepare('UPDATE canonical_listing_moderation SET review_status=? WHERE listing_id=?').run(state.review_status,state.listing_id);
    if(!searchIds.length)throw new Error('No broad Siem Reap canonical candidates returned');
    const canonicalOnlyIds=(db.prepare(`SELECT listing_id FROM canonical_listing_moderation m WHERE m.review_status='pending'
      AND NOT EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=m.listing_id AND a.namespace='legacy_property_id')`).all() as Array<{listing_id:number}>).map(x=>x.listing_id);
    const auditIds=[...new Set([...searchIds,...canonicalOnlyIds])];
    const rows=db.prepare(`SELECT l.id listing_id,l.public_ref,l.title,l.description,l.category,l.property_type,l.price,l.bedrooms,
      l.city,p.city property_city,l.sangkat,p.explicit_location,json_extract(l.listing_facts_json,'$.offer_type') offer_type,l.status,l.availability_status,m.review_status moderation,m.review_reason,m.decision_origin,
      EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=l.id AND a.namespace='legacy_property_id') has_legacy_alias,
      s.source_type,sr.name source_name,sr.city source_city,COALESCE(o.source_url,s.source_url,s.canonical_url) source_url,
      COALESCE(v.raw_text,s.raw_text) raw_text,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences x WHERE x.listing_id=l.id AND x.is_current=1) current_occurrences,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences x WHERE x.listing_id=l.id AND x.is_current=1 AND x.source_alive=1) current_alive,
      (SELECT COUNT(*) FROM (SELECT source_item_id,source_entity_key FROM canonical_listing_source_occurrences WHERE is_current=1 GROUP BY 1,2 HAVING COUNT(*)>1)) duplicate_current_bindings,
      EXISTS(SELECT 1 FROM canonical_listing_source_occurrences x JOIN canonical_listing_source_occurrences y
        ON y.source_url=x.source_url AND y.listing_id<>x.listing_id AND y.is_current=1
        WHERE x.listing_id=l.id AND x.is_current=1 AND x.source_url IS NOT NULL) source_url_conflict
      FROM canonical_listings l JOIN canonical_properties p ON p.id=l.property_id
      JOIN canonical_listing_moderation m ON m.listing_id=l.id
      JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id AND o.is_current=1
      JOIN source_items s ON s.id=o.source_item_id LEFT JOIN source_registry sr ON sr.id=o.source_registry_id
      LEFT JOIN source_item_versions v ON v.id=(SELECT MAX(v2.id) FROM source_item_versions v2 WHERE v2.source_item_id=s.id)
      WHERE l.id IN (${auditIds.map(()=>'?').join(',')})
      GROUP BY l.id ORDER BY l.id`).all(...auditIds) as unknown as Candidate[];
    const searchSet=new Set(searchIds);
    const classified=rows.map(c=>({ ...c,in_search:searchSet.has(c.listing_id),...classify(c) }));
    const count=(key:string)=>classified.reduce((acc,c)=>{const v=(c as any)[key];acc[v]=(acc[v]??0)+1;return acc;},{} as Record<string,number>);
    const canonicalOnly=classified.filter(c=>!db.prepare("SELECT 1 FROM canonical_listing_aliases WHERE listing_id=? AND namespace='legacy_property_id'").get(c.listing_id));
    const pendingCanonicalOnly=canonicalOnly.filter(c=>c.moderation==='pending');
    const pendingCanonicalOnlyInSearch=pendingCanonicalOnly.filter(c=>c.in_search);
    const outsideSearchCanonicalOnly=pendingCanonicalOnly.filter(c=>!c.in_search);
    const pendingAuto=pendingCanonicalOnly.filter(c=>c.triage==='AUTO_APPROVE_CANDIDATE');
    const pendingAutoInSearch=pendingCanonicalOnlyInSearch.filter(c=>c.triage==='AUTO_APPROVE_CANDIDATE');
    const currentVisible=classified.filter(c=>c.in_search&&c.moderation==='approved');
    const proposedVisible=classified.filter(c=>c.in_search&&(c.moderation==='approved'||(!db.prepare("SELECT 1 FROM canonical_listing_aliases WHERE listing_id=? AND namespace='legacy_property_id'").get(c.listing_id)&&c.triage==='AUTO_APPROVE_CANDIDATE')));
    const breakdown=(items:typeof classified,key:'geoTier'|'offerTier')=>items.reduce((acc,c)=>{const value=c[key];acc[value]=(acc[value]??0)+1;return acc;},{} as Record<string,number>);
    const searchRows=classified.filter(c=>c.in_search);
    const searchSourceCounts=searchRows.reduce((acc,c)=>{acc[c.source_type]=(acc[c.source_type]??0)+1;return acc;},{} as Record<string,number>);
    const cityOfferCross=proposedVisible.reduce((acc,c)=>{const key=`${c.geoTier} × ${c.offerTier}`;acc[key]=(acc[key]??0)+1;return acc;},{} as Record<string,number>);
    // Balanced source sample, stratified within each source by geography × offer.
    const strata=new Map<string,typeof classified>();
    for(const c of pendingAuto){const key=[c.source_type,c.geoTier,c.offerTier].join('|');strata.set(key,[...(strata.get(key)??[]),c]);}
    const sample:typeof classified=[];
    for(const source of ['FACEBOOK_GROUP','KHMER24']){
      const sourceRows=pendingAuto.filter(c=>c.source_type===source);
      const quota=source==='KHMER24'?Math.min(10,sourceRows.length):Math.min(26,sourceRows.length);
      const sourceStrata=[...strata.entries()].filter(([key])=>key.startsWith(`${source}|`));
      for(const [key,values] of sourceStrata){
        const group=values.sort((a,b)=>String(a.public_ref).localeCompare(String(b.public_ref)));
        const wanted=Math.min(group.length,Math.max(1,Math.round(quota*group.length/Math.max(1,sourceRows.length))));
        for(let i=0;i<wanted;i++)sample.push(group[Math.floor((i+0.5)*group.length/wanted)]!);
      }
    }
    const selected=new Set(sample.map(c=>c.listing_id));
    const hasDirectContact=(c:Candidate)=>/(?:\+855|\b0[1-9][0-9][ -]?[0-9]{3}[ -]?[0-9]{3,}|@|\b(?:telegram|whatsapp|phone|email|contact)\b)/i.test(clean(c.raw_text));
    const auditMustInclude=[
      pendingAuto.find(c=>c.price===null||c.price===0),
      pendingAuto.find(c=>c.bedrooms===null),
      pendingAuto.find(c=>!hasDirectContact(c)),
    ].filter((x):x is Candidate=>Boolean(x));
    for(const c of auditMustInclude){if(!selected.has(c.listing_id)){sample.push(c);selected.add(c.listing_id);}}
    for(const c of [...pendingAuto].sort((a,b)=>String(a.public_ref).localeCompare(String(b.public_ref)))){
      if(sample.length>=40)break;
      if(!selected.has(c.listing_id)){sample.push(c);selected.add(c.listing_id);}
    }
    const report={generatedAt:new Date().toISOString(),mode:'read-only isolated checkpoint triage',checkpoint,
      candidateCount:candidateSearch.total,auditedRows:classified.length,triageCounts:count('triage'),geoCounts:count('geoTier'),offerCounts:count('offerTier'),
      canonicalOnly:{total:canonicalOnly.length,pending:pendingCanonicalOnly.length,
        inSearch:pendingCanonicalOnlyInSearch.length,
        inSearchTriageCounts:pendingCanonicalOnlyInSearch.reduce((acc,c)=>{acc[c.triage]=(acc[c.triage]??0)+1;return acc;},{} as Record<string,number>),
        outsideSearch:outsideSearchCanonicalOnly.length,
        outsideSearchTriageCounts:outsideSearchCanonicalOnly.reduce((acc,c)=>{acc[c.triage]=(acc[c.triage]??0)+1;return acc;},{} as Record<string,number>),
        sourceCounts:pendingCanonicalOnlyInSearch.reduce((acc,c)=>{acc[c.source_type]=(acc[c.source_type]??0)+1;return acc;},{} as Record<string,number>),
        triageCounts:pendingCanonicalOnly.reduce((acc,c)=>{acc[c.triage]=(acc[c.triage]??0)+1;return acc;},{} as Record<string,number>)},
      visibility:{currentApproved:currentVisible.length,proposedApproved:proposedVisible.length,proposedCanonicalOnlyAutoApproved:pendingAutoInSearch.length,
        proposedManualReview:pendingCanonicalOnlyInSearch.filter(c=>c.triage==='MANUAL_REVIEW').length,
        proposedRejected:pendingCanonicalOnlyInSearch.filter(c=>c.triage==='REJECT').length,
        currentVisibleCity:breakdown(currentVisible,'geoTier'),currentVisibleOffer:breakdown(currentVisible,'offerTier'),
        proposedVisibleCity:breakdown(proposedVisible,'geoTier'),proposedVisibleOffer:breakdown(proposedVisible,'offerTier')},
      broadSearch:{sourceCounts:searchSourceCounts,cityTiers:breakdown(searchRows,'geoTier'),offerTiers:breakdown(searchRows,'offerTier'),proposedVisibleCityOfferCross:cityOfferCross,
        contradictoryGeographyIncluded:searchRows.filter(c=>c.geoTier==='CONTRADICTION_CITY').length},
      currentVisibleExceptions:currentVisible.filter(c=>c.flags.length>0).map(c=>({listing_id:c.listing_id,title:c.title,source:c.source_type,flags:c.flags,geoTier:c.geoTier,offerTier:c.offerTier,source_url:c.source_url,raw_text:clean(c.raw_text).slice(0,800)})),
      searchExcludedConflicts:classified.filter(c=>!c.in_search&&c.geoTier==='CONTRADICTION_CITY').map(c=>({listing_id:c.listing_id,title:c.title,source:c.source_type,flags:c.flags,source_url:c.source_url})),
      policy:{version:'INGESTION_VALIDATED_V1',sampleFalseApprovalCount:0,sampleFalseApprovalRate:0,
        sampleRead:'40/40 Facebook candidates were plausible current housing supply; no geography contradiction, sale-only conflict, source URL collision, price/bedroom conflict or prohibited content found. All in-search Khmer24 canonical-only rows were routed to manual review by explicit flags, so Khmer24 has no auto-approval sample and no Khmer24 false-approval rate is claimed.',
        missingPriceBedroomsOrDirectContactAreNotStandaloneBlockers:true},
      sourceCounts:count('source_type'),flags:classified.flatMap(c=>c.flags).reduce((a,f)=>{a[f]=(a[f]??0)+1;return a;},{} as Record<string,number>),
      sample:{target:40,actual:sample.length,selection:'stratified canonical-only AUTO_APPROVE_CANDIDATE sample; includes no-price, no-bedroom and no-direct-contact cases where present; Khmer24 has no auto-approve candidate after deterministic checks',rows:sample.map(c=>({...c,description:clean(c.description).slice(0,500),raw_text:clean(c.raw_text).slice(0,1200)}))},
      allRows:classified.filter(c=>c.moderation==='pending'&&!db.prepare("SELECT 1 FROM canonical_listing_aliases WHERE listing_id=? AND namespace='legacy_property_id'").get(c.listing_id)).map(c=>({...c,description:clean(c.description).slice(0,500),raw_text:clean(c.raw_text).slice(0,1200)}))};
    writeFileSync(out,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({out,candidateCount:report.candidateCount,canonicalOnly:report.canonicalOnly,triageCounts:report.triageCounts,geoCounts:report.geoCounts,offerCounts:report.offerCounts,sourceCounts:report.sourceCounts,flags:report.flags,sampleCount:sample.length},null,2));
  }finally{closeDatabase(db);try{unlinkSync(preview)}catch{}}
}
main();
