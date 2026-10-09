import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../src/config/env';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';

function parseArgs(args: string[]): { algorithm: string; repostAlgorithm: string } {
  let algorithm='canonical-dedupe-v1';let repostAlgorithm='repost-v1';
  for(let i=0;i<args.length;i++){
    const arg=args[i]!;
    if(arg==='--algorithm')algorithm=args[++i]??'';
    else if(arg==='--repost-algorithm')repostAlgorithm=args[++i]??'';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if(!algorithm||!repostAlgorithm)throw new Error('Algorithm versions are required');
  return{algorithm,repostAlgorithm};
}

function main():void{
  const options=parseArgs(process.argv.slice(2));
  const db=new DatabaseSync(path.resolve(env.DATABASE_PATH),{readOnly:true});
  try{
    const latest=db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {version:number|null};
    if((latest.version??0)<43)throw new Error('Apply database migrations through v43 before canonical calibration');
    console.log(JSON.stringify(new CanonicalShadowService(db,options.algorithm,options.repostAlgorithm).auditCrossSourceCartesian(),null,2));
  }finally{db.close();}
}

try{main();}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
