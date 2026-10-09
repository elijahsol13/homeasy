import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../src/config/env';
import { CanonicalShadowService, type CanonicalGoldenPairInput } from '../src/modules/parser/canonical-dedupe';

interface GoldenFile { algorithmVersion?:string; pairs:CanonicalGoldenPairInput[] }

function parseArgs(args:string[]):{input:string;algorithm:string;repostAlgorithm:string}{
  let input='';let algorithm='canonical-dedupe-v1';let repostAlgorithm='repost-v1';
  for(let i=0;i<args.length;i++){
    const arg=args[i]!;
    if(arg==='--input')input=path.resolve(args[++i]??'');
    else if(arg==='--algorithm')algorithm=args[++i]??'';
    else if(arg==='--repost-algorithm')repostAlgorithm=args[++i]??'';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if(!input||!algorithm||!repostAlgorithm)throw new Error('Usage: npm run ingestion:canonical-golden -- --input <golden.json> [--algorithm version]');
  return{input,algorithm,repostAlgorithm};
}

function main():void{
  const options=parseArgs(process.argv.slice(2));const fixture=JSON.parse(fs.readFileSync(options.input,'utf8')) as GoldenFile;
  if(!Array.isArray(fixture.pairs)||!fixture.pairs.length)throw new Error('Golden fixture must contain labeled pairs');
  const db=new DatabaseSync(path.resolve(env.DATABASE_PATH),{readOnly:true});
  try{
    const latest=db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {version:number|null};
    if((latest.version??0)<40)throw new Error('Apply database migrations through v40 before golden evaluation');
    const evaluated=new CanonicalShadowService(db,options.algorithm,options.repostAlgorithm).evaluateGoldenPairs(fixture.pairs);
    const humanPositives=evaluated.pairs.filter((pair)=>pair.humanLabel==='SAME_LISTING'||pair.humanLabel==='SAME_PROPERTY_DIFFERENT_LISTING');
    const retrievalHits=humanPositives.filter((pair)=>pair.selectedByProductionRetrieval).length;
    const falseMerges=evaluated.pairs.filter((pair)=>pair.humanLabel==='DIFFERENT_PROPERTY'&&(pair.decision==='SAME_LISTING'||pair.decision==='SAME_PROPERTY_DIFFERENT_LISTING')).length;
    const possibleAbstentionsOnNegatives=evaluated.pairs.filter((pair)=>pair.humanLabel==='DIFFERENT_PROPERTY'&&pair.decision==='POSSIBLE_SAME_PROPERTY').length;
    const confusion:Record<string,number>={};for(const pair of evaluated.pairs){const key=`${pair.humanLabel} → ${pair.decision}`;confusion[key]=(confusion[key]??0)+1;}
    const output={algorithmVersion:evaluated.algorithmVersion,goldenPairCount:evaluated.goldenPairCount,
      confirmedPositiveCount:humanPositives.length,candidateRetrievalRecall:humanPositives.length?Number((retrievalHits/humanPositives.length).toFixed(4)):null,
      retrievalHits,falseMerges,possibleAbstentionsOnNegatives,confusion,pairs:evaluated.pairs};
    console.log(JSON.stringify(output,null,2));
  }finally{db.close();}
}

try{main();}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
