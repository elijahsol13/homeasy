import { createDatabase, closeDatabase } from '../src/database/db';
import { env } from '../src/config/env';
import { runMigrations } from '../src/database/migrate';
import { generateImagePHash } from '../src/modules/parser/phash';

interface PhotoAsset { url: string; perceptualHash?: string | null; hashAlgorithm?: string; hashVersion?: number }
interface ItemRow { id: number; source_type: string; classification: string; raw_payload_json: string }

function parseArgs(args:string[]):{ids:number[]|null;allSupplyRepresentatives:boolean;perItemLimit:number}{
  const idIndex=args.indexOf('--source-item-ids');const allSupplyRepresentatives=args.includes('--all-supply-representatives');
  const limitIndex=args.indexOf('--limit-per-item');const perItemLimit=limitIndex>=0?Number(args[limitIndex+1]):5;
  if((idIndex>=0)===allSupplyRepresentatives)throw new Error('Pass exactly one of --source-item-ids or --all-supply-representatives');
  if(!Number.isInteger(perItemLimit)||perItemLimit<1||perItemLimit>10)throw new Error('--limit-per-item must be an integer from 1 to 10');
  const ids=idIndex<0?null:(args[idIndex+1]??'').split(',').map((value)=>Number(value.trim()));
  if(ids&&(!ids.length||ids.some((id)=>!Number.isInteger(id)||id<=0)||new Set(ids).size!==ids.length))throw new Error('Source item ids must be unique positive integers');
  for(let i=0;i<args.length;i++)if(!['--source-item-ids','--all-supply-representatives','--limit-per-item'].includes(args[i]!)&&args[i-1]!=='--source-item-ids'&&args[i-1]!=='--limit-per-item')throw new Error(`Unknown argument: ${args[i]}`);
  return{ids,allSupplyRepresentatives,perItemLimit};
}

async function main():Promise<void>{
  const options=parseArgs(process.argv.slice(2));const db=createDatabase();
  try{
    runMigrations(db);
    let ids=options.ids;
    if(options.allSupplyRepresentatives){
      const groupRows=db.prepare(`SELECT c.representative_source_item_id representative,m.source_item_id
        FROM dedupe_clusters c JOIN dedupe_cluster_members m ON m.cluster_id=c.id
        JOIN source_items s ON s.id=m.source_item_id
        WHERE c.algorithm_version='repost-v1' AND c.entity_type='SUPPLY_REPOST'
          AND s.source_type='FACEBOOK_GROUP' AND s.classification='HOUSING_SUPPLY'
        ORDER BY c.id,m.source_item_id`).all() as Array<{representative:number;source_item_id:number}>;
      const members=new Set(groupRows.map((row)=>row.source_item_id));const candidateIds=new Set(groupRows.map((row)=>row.representative));
      for(const row of db.prepare("SELECT id FROM source_items WHERE source_type='FACEBOOK_GROUP' AND classification='HOUSING_SUPPLY' ORDER BY id").all() as Array<{id:number}>)if(!members.has(row.id))candidateIds.add(row.id);
      ids=[...candidateIds].sort((a,b)=>a-b);
    }
    if(!ids)throw new Error('No source items resolved');
    const rows=db.prepare(`SELECT id,source_type,classification,raw_payload_json FROM source_items WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as unknown as ItemRow[];
    if(rows.length!==ids.length)throw new Error(`Found ${rows.length}/${ids.length} source items`);
    if(rows.some((row)=>row.source_type!=='FACEBOOK_GROUP'||row.classification!=='HOUSING_SUPPLY'))throw new Error('Only existing Facebook supply source items may be hashed');
    const payloads=new Map(rows.map((row)=>[row.id,JSON.parse(row.raw_payload_json) as Record<string,unknown>]));
    const assetsByItem=new Map<number,PhotoAsset[]>();const allAssetsByItem=new Map<number,PhotoAsset[]>();const urls=new Set<string>();
    for(const [id,payload]of payloads){
      const payloadAssets=Array.isArray(payload.photoAssets)?payload.photoAssets as PhotoAsset[]:[];
      const payloadUrls=Array.isArray(payload.photos)?payload.photos.filter((value):value is string=>typeof value==='string').map((url)=>({url})):[];
      const merged=new Map<string,PhotoAsset>();
      for(const asset of [...payloadAssets,...payloadUrls])if(asset&&/^https?:\/\//i.test(asset.url)&&/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(asset.url)){
        const previous=merged.get(asset.url);merged.set(asset.url,{...previous,...asset,perceptualHash:previous?.perceptualHash??asset.perceptualHash??null});
      }
      const allAssets=[...merged.values()].sort((a,b)=>a.url.localeCompare(b.url));
      const selected=allAssets.slice(0,options.perItemLimit);
      allAssetsByItem.set(id,allAssets);assetsByItem.set(id,selected);for(const asset of selected)if(!asset.perceptualHash)urls.add(asset.url);
    }
    const hashes=new Map<string,string|null>();const pending=[...urls];let next=0;let computed=0;let failed=0;
    const worker=async()=>{while(true){const index=next++;if(index>=pending.length)return;const url=pending[index]!;const hash=await generateImagePHash(url,10000);hashes.set(url,hash);if(hash)computed++;else failed++;}};
    await Promise.all(Array.from({length:2},()=>worker()));
    const update=db.prepare('UPDATE source_items SET raw_payload_json=?,updated_at=strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE id=?');
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const [id,payload]of payloads){const selected=new Map((assetsByItem.get(id)??[]).map((asset)=>[asset.url,asset]));const assets=allAssetsByItem.get(id)??[];payload.photoAssets=assets.map((asset)=>({
        ...asset,perceptualHash:asset.perceptualHash??selected.get(asset.url)?.perceptualHash??hashes.get(asset.url)??null,hashAlgorithm:'dhash',hashVersion:1,
      }));update.run(JSON.stringify(payload),id);}
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    console.log(JSON.stringify({sourceItems:rows.length,limitPerItem:options.perItemLimit,photoAssetsConsidered:[...assetsByItem.values()].reduce((sum,assets)=>sum+assets.length,0),
      urlsHashed:urls.size,hashesCalculated:computed,hashFailures:failed,storedAlgorithm:'dhash',storedVersion:1},null,2));
  }finally{closeDatabase(db);}
}

main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
