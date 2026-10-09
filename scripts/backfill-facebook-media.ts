import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase, closeDatabase } from '../src/database/db';
import { runMigrations } from '../src/database/migrate';
import { env } from '../src/config/env';
import { createContainer } from '../src/container';
import { ReplayAdapter } from '../src/modules/parser/replay-adapter';

interface RecoveredMediaItem { sourceItemId: number; externalId: string; classification: string; photoUrls: string[] }
interface SourcePayloadRow { id: number; external_id: string; source_type: string; classification: string; raw_payload_json: string }

function parseArgs(args: string[]): { input: string; dryRun: boolean } {
  let input='';let dryRun=false;let commit=false;
  for(let i=0;i<args.length;i++){
    const arg=args[i]!;
    if(arg==='--input')input=path.resolve(args[++i]??'');
    else if(arg==='--dry-run')dryRun=true;
    else if(arg==='--commit')commit=true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if(!input)throw new Error('Usage: npm run ingestion:backfill-fb-media -- --input <recovered-media.json> (--dry-run | --commit)');
  if(dryRun===commit)throw new Error('Pass exactly one of --dry-run or --commit');
  return{input,dryRun};
}

async function main():Promise<void>{
  const options=parseArgs(process.argv.slice(2));
  const allRecovered=JSON.parse(fs.readFileSync(options.input,'utf8')) as RecoveredMediaItem[];
  if(!Array.isArray(allRecovered))throw new Error('Media input must be an array');
  const recovered=allRecovered.filter((item)=>item.classification==='HOUSING_SUPPLY');
  const db=options.dryRun?new DatabaseSync(path.resolve(env.DATABASE_PATH),{readOnly:true}):createDatabase();
  const replayPath=path.join(os.tmpdir(),`homeasy-fb-media-replay-${process.pid}.json`);
  try{
    if(!options.dryRun)runMigrations(db);
    const byId=new Map(recovered.map((item)=>[item.sourceItemId,item]));
    if(byId.size!==recovered.length)throw new Error('Media input contains duplicate source item ids');
    const rows=db.prepare(`SELECT id,external_id,source_type,classification,raw_payload_json FROM source_items
      WHERE id IN (${recovered.map(()=>'?').join(',')}) ORDER BY id`).all(...recovered.map((item)=>item.sourceItemId)) as unknown as SourcePayloadRow[];
    if(rows.length!==recovered.length)throw new Error(`Only ${rows.length}/${recovered.length} source items exist in the database`);
    const posts=rows.map((row)=>{
      const media=byId.get(row.id)!;
      if(row.source_type!=='FACEBOOK_GROUP'||row.classification!=='HOUSING_SUPPLY'||media.classification!=='HOUSING_SUPPLY')throw new Error(`Refusing non-supply Facebook media for source item ${row.id}`);
      if(media.externalId!==row.external_id)throw new Error(`External id mismatch for source item ${row.id}`);
      const payload=JSON.parse(row.raw_payload_json) as Record<string,unknown>;
      const urls=[...new Set(media.photoUrls.filter((url)=>/^https?:\/\//i.test(url)&&/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(url)))].sort();
      return{...payload,photos:urls,photoAssets:urls.map((url)=>({url,perceptualHash:null,hashAlgorithm:'dhash',hashVersion:1}))};
    });
    if(posts.some((post)=>!post.classification))throw new Error('Recovered Facebook items must retain their saved classification');
    fs.writeFileSync(replayPath,JSON.stringify({runId:'existing-brightdata-snapshot-media-recovery',posts}));
    const container=createContainer({db});
    const result=await container.ingestionService.ingestBatch(new ReplayAdapter(replayPath),{
      runType:'MANUAL_IMPORT',ingestionMethod:'MANUAL',dryRun:options.dryRun,parserVersion:'fb-media-backfill-v1',
    });
    console.log(JSON.stringify({mode:options.dryRun?'dry-run':'commit',inputItems:result.inputItems,
      newSourceItems:result.newSourceItems,updatedSourceItems:result.updatedSourceItems,
      unchangedSourceItems:result.unchangedSourceItems,newVersions:result.newVersions,
      recoveredItems:posts.length,skippedNonSupplyItems:allRecovered.length-recovered.length,photoUrls:posts.reduce((sum,post)=>sum+post.photos.length,0),
      errors:result.errors.length,errorSamples:result.errors.slice(0,10)},null,2));
    if(result.errors.length)process.exitCode=2;
  }finally{
    try{fs.unlinkSync(replayPath);}catch{/* temporary replay file may already be absent */}
    closeDatabase(db);
  }
}

main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
