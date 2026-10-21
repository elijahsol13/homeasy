/** Owner-authorized one-off AI reevaluation from a read-only API-container Pending export.
 * No DB access or writes. Incrementally checkpoint output so failed provider calls are auditable.
 * Usage: node -r ts-node/register -r dotenv/config scripts/audit-pending-reextraction.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AiRouter } = require('../src/modules/ai/router');
const { extractCanonicalListingsBatch } = require('../src/modules/parser/canonical-listing-extractor');
const { sourceRoomCounts } = require('../src/modules/parser/source-room-counts');

const input = process.env.HOMEASY_PENDING_INPUT || '/private/tmp/homeasy-pending-source-20261019.json';
const output = process.env.HOMEASY_PENDING_OUTPUT || '/private/tmp/homeasy-pending-reextracted-20261019.json';
const source = JSON.parse(fs.readFileSync(input, 'utf8'));
const eligible = source.items.filter(r => r.raw_text?.trim().length > 40);
const existing = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : {startedAt:new Date().toISOString(),items:[],providerCalls:[]};
if (existing.inputHash && existing.inputHash !== createHash('sha256').update(fs.readFileSync(input)).digest('hex')) {
  throw new Error('Source export changed; refuse to resume with different sources');
}
existing.inputHash = createHash('sha256').update(fs.readFileSync(input)).digest('hex');
// Retry missed items after a connectivity/provider failure when resuming.
existing.items = existing.items.filter(i => i.ai);
const save = () => fs.writeFileSync(output, JSON.stringify(existing,null,2));
const seen = new Set(existing.items.map(i=>i.id));
const originalGenerate = AiRouter.prototype.generateJson;
AiRouter.prototype.generateJson = async function(args) {
  const startedAt = new Date().toISOString();
  try {
    const result = await originalGenerate.call(this,args);
    existing.providerCalls.push({startedAt,provider:result.providerName,model:result.model,fallbackDepth:result.fallbackDepth,
      attempts:result.metrics.map(m=>({provider:m.provider,success:m.success,schemaValid:m.schemaValid,failureReason:m.failureReason||null}))});
    return result;
  } catch(e) {
    existing.providerCalls.push({startedAt,error:String(e.message||e).slice(0,250)});
    throw e;
  }
};
const origWarn=console.warn;
console.warn = (...args) => { const s=String(args[0]||'');
  if(s.includes('[CanonicalExtractor]')||s.includes('[AiRouter]')) process.stderr.write(s.replace(/https?:\/\/\S+/g,'[source url]').slice(0,220)+'\n');
};
(async()=>{
  let progress=0;
  for(let i=0;i<eligible.length;i+=3){
    const chunk=eligible.slice(i,i+3).filter(r=>!seen.has(r.id));
    if(!chunk.length)continue;
    const inputs=chunk.map(r=>({id:r.id,text:[r.source_title,r.raw_text].filter(Boolean).join('\n')}));
    const outcomes=await extractCanonicalListingsBatch(inputs);
    for(const row of chunk){
      const f=outcomes.get(row.id);
      const { phone_numbers, telegram_links, ...safeFacts } = f||{};
      existing.items.push({id:row.id,source_item_id:row.source_item_id,decision_origin:row.decision_origin,
        source_type:row.source_type,sourceUrl:row.source_url,
        original:{bedrooms:row.bedrooms,bathrooms:row.bathrooms,price:row.price===null?null:row.price/100,city:row.city,reason:row.review_reason},
        explicitRooms:sourceRoomCounts([row.source_title,row.raw_text].join('\n')),
        ai: f?safeFacts:null,sha256:createHash('sha256').update(inputs.find(x=>x.id===row.id).text).digest('hex')});
      seen.add(row.id);
    }
    save();
    progress+=chunk.length;
    process.stdout.write(JSON.stringify({completed:existing.items.length,total:eligible.length,returned:existing.items.filter(i=>i.ai).length,
      calls:existing.providerCalls.length,latest:chunk.map(x=>x.id)})+'\n');
  }
  existing.finishedAt=new Date().toISOString();save();
  origWarn('Completed; output: '+path.basename(output));
})().catch(err=>{save();origWarn('Pending re-extraction interrupted: '+String(err?.message||err));process.exitCode=1;});
