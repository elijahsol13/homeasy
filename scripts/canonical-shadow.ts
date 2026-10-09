import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase, closeDatabase } from '../src/database/db';
import { env } from '../src/config/env';
import { CanonicalShadowService } from '../src/modules/parser/canonical-dedupe';

function parseArgs(args: string[]): { dryRun: boolean; algorithm: string; repostAlgorithm: string } {
  let dryRun = false; let commit = false; let algorithm = 'canonical-dedupe-v1'; let repostAlgorithm = 'repost-v1';
  for (let i=0;i<args.length;i++) {
    const arg=args[i]!;
    if(arg==='--dry-run')dryRun=true;
    else if(arg==='--commit')commit=true;
    else if(arg==='--algorithm')algorithm=args[++i]??'';
    else if(arg==='--repost-algorithm')repostAlgorithm=args[++i]??'';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if(dryRun===commit)throw new Error('Pass exactly one of --dry-run or --commit');
  if(!algorithm||!repostAlgorithm)throw new Error('Algorithm version is required');
  return{dryRun,algorithm,repostAlgorithm};
}

function main():void{
  const options=parseArgs(process.argv.slice(2));
  const db=options.dryRun?new DatabaseSync(path.resolve(env.DATABASE_PATH),{readOnly:true}):createDatabase();
  try{
    const latest=db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {version:number|null};
    if((latest.version??0)<43)throw new Error('Apply database migrations through v43 before canonical shadow run');
    const report=new CanonicalShadowService(db,options.algorithm,options.repostAlgorithm).run({dryRun:options.dryRun});
    console.log(JSON.stringify({...report,dryRun:options.dryRun},null,2));
  }finally{closeDatabase(db);}
}

try{main();}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
