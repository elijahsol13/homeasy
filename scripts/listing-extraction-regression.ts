/**
 * Live regression check for the canonical listing-extraction prompt (utilities + geography policy).
 * Small on purpose: 12 synthetic posts in batches of 3 through the AiRouter, plus deterministic geography checks.
 *
 * Usage: npm run test:listing-extraction
 */
import 'dotenv/config';
import { createAiRouter, validateCompleteBatchItems } from '../src/modules/ai';
import {
  geographyStatus,
  isAcceptedForSiemReapInventory,
  LISTING_EXTRACTION_PROMPT,
  sanitizeListingFacts,
  type ListingExtraction,
} from '../src/modules/parser/listing-extraction';

const BASE = 'Studio for rent in Wat Bo, $250/month, furnished. ';
const BATCH_DELAY_MS = Number(process.env.REGRESSION_BATCH_DELAY_MS ?? 25_000);

interface Case {
  id: string;
  text: string;
  expect: (f: ListingExtraction) => string | null; // null = pass, string = failure description
}

const eq = (label: string, got: unknown, want: unknown) => (got === want ? null : `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const has = (label: string, got: string | null, re: RegExp) => (got && re.test(got) ? null : `${label}: got ${JSON.stringify(got)}, want ${re}`);
const all = (...checks: Array<string | null>) => checks.filter(Boolean).join('; ') || null;

const CASES: Case[] = [
  { id: 'elec-edc', text: `${BASE}Electricity EDC rate.`, expect: (f) => all(eq('electricity_type', f.electricity_type, 'state_rate'), eq('electricity_rate', f.electricity_rate, null)) },
  { id: 'elec-gov', text: `${BASE}Electricity government rate.`, expect: (f) => all(eq('electricity_type', f.electricity_type, 'state_rate'), eq('electricity_rate', f.electricity_rate, null)) },
  { id: 'elec-fixed-usd', text: `${BASE}Electricity $0.25/kWh.`, expect: (f) => all(eq('electricity_type', f.electricity_type, 'fixed'), has('electricity_rate', f.electricity_rate, /0\.25/)) },
  { id: 'elec-fixed-riel', text: `${BASE}Electricity 1000 riel/kWh.`, expect: (f) => all(eq('electricity_type', f.electricity_type, 'fixed'), has('electricity_rate', f.electricity_rate, /1,?000/)) },
  { id: 'elec-free', text: `${BASE}Free electricity.`, expect: (f) => eq('electricity_type', f.electricity_type, 'included') },
  { id: 'elec-none', text: BASE.trim(), expect: (f) => all(eq('electricity_type', f.electricity_type, null), eq('electricity_rate', f.electricity_rate, null)) },
  { id: 'water-included', text: `${BASE}Water included.`, expect: (f) => eq('water_type', f.water_type, 'included') },
  { id: 'water-state', text: `${BASE}Water state price.`, expect: (f) => all(eq('water_type', f.water_type, 'state_rate'), eq('water_rate', f.water_rate, null)) },
  { id: 'water-per-person', text: `${BASE}Water $5 per person.`, expect: (f) => all(eq('water_type', f.water_type, 'fixed'), has('water_rate', f.water_rate, /5/)) },
  { id: 'water-none', text: BASE.trim(), expect: (f) => all(eq('water_type', f.water_type, null), eq('water_rate', f.water_rate, null)) },
  {
    id: 'geo-no-city',
    text: 'Studio in Wat Bo $250/month, 1 bathroom, fully furnished.',
    expect: (f) => all(eq('accepted', isAcceptedForSiemReapInventory(f), true), eq('geography', geographyStatus(f.city) !== 'out_of_area', true)),
  },
  {
    id: 'geo-other-city',
    text: 'Studio in BKK1 Phnom Penh $450/month, 1 bathroom, fully furnished.',
    expect: (f) => all(eq('accepted', isAcceptedForSiemReapInventory(f), false), eq('geography', geographyStatus(f.city), 'out_of_area')),
  },
];

function deterministicChecks(): string[] {
  const failures: string[] = [];
  const check = (label: string, got: unknown, want: unknown) => got === want || failures.push(`geographyStatus ${label}: got ${got}, want ${want}`);
  check('null', geographyStatus(null), 'unknown_city');
  check('empty', geographyStatus('  '), 'unknown_city');
  check('Siem Reap', geographyStatus('Siem Reap'), 'siem_reap');
  check('Siem Reap City', geographyStatus('Siem Reap City'), 'siem_reap');
  check('Phnom Penh', geographyStatus('Phnom Penh'), 'out_of_area');
  check('Kampot', geographyStatus('Kampot'), 'out_of_area');
  check('Cambodia', geographyStatus('Cambodia'), 'unknown_city');
  return failures;
}

async function main() {
  const router = createAiRouter();
  const failures = deterministicChecks();
  console.log(`deterministic geography checks: ${failures.length === 0 ? 'ok' : 'FAILED'}`);

  for (let i = 0; i < CASES.length; i += 3) {
    const batch = CASES.slice(i, i + 3);
    const { data, providerName, model, fallbackDepth } = await router.generateJson<{ items: Array<{ id: string; result?: unknown }> }>({
      systemPrompt: LISTING_EXTRACTION_PROMPT,
      userPrompt: JSON.stringify(batch.map(({ id, text }) => ({ id, text }))),
      validate: (res) => {
        const contract = validateCompleteBatchItems(res, batch.map((c) => c.id));
        if (contract !== true) return contract;
        return batch.every((c) => sanitizeListingFacts(res.items.find((r) => r.id === c.id)?.result, c.text) !== null) || 'missing/invalid items';
      },
    });
    console.log(`batch ${i / 3 + 1}: ${providerName}/${model} (fallbackDepth ${fallbackDepth})`);
    for (const c of batch) {
      const facts = sanitizeListingFacts(data.items.find((r) => r.id === c.id)?.result, c.text);
      const failure = facts ? c.expect(facts) : 'no result';
      console.log(`  ${failure ? 'FAIL' : 'ok  '} ${c.id}${failure ? ` -> ${failure}` : ''}`);
      if (failure) failures.push(`${c.id} [${providerName}]: ${failure}`);
    }
    if (i + 3 < CASES.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  console.log(failures.length === 0 ? '\nALL PASSED' : `\n${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥', err instanceof Error ? err.message : err);
  process.exit(1);
});
