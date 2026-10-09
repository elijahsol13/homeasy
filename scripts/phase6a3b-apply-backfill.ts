import { DatabaseSync } from 'node:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDatabase, closeDatabase } from '../src/database/db';
import { runMigrations } from '../src/database/migrate';
import { assertLegacyPropertiesUnchanged, installLegacyPropertiesWriteGuard, snapshotLegacyProperties } from '../src/database/legacy-write-guard';
import { createContainer } from '../src/container';
import { FacebookLiveAdapter, type LiveListingEnvelope } from '../src/modules/parser/live-source-adapters';
import type { LegacyPropertyRow } from '../src/modules/parser/legacy-khmer24-backfill-adapter';
import type { RawListing } from '../src/modules/parser/schemas';

const targetPath=process.env.PHASE6A3_TARGET??'data/homeasy.db';
const baselineCount=390;
const baselineDigest='59ff69ea7d35482ecec34e001a4b134306307af7a7216a05670c52eadaff2272';
const ids=[158,18,3];

function counts(db:DatabaseSync){return db.prepare(`SELECT (SELECT COUNT(*) FROM source_items) sourceItems,
  (SELECT COUNT(*) FROM source_item_versions) versions,
  (SELECT COUNT(*) FROM canonical_listing_source_occurrences WHERE is_current=1) currentOccurrences,
  (SELECT COUNT(*) FROM canonical_properties) properties,
  (SELECT COUNT(*) FROM canonical_listings) listings`).get() as Record<string,number>;}

async function main(){
  if(!existsSync(targetPath))throw new Error(`Target DB not found: ${targetPath}`);
  const db=createDatabase(targetPath);
  try{
    runMigrations(db);
    const legacyBefore=snapshotLegacyProperties(db);
    if(legacyBefore.count!==baselineCount||legacyBefore.digest!==baselineDigest)throw new Error(`Legacy baseline mismatch before backfill: ${JSON.stringify(legacyBefore)}`);
    const rows=db.prepare(`SELECT * FROM properties WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).all(...ids) as unknown as LegacyPropertyRow[];
    if(rows.length!==ids.length)throw new Error('Expected legacy rows 3, 18 and 158');
    const byUrl=new Map<string,{sourceId:string;sourceName:string;groupName:string;registryUrl?:string}>();
    for(const row of rows){
      const url=String(row.source_url??row.original_url??'');
      const match=url.match(/facebook\.com\/groups\/([^/]+)\/posts\/([^/?#]+)/i);
      if(!match)throw new Error(`Legacy row ${row.id} has no stable Facebook post identity`);
      const groupId=match[1]!;
      const registry=db.prepare("SELECT name,url FROM source_registry WHERE external_source_id=? AND source_type='FACEBOOK_GROUP' LIMIT 1").get(groupId) as {name:string;url:string}|undefined;
      byUrl.set(url,{sourceId:groupId,sourceName:registry?.name??`Facebook group ${groupId}`,groupName:registry?.name??`Facebook group ${groupId}`,registryUrl:registry?.url});
    }
    const fetcher=async function*():AsyncIterable<LiveListingEnvelope>{
      for(const row of rows){
        const sourceUrl=String(row.source_url??row.original_url??'');const group=byUrl.get(sourceUrl)!;
        const parsed=(value:unknown,fallback:unknown)=>{try{return typeof value==='string'?JSON.parse(value):fallback}catch{return fallback}};
        const facts=parsed(row.listing_facts_json,{});const contact=parsed(row.direct_contact,{});
        const listing:RawListing={title:String(row.title??''),description:String(row.description??''),raw_text:String(row.raw_text??''),
          price:Number(row.price)>0?Number(row.price)/100:undefined,currency:String(row.currency??'USD'),type:String(row.type??'rent'),
          category:row.category as RawListing['category'],property_type:String(row.property_type??'')||undefined,
          bedrooms:row.bedrooms===null?undefined:Number(row.bedrooms),bathrooms:row.bathrooms===null?undefined:Number(row.bathrooms),
          location:String(row.raw_location??row.location??'')||undefined,city:String(row.city??'siem_reap'),source_url:sourceUrl,url:sourceUrl,
          photos:parsed(row.photos,[]) as string[],phone:typeof contact.phone==='string'?contact.phone:undefined,
          telegram_contact:typeof contact.telegram==='string'?contact.telegram:undefined,posted_at:String(row.posted_at??row.created_at),
          listing_facts_json:typeof facts==='object'?JSON.stringify(facts):undefined};
        yield{listing,sourceName:group.sourceName,sourceId:group.sourceId,sourceUrl:group.registryUrl,groupId:group.sourceId,groupName:group.groupName,classification:'HOUSING_SUPPLY'};
      }
    };
    const before=counts(db);
    installLegacyPropertiesWriteGuard(db);
    const container=createContainer({db});
    const options={runType:'MANUAL_IMPORT' as const,ingestionMethod:'MANUAL' as const,parserVersion:'phase6a3-local-facebook-backfill-v1',observedAt:'2026-10-07T00:00:00.000Z'};
    const first=await container.ingestionService.ingestBatch(new FacebookLiveAdapter(fetcher),options);
    const afterFirst=counts(db);
    const addedCurrentOccurrences=Number(afterFirst.currentOccurrences)-Number(before.currentOccurrences);
    const repeat=await container.ingestionService.ingestBatch(new FacebookLiveAdapter(fetcher),options);
    const afterRepeat=counts(db);
    const legacyAfter=assertLegacyPropertiesUnchanged(db,legacyBefore);
    const duplicateBindings=(db.prepare(`SELECT COUNT(*) n FROM (SELECT source_item_id,source_entity_key FROM canonical_listing_source_occurrences
      WHERE is_current=1 GROUP BY source_item_id,source_entity_key HAVING COUNT(*)>1)`).get() as {n:number}).n;
    const publicRefs=db.prepare(`SELECT COUNT(*) total,COUNT(public_ref) nonNull,COUNT(DISTINCT public_ref) uniqueCount,
      SUM(CASE WHEN length(public_ref)>=12 THEN 1 ELSE 0 END) validCount FROM canonical_listings`).get() as Record<string,number>;
    const details=db.prepare(`SELECT p.id legacy_id,s.id source_item_id,s.source_type,s.external_id,s.canonical_url,s.classification,
      (SELECT COUNT(*) FROM source_item_versions v WHERE v.source_item_id=s.id) versions,
      (SELECT COUNT(*) FROM ai_processing_results a WHERE a.source_item_id=s.id) ai_attempts,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences o WHERE o.source_item_id=s.id AND o.is_current=1) current_occurrences,
      (SELECT COUNT(*) FROM canonical_listing_source_occurrences o WHERE o.source_item_id=s.id AND o.is_current=0) historical_occurrences,
      (SELECT listing_id FROM canonical_listing_source_occurrences o WHERE o.source_item_id=s.id AND o.is_current=1 LIMIT 1) listing_id,
      (SELECT public_ref FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id WHERE o.source_item_id=s.id AND o.is_current=1 LIMIT 1) public_ref,
      (SELECT decision FROM dedupe_decisions d JOIN canonical_listing_source_occurrences o ON o.dedupe_decision_id=d.id WHERE o.source_item_id=s.id AND o.is_current=1 LIMIT 1) dedupe_decision
      FROM properties p JOIN source_items s ON s.canonical_url=p.source_url OR s.source_url=p.source_url WHERE p.id IN (${ids.map(()=>'?').join(',')}) ORDER BY p.id`).all(...ids);
    const integrity=(db.prepare('PRAGMA integrity_check').all() as Array<Record<string,string>>).map(x=>Object.values(x)[0]);
    const foreignKeys=db.prepare('PRAGMA foreign_key_check').all();
    const report={generatedAt:new Date().toISOString(),mode:'permanent deterministic local ingestion under legacy write guard',targetPath,ids,
      externalRequests:0,aiRequests:0,backupPath:process.env.PHASE6A3_BACKUP_PATH??null,before,first,afterFirst,repeat,afterRepeat,details,
      legacy:{before:legacyBefore,after:legacyAfter,unchanged:legacyBefore.count===legacyAfter.count&&legacyBefore.digest===legacyAfter.digest},
      duplicateCurrentBindings:duplicateBindings,publicRefs,integrity,foreignKeyViolations:foreignKeys,
      acceptance:{firstNewSourceItems:first.newSourceItems,firstNewVersions:first.newVersions,firstNewCurrentOccurrences:Number(afterFirst.currentOccurrences)-Number(before.currentOccurrences),
        repeatUnchanged:repeat.unchangedSourceItems,newVersionsOnRepeat:repeat.newVersions,aiAttempts:Number((details as Array<{ai_attempts:number}>).reduce((a,x)=>a+Number(x.ai_attempts),0)),
        noLegacyWrites:legacyBefore.digest===legacyAfter.digest&&legacyBefore.count===legacyAfter.count,duplicateCurrentBindings:duplicateBindings}};
    const out='reports/phase6a3b-permanent-backfill-20261007.json';writeFileSync(out,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({out,acceptance:report.acceptance,before,afterFirst,afterRepeat,details,integrity,foreignKeyViolations:foreignKeys.length},null,2));
    if(first.errors.length||repeat.errors.length||first.newSourceItems!==ids.length||first.newVersions!==ids.length||addedCurrentOccurrences!==ids.length||repeat.unchangedSourceItems!==ids.length||repeat.newVersions!==0
      ||duplicateBindings!==0||!report.legacy.unchanged||integrity.some(x=>x!=='ok')||foreignKeys.length)throw new Error('Permanent Phase 6A.3b backfill acceptance failed; see report');
  }finally{closeDatabase(db);}
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.stack:String(error));process.exitCode=1;});
