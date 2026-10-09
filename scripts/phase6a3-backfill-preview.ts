import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDatabase, closeDatabase } from '../src/database/db';
import { runMigrations } from '../src/database/migrate';
import { createContainer } from '../src/container';
import { installLegacyPropertiesWriteGuard, snapshotLegacyProperties } from '../src/database/legacy-write-guard';
import { FacebookLiveAdapter, type LiveListingEnvelope } from '../src/modules/parser/live-source-adapters';
import type { LegacyPropertyRow } from '../src/modules/parser/legacy-khmer24-backfill-adapter';
import type { RawListing } from '../src/modules/parser/schemas';

const sourcePath=process.env.PHASE6A_DB??'data/rebuild/phase6a-checkpoint-20261007.db';
const ids=[158,18,3];
const previewPath=path.join(tmpdir(),`homeasy-phase6a3-${crypto.randomUUID()}.db`);

async function main():Promise<void>{
  if(!existsSync(sourcePath))throw new Error(`Checkpoint not found: ${sourcePath}`);
  copyFileSync(sourcePath,previewPath);
  const db=createDatabase(previewPath);
  try{
    runMigrations(db);
    const legacyBefore=snapshotLegacyProperties(db);
    const rows=db.prepare(`SELECT * FROM properties WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).all(...ids) as unknown as LegacyPropertyRow[];
    if(rows.length!==ids.length)throw new Error('Expected local legacy rows 3, 18 and 158');
    const byUrl=new Map<string,{sourceId:string;sourceName:string;groupName:string;registryUrl?:string}>();
    for(const row of rows){
      const url=String(row.source_url??row.original_url??'');
      const match=url.match(/facebook\.com\/groups\/([^/]+)\/posts\/([^/?#]+)/i);
      if(!match)throw new Error(`Row ${row.id} has no stable Facebook post identity`);
      const groupId=match[1]!;
      const registry=db.prepare('SELECT name,url FROM source_registry WHERE external_source_id=? AND source_type=\'FACEBOOK_GROUP\' LIMIT 1').get(groupId) as {name:string;url:string}|undefined;
      byUrl.set(url,{sourceId:groupId,sourceName:registry?.name??`Facebook group ${groupId}`,groupName:registry?.name??`Facebook group ${groupId}`,registryUrl:registry?.url});
    }
    const fetcher=async function*():AsyncIterable<LiveListingEnvelope>{
      for(const row of rows){
        const sourceUrl=String(row.source_url??row.original_url??'');
        const group=byUrl.get(sourceUrl)!;
        const parsed=(value:unknown,fallback:unknown)=>{try{return typeof value==='string'?JSON.parse(value):fallback}catch{return fallback}};
        const facts=parsed(row.listing_facts_json,{});
        const contact=parsed(row.direct_contact,{});
        const listing:RawListing={
          title:String(row.title??''),description:String(row.description??''),raw_text:String(row.raw_text??''),
          price:Number(row.price)>0?Number(row.price)/100:undefined,currency:String(row.currency??'USD'),
          type:String(row.type??'rent'),category:row.category as RawListing['category'],property_type:String(row.property_type??'')||undefined,
          bedrooms:row.bedrooms===null?undefined:Number(row.bedrooms),bathrooms:row.bathrooms===null?undefined:Number(row.bathrooms),
          location:String(row.raw_location??row.location??'')||undefined,city:String(row.city??'siem_reap'),source_url:sourceUrl,url:sourceUrl,
          photos:parsed(row.photos,[]) as string[],phone:typeof contact.phone==='string'?contact.phone:undefined,
          telegram_contact:typeof contact.telegram==='string'?contact.telegram:undefined,
          posted_at:String(row.posted_at??row.created_at),listing_facts_json:typeof facts==='object'?JSON.stringify(facts):undefined,
        };
        yield {listing,sourceName:group.sourceName,sourceId:group.sourceId,sourceUrl:group.registryUrl,groupId:group.sourceId,groupName:group.groupName,classification:'HOUSING_SUPPLY'};
      }
    };
    const before=db.prepare(`SELECT (SELECT COUNT(*) FROM source_items) sourceItems,(SELECT COUNT(*) FROM source_item_versions) versions,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences WHERE is_current=1) currentOccurrences,
      (SELECT COUNT(*) FROM canonical_listings) listings`).get();
    installLegacyPropertiesWriteGuard(db);
    const container=createContainer({db});
    const result=await container.ingestionService.ingestBatch(new FacebookLiveAdapter(fetcher),{
      runType:'MANUAL_IMPORT',ingestionMethod:'MANUAL',parserVersion:'phase6a3-local-facebook-backfill-v1',observedAt:'2026-10-07T00:00:00.000Z',
    });
    const after=db.prepare(`SELECT (SELECT COUNT(*) FROM source_items) sourceItems,(SELECT COUNT(*) FROM source_item_versions) versions,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences WHERE is_current=1) currentOccurrences,
      (SELECT COUNT(*) FROM canonical_listings) listings`).get();
    const repeat=await container.ingestionService.ingestBatch(new FacebookLiveAdapter(fetcher),{
      runType:'MANUAL_IMPORT',ingestionMethod:'MANUAL',parserVersion:'phase6a3-local-facebook-backfill-v1',observedAt:'2026-10-07T00:00:00.000Z',
    });
    const afterRepeat=db.prepare(`SELECT (SELECT COUNT(*) FROM source_items) sourceItems,(SELECT COUNT(*) FROM source_item_versions) versions,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences WHERE is_current=1) currentOccurrences,
      (SELECT COUNT(*) FROM canonical_listings) listings`).get();
    const details=db.prepare(`SELECT p.id legacy_id,s.id source_item_id,s.classification,s.parser_version,s.source_type,s.external_id,s.canonical_url,
      pr.run_type,rs.ingestion_method,o.id occurrence_id,o.listing_id,l.public_ref,l.property_id,o.dedupe_decision_id,d.decision canonical_decision,
      (SELECT COUNT(*) FROM source_item_versions v WHERE v.source_item_id=s.id) versions,
      (SELECT COUNT(*) FROM ai_processing_results a WHERE a.source_item_id=s.id) ai_attempts,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences o WHERE o.source_item_id=s.id AND o.is_current=1) current_occurrences,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences o WHERE o.source_item_id=s.id AND o.is_current=0) historical_occurrences,
      (SELECT COUNT(*) FROM dedupe_cluster_members m WHERE m.source_item_id=s.id) repost_members,
      (SELECT COUNT(DISTINCT o.listing_id) FROM canonical_listing_source_occurrences o WHERE o.source_item_id=s.id AND o.is_current=1) bound_listings
      FROM properties p JOIN source_items s ON s.canonical_url=p.source_url OR s.source_url=p.source_url
      LEFT JOIN processing_runs pr ON pr.id=s.processing_run_id LEFT JOIN processing_run_sources rs ON rs.processing_run_id=pr.id AND rs.source_registry_id=s.source_registry_id
      LEFT JOIN canonical_listing_source_occurrences o ON o.source_item_id=s.id AND o.is_current=1
      LEFT JOIN canonical_listings l ON l.id=o.listing_id LEFT JOIN dedupe_decisions d ON d.id=o.dedupe_decision_id
      WHERE p.id IN (${ids.map(()=>'?').join(',')}) ORDER BY p.id`).all(...ids);
    const dedupeAudit=(details as Array<{legacy_id:number;source_item_id:number;dedupe_decision_id:number|null}>).map((item)=>{
      if(!item.dedupe_decision_id)return{legacyId:item.legacy_id,decision:null,otherCandidate:null};
      const decision=db.prepare('SELECT * FROM dedupe_decisions WHERE id=?').get(item.dedupe_decision_id) as {
        id:number;candidate_a_type:string;candidate_a_id:number;candidate_b_type:string;candidate_b_id:number;decision:string;
        property_score:number;listing_score:number;reasons_json:string;details_json:string;
      }|undefined;
      if(!decision)return{legacyId:item.legacy_id,decision:null,otherCandidate:null};
      const otherId=Number(decision.candidate_a_id)===item.source_item_id?Number(decision.candidate_b_id):Number(decision.candidate_a_id);
      const otherCandidate=db.prepare(`SELECT s.id source_item_id,s.source_type,s.external_id,s.canonical_url,s.raw_text,
        o.listing_id,l.title listing_title,l.city,l.sangkat,l.explicit_location,l.price,l.bedrooms,o.source_url,o.is_current
        FROM source_items s LEFT JOIN canonical_listing_source_occurrences o ON o.source_item_id=s.id AND o.is_current=1
        LEFT JOIN canonical_listings l ON l.id=o.listing_id WHERE s.id=?`).get(otherId);
      return{legacyId:item.legacy_id,decision:{id:decision.id,decision:decision.decision,propertyScore:decision.property_score,listingScore:decision.listing_score,
        reasons:JSON.parse(decision.reasons_json),evidence:JSON.parse(decision.details_json)},nearestExistingSourceItemId:otherId,otherCandidate};
    });
    const legacyAfter=snapshotLegacyProperties(db);
    const duplicateBindings=db.prepare(`SELECT COUNT(*) n FROM (SELECT source_item_id,source_entity_key FROM canonical_listing_source_occurrences WHERE is_current=1 GROUP BY 1,2 HAVING COUNT(*)>1)`).get() as {n:number};
    const report={mode:'isolated-copy-commit-preview',sourcePath,previewPath,rowsInspected:rows.map((r)=>({id:r.id,url:r.source_url??r.original_url,classification:/phnom\s*penh|ភ្នំពេញ/i.test(`${r.title} ${r.raw_text}`)?'INTENTIONALLY_EXCLUDED':'BACKFILL_CANDIDATE'})),insufficientLocalData:[{legacyId:2,status:'INSUFFICIENT_LOCAL_DATA',reason:'The raw post only says the owner relocated to Phnom Penh; it does not state the villa location. Legacy location is empty and group scope alone is only a prior.'}],ingestion:result,before,after,repeat,afterRepeat,details,dedupeAudit,
      acceptance:{legacyUnchanged:legacyBefore.digest===legacyAfter.digest&&legacyBefore.count===legacyAfter.count,legacyBefore:{count:legacyBefore.count,digest:legacyBefore.digest},legacyAfter:{count:legacyAfter.count,digest:legacyAfter.digest},duplicateCurrentBindings:duplicateBindings.n,
        idempotent:repeat.errors.length===0&&repeat.newSourceItems===0&&repeat.newVersions===0&&repeat.unchangedSourceItems===ids.length&&JSON.stringify(after)===JSON.stringify(afterRepeat),
        aiAttempts:(details as Array<{ai_attempts:number}>).reduce((n,r)=>n+Number(r.ai_attempts),0),errors:result.errors.length}};
    const out='reports/phase6a3-backfill-preview-20261007.json';writeFileSync(out,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({out,...report.acceptance,ingestion:{inputItems:result.inputItems,processedItems:result.processedItems,errors:result.errors},repeat:{inputItems:repeat.inputItems,unchanged:repeat.unchangedSourceItems,newVersions:repeat.newVersions,errors:repeat.errors},details},null,2));
  }finally{closeDatabase(db);try{unlinkSync(previewPath)}catch{/* preview DB is disposable */}}
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.stack:String(error));process.exitCode=1;});
