/** Offline, read-only QA of resumable Gemini previews for the live public cohort.
 * Usage: npx ts-node scripts/audit-visible-canonical-ai-replay.ts
 * All artifacts remain local; generated HTML contains original public ad text.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';
import { sourceRoomCounts } from '../src/modules/parser/source-room-counts';

type Obj = Record<string, unknown>;
type Item = { id: number; sourceItemId: number; sourceSha256: string; source: string;
  typedValid: boolean; error?: string; before?: Obj; after?: Obj; reviewReasons?: string[] };
const INPUT = resolve('reports/homeasy-visible-canonical-ai-replay-20261023.jsonl');
const PREFIX = resolve('reports/homeasy-visible-canonical-ai-review-20261023');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const pct = (n: number, d: number) => d ? +(n / d * 100).toFixed(1) : null;
const h = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const redact = (v: unknown) => String(v ?? '')
  .replace(/(?:\+?855[\s.-]?|\b0)\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g, '[phone]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
  .replace(/(?:https?:\/\/|www\.)\S+/gi, '[link]')
  .replace(/\b(?:t\.me|wa\.me|fb\.me|facebook\.com)\/\S+/gi, '[contact]')
  .replace(/@[A-Za-z][A-Za-z0-9_]{2,}/g, '[handle]');
const fieldNames = ['price','currency','category','property_type','bedrooms','bathrooms',
  'min_lease_months','deposit_amount','deposit_months','pet_friendly','has_pool',
  'electricity_type','electricity_rate','water_type','water_rate','sangkat',
  'discovered_amenities'] as const;
const report = (k: string, n: number, d: number) => `${k}: ${n}/${d} (${pct(n,d)}%)`;
function failureGroup(error: string): string {
  if (error === 'missing_or_stale') return 'not_attempted_or_source_changed';
  if (/discovered_amenities.*canonical ID/i.test(error)) return 'noncatalog_amenity';
  if (/JSON parse error/i.test(error)) return 'malformed_json';
  if (/Typed response invalid/i.test(error)) return 'other_schema_error';
  if (/^Gemini:/.test(error)) return 'provider_error';
  return 'other_error';
}

function main() {
  const lines = readFileSync(INPUT, 'utf8').trim().split('\n').map((x) => JSON.parse(x) as Item);
  const latest = new Map<number, Item>();
  for (const line of lines) latest.set(line.id, line);
  const db = new DatabaseSync(resolve('data/homeasy.db'), { readOnly: true });
  db.exec('PRAGMA query_only=ON');
  const ids = new CanonicalListingRepository(db).listPublicListingIds({ city: 'siem_reap', type: 'rent' });
  const q = db.prepare(`SELECT s.id AS source_item_id,s.source_type,s.raw_text,l.public_ref
    FROM canonical_listings l JOIN canonical_listing_source_occurrences o
      ON o.id=l.primary_source_occurrence_id AND o.is_current=1
    JOIN source_items s ON s.id=o.source_item_id WHERE l.id=?`);
  const gold: Array<{ id: number; sourceSha256: string; bedrooms: number|null;
    bathrooms: number|null; monthlyRentUsd?: number }> = JSON.parse(
      readFileSync(resolve('reports/homeasy-ai-extraction-stage4-gold-20261023.json'),'utf8')).pairs;
  const goldById = new Map(gold.map((r) => [r.id, r]));
  const flagged: Record<string, number> = {};
  const changes: Record<string, { bothKnown: number; differing: number; recovered: number; cleared: number }> = {};
  const sourceCounts = { checked:0, same:0, different:0, ambiguous:0 };
  const goldFacts = { checked:0, correct:0, coveredListings:0 };
  const editorial = { nonempty:0, exactRawCopies:0, over450Chars:0, titlesOver6Words:0,
    khmerInEnglishDescription:0, promotionalPhrasing:0, contactCTAs:0, contactDetails:0 };
  const detail: Array<{ id:number; source:string; current:boolean; status:string; reasons:string[];
    raw:string; before:Obj; after:Obj; sourceRoom:ReturnType<typeof sourceRoomCounts>|null }> = [];
  for (const id of ids) {
    const row = q.get(id) as {source_item_id:number;source_type:string;raw_text:string;public_ref:string}|undefined;
    if (!row) throw new Error(`Missing source for public ID ${id}`);
    const entry = latest.get(id);
    const current = !!entry && entry.sourceItemId===row.source_item_id && entry.sourceSha256===hash(row.raw_text);
    const valid = !!entry?.typedValid && current && !!entry.after;
    const after = valid ? entry!.after! : {};
    const before = valid ? entry!.before ?? {} : entry?.before ?? {};
    const reasons = valid ? [...entry!.reviewReasons ?? []] : [current ? entry?.error ?? 'invalid' : 'missing_or_stale'];
    const known = sourceRoomCounts(row.raw_text);
    if (valid) {
      for (const f of fieldNames) {
        const old = f === 'price' ? before.priceUsdCents : f === 'discovered_amenities'
          ? ((before.facts as Obj | undefined)?.discovered_amenities ?? []) : f in before
            ? before[f] : (before.facts as Obj | undefined)?.[f];
        const next = after[f];
        const metric = changes[f] ??= { bothKnown:0,differing:0,recovered:0,cleared:0 };
        const oldKnown = old !== null && old !== undefined && (!Array.isArray(old) || old.length>0);
        const nextKnown = next !== null && next !== undefined && (!Array.isArray(next) || next.length>0);
        if (oldKnown && nextKnown) { metric.bothKnown++; if (JSON.stringify(old)!==JSON.stringify(f==='price' && typeof next==='number' && after.currency==='USD'?next*100:next)) metric.differing++; }
        if (!oldKnown && nextKnown) metric.recovered++;
        if (oldKnown && !nextKnown) metric.cleared++;
      }
      for (const kind of ['bedrooms','bathrooms'] as const) {
        if (known[kind] === null) continue;
        sourceCounts.checked++;
        if (after[kind]===known[kind]) sourceCounts.same++; else {
          sourceCounts.different++; reasons.push(`source_${kind}_mismatch`);
        }
      }
      if (known.conflictingBedrooms || known.conflictingBathrooms) sourceCounts.ambiguous++;
      const truth = goldById.get(id);
      if (truth?.sourceSha256 === entry!.sourceSha256) {
        goldFacts.coveredListings++;
        for (const [f,v] of [['bedrooms',truth.bedrooms],['bathrooms',truth.bathrooms],['price',truth.monthlyRentUsd]] as const) {
          if (v===null || v===undefined) continue;
          goldFacts.checked++;
          if (after[f]===v) goldFacts.correct++;
          else reasons.push(`gold_${f}_mismatch`);
        }
      }
      const desc = String(after.description_en??'');
      if (desc.trim()) editorial.nonempty++;
      if (desc.trim() === row.raw_text.trim()) { editorial.exactRawCopies++; reasons.push('editorial_raw_copy'); }
      if (desc.length>450) { editorial.over450Chars++; reasons.push('editorial_long_description'); }
      if (String(after.title_en??'').trim().split(/\s+/).length>6) { editorial.titlesOver6Words++; reasons.push('editorial_long_title'); }
      if (/[\u1780-\u17ff]/.test(desc)) { editorial.khmerInEnglishDescription++; reasons.push('editorial_contains_khmer'); }
      if (/\b(?:luxury|amazing|perfect|affordable|spacious|modern|beautiful|ideal|stunning)\b/i.test(desc)) { editorial.promotionalPhrasing++; reasons.push('editorial_promotional_adjective'); }
      if (/\b(?:call|contact|whatsapp|telegram|inbox|dm|message us)\b/i.test(desc)) { editorial.contactCTAs++; reasons.push('editorial_contact_cta'); }
      if (/https?:\/\/|(?:\+?855[\s-]?|\b0)\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3,4}/i.test(desc)) { editorial.contactDetails++; reasons.push('editorial_contact_detail'); }
    }
    for (const reason of new Set(reasons)) flagged[reason] = (flagged[reason] ?? 0)+1;
    detail.push({ id,source:row.source_type,current,status:valid?'typed_valid':'failed_or_unprocessed',reasons:[...new Set(reasons)],
      raw:row.raw_text,before,after,sourceRoom:known });
  }
  db.close();
  const valid = detail.filter(x => x.status==='typed_valid');
  const failures: Record<string,number> = {};
  for (const d of detail.filter(x => x.status!=='typed_valid')) {
    const category = failureGroup(d.reasons[0] ?? 'missing_or_stale');
    failures[category] = (failures[category] ?? 0) + 1;
  }
  const bySource = Object.fromEntries(['FACEBOOK_GROUP','KHMER24'].map(s => [s,{
    public:detail.filter(x=>x.source===s).length, typedValid:valid.filter(x=>x.source===s).length,
    flaggedValid:valid.filter(x=>x.source===s && x.reasons.length).length }]));
  const summary = {public:ids.length, uniqueRecorded:latest.size, totalAttempts:lines.length,
    sourceHashMatched:detail.filter(x=>x.current).length,
    typedValid:valid.length, typedValidPct:pct(valid.length,ids.length), bySource,
    failures, flagged, changes, sourceCounts:{...sourceCounts,matchingPct:pct(sourceCounts.same,sourceCounts.checked)},
    goldFacts:{...goldFacts,accuracyPct:pct(goldFacts.correct,goldFacts.checked)}, editorial,
    pendingIds:detail.filter(x=>x.status!=='typed_valid').map(x=>x.id),
    reviewIds:valid.filter(x=>x.reasons.length).map(x=>x.id),
    note:'Source counts are heuristic evidence, not independent gold. Existing-vs-AI differences are NOT an accuracy metric. Amenities are represented differently in old cards and new canonical IDs.'};
  const rows = detail.map(d=> {
    const badges = d.reasons.map(x=>`<b>${h(x)}</b>`).join(' ');
    const facts = fieldNames.map(f=> {
      const old = f==='price' && typeof d.before.priceUsdCents==='number' ? `${(d.before.priceUsdCents / 100).toFixed(2)} ${d.before.currency??'USD'}`
        : f in d.before? d.before[f] : (d.before.facts as Obj | undefined)?.[f]??null;
      const next = f==='price' && typeof d.after.price==='number' ? `${d.after.price} ${d.after.currency??''}` : d.after[f]??null;
      return `<tr><th>${h(f)}</th><td>${h(JSON.stringify(old))}</td><td>${h(JSON.stringify(next))}</td></tr>`;
    }).join('');
    return `<article class="card" data-id="${d.id}" data-status="${h(d.status)}" data-flag="${d.reasons.length?'flagged':'clean'}" data-source="${h(d.source)}"><h2>#${d.id} · ${h(d.source)} · ${h(d.status)}</h2><p>${badges}</p>
      <details><summary>Original advertisement</summary><pre>${h(d.raw)}</pre></details>
      <div class="pair"><section><h3>Old card</h3><h4>${h(d.before.title)}</h4><p>${h(d.before.description)}</p></section>
      <section><h3>New AI draft</h3><h4>${h(d.after.title_en)}</h4><p>${h(d.after.description_en)}</p></section></div>
      <details><summary>All extracted properties</summary><table><tr><th>Field</th><th>Old card</th><th>New AI</th></tr>${facts}</table></details></article>`;
  }).join('\n');
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Homeasy AI — public listing review</title>
  <style>body{font:15px system-ui;background:#f4f6f8;color:#1a2230;max-width:1200px;margin:auto;padding:20px}h1{margin:0}header{position:sticky;top:0;background:#f4f6f8;padding:12px 0;z-index:2;border-bottom:1px solid #cbd3dc} .card{background:white;border:1px solid #d7dde4;border-radius:12px;padding:16px;margin:18px 0} .pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}section{padding:8px;background:#fafafa} pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}p{white-space:pre-wrap;line-height:1.5}b{display:inline-block;background:#ffefd7;padding:4px;margin:2px;border-radius:4px;font-weight:500}table{border-collapse:collapse;width:100%;overflow-wrap:anywhere}td,th{border:1px solid #e0e4e8;text-align:left;vertical-align:top;padding:7px}select{padding:8px;margin-right:12px}@media(max-width:700px){.pair{grid-template-columns:1fr}}</style>
  <header><h1>Homeasy — 30-day public cohort AI review</h1><p>${valid.length}/${ids.length} typed-valid · ${detail.length-valid.length} pending/failed · ${Object.keys(flagged).length} flag categories</p>
  <label>Status <select id="status"><option>all</option><option>typed_valid</option><option>failed_or_unprocessed</option></select></label>
  <label>Review <select id="flag"><option>all</option><option>flagged</option><option>clean</option></select></label>
  <label>Source <select id="source"><option>all</option><option>FACEBOOK_GROUP</option><option>KHMER24</option></select></label>
  <label>Search <input id="search" placeholder="ID or text"></label></header>
  <main>${rows}</main><script>const picks=['status','flag','source'].map(id=>document.getElementById(id)); const search=document.getElementById('search'); function filt(){const q=search.value.trim().toLowerCase(); for(const card of document.querySelectorAll('.card')) card.hidden=picks.some(el=>el.value!=='all'&&card.dataset[el.id]!==el.value)||(q&&!card.textContent.toLowerCase().includes(q))} picks.forEach(el=>el.addEventListener('change',filt));search.addEventListener('input',filt);</script></html>`;
  writeFileSync(PREFIX+'.json',JSON.stringify(summary,null,2)+'\n',{mode:0o600});
  writeFileSync(PREFIX+'.html',html,{mode:0o600});
  chmodSync(PREFIX+'.json',0o600); chmodSync(PREFIX+'.html',0o600);
  const md=`# Homeasy Gemini replay QA — public 30-day Siem Reap rent cohort\n\n`+
    `${report('Typed-valid',valid.length,ids.length)}; source hash matched ${summary.sourceHashMatched}/${ids.length}; attempts ${lines.length}.\n\n`+
    `Source: ${JSON.stringify(bySource)}.\n\nSchema/provider failures: ${JSON.stringify(failures)}.\n\nReview reasons: ${JSON.stringify(flagged)}.\n\n`+
    `Source room checks: ${report('matching',sourceCounts.same,sourceCounts.checked)}; ${sourceCounts.ambiguous} conflicting-source-count listings.\n\n`+
    `SHA-matched manually annotated gold: ${report('numeric matches',goldFacts.correct,goldFacts.checked)} across ${goldFacts.coveredListings} listings.\n\n`+
    `Editorial checks (typed-valid only): ${JSON.stringify(editorial)}.\n\n`+
    `Changes (old vs AI, not necessarily errors):\n\n| Property | Both known | Differing | New known | Newly null |\n|---|---:|---:|---:|---:|\n`+
    Object.entries(changes).map(([k,v])=>`| ${k} | ${v.bothKnown} | ${v.differing} | ${v.recovered} | ${v.cleared} |`).join('\n')+
    `\n\nReview IDs: ${summary.reviewIds.join(', ')}. Pending: ${summary.pendingIds.join(', ')}.\n\n`+
    `These heuristics do not establish whole-corpus accuracy. The HTML review includes original public source text and must stay local. No live database writes occurred.\n`;
  writeFileSync(PREFIX+'.md',md,{mode:0o600}); chmodSync(PREFIX+'.md',0o600);
  console.log(JSON.stringify({summary,artifacts:[PREFIX+'.json',PREFIX+'.md',PREFIX+'.html']}));
}
main();
