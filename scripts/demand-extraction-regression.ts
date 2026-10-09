/**
 * Live regression check for the canonical demand-extraction prompt (budget, dates, duration, bedrooms, preferences,
 * pets/people), plus deterministic sanitizer checks.
 *
 * Usage: npm run test:demand-extraction
 */
import 'dotenv/config';
import { createAiRouter, validateCompleteBatchItems } from '../src/modules/ai';
import {
  DEMAND_EXTRACTION_PROMPT,
  detectLanguage,
  hasActionableCriteria,
  sanitizeDemandFacts,
  type DemandExtraction,
} from '../src/modules/parser/demand-extraction';

const POSTED_AT = '2026-10-06';
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = Number(process.env.REGRESSION_BATCH_DELAY_MS ?? 25_000);

interface Case {
  id: string;
  text: string;
  expect: (d: DemandExtraction) => string | null;
}

const eq = (label: string, got: unknown, want: unknown) => (got === want ? null : `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const incl = (label: string, got: string[], re: RegExp) => (got.some((x) => re.test(x)) ? null : `${label}: got ${JSON.stringify(got)}, want match ${re}`);
const excl = (label: string, got: string[], re: RegExp) => (got.some((x) => re.test(x)) ? `${label}: unexpectedly contains ${re} in ${JSON.stringify(got)}` : null);
const all = (...checks: Array<string | null>) => checks.filter(Boolean).join('; ') || null;

const ALL_CASES: Case[] = [
  { id: 'budget-approx', text: 'Looking for a 1BR apartment, around $350/month.', expect: (d) => all(eq('target', d.budget_target, 350), eq('approx', d.budget_is_approximate, true), eq('min', d.budget_min, null), eq('max', d.budget_max, null), eq('currency', d.currency, 'USD')) },
  { id: 'budget-range', text: 'Need a studio, budget $300-400 per month.', expect: (d) => all(eq('min', d.budget_min, 300), eq('max', d.budget_max, 400), eq('target', d.budget_target, null)) },
  { id: 'budget-cap', text: 'Any apartment available under $400?', expect: (d) => all(eq('min', d.budget_min, null), eq('max', d.budget_max, 400), eq('target', d.budget_target, null)) },
  { id: 'budget-floor', text: 'Looking for a room, at least $250 a month is fine.', expect: (d) => all(eq('min', d.budget_min, 250), eq('max', d.budget_max, null)) },
  { id: 'budget-plain', text: 'Looking for a room, $150/month.', expect: (d) => all(eq('target', d.budget_target, 150), eq('approx', d.budget_is_approximate, false)) },
  { id: 'no-budget-no-currency', text: 'Looking for an apartment in Siem Reap.', expect: (d) => all(eq('currency', d.currency, null), eq('target', d.budget_target, null), eq('max', d.budget_max, null)) },
  { id: 'duration-range', text: 'Need an apartment for 3-6 months.', expect: (d) => all(eq('min', d.duration_min_months, 3), eq('max', d.duration_max_months, 6)) },
  { id: 'duration-floor', text: 'Need an apartment for at least 6 months.', expect: (d) => all(eq('min', d.duration_min_months, 6), eq('max', d.duration_max_months, null)) },
  { id: 'duration-vague', text: 'Looking for an apartment, long term.', expect: (d) => all(eq('min', d.duration_min_months, null), eq('max', d.duration_max_months, null), incl('duration_text', d.duration_text ? [d.duration_text] : [], /long/i)) },
  { id: 'bedrooms-exact', text: 'Looking for a 2BR apartment.', expect: (d) => all(eq('bed min', d.bedrooms_min, 2), eq('bed max', d.bedrooms_max, 2), eq('people', d.people_count, null)) },
  { id: 'bedrooms-range', text: 'Need 1-2 bedrooms, apartment or small house.', expect: (d) => all(eq('bed min', d.bedrooms_min, 1), eq('bed max', d.bedrooms_max, 2), incl('types', d.property_types, /^Apartment$/), incl('types', d.property_types, /^Private House$/)) },
  { id: 'flat-is-apartment', text: 'Me and my friend looking for a flat with two bedrooms.', expect: (d) => all(incl('types', d.property_types, /^Apartment$/), excl('types', d.property_types, /^Flat House$/)) },
  { id: 'bedrooms-plus', text: 'Looking for a villa with 2+ bedrooms.', expect: (d) => all(eq('bed min', d.bedrooms_min, 2), eq('bed max', d.bedrooms_max, null), incl('types', d.property_types, /^Private Villa$/)) },
  { id: 'must-vs-nice', text: 'Looking for a 1BR. Must have a kitchen, ideally a balcony.', expect: (d) => all(incl('must', d.must_haves, /kitchen/i), incl('nice', d.nice_to_haves, /balcony/i), excl('must', d.must_haves, /balcony/i), excl('nice', d.nice_to_haves, /kitchen/i)) },
  { id: 'excludes', text: 'Need an apartment, no ground floor, not near Pub Street.', expect: (d) => all(incl('exclude_features', d.exclude_features, /ground/i), incl('exclude_areas', d.exclude_areas, /pub street/i), excl('areas', d.areas, /pub street/i)) },
  { id: 'pets-people', text: 'My wife and I and our dog need a 2BR in Wat Bo.', expect: (d) => all(eq('has_pets', d.has_pets, true), incl('pet_types', d.pet_types, /dog/i), eq('people', d.people_count, 2), incl('areas', d.areas, /wat bo/i)) },
  { id: 'move-in-month', text: 'Moving to Siem Reap, need a place from November.', expect: (d) => all(eq('move_in_date', d.move_in_date, '2026-11-01'), eq('has move_in_text', d.move_in_text !== null, true)) },
  { id: 'move-in-asap', text: 'Need a room ASAP.', expect: (d) => all(eq('move_in_date', d.move_in_date, null), incl('move_in_text', d.move_in_text ? [d.move_in_text] : [], /asap/i)) },
];

// REGRESSION_ONLY=id1,id2 reruns selected cases only
const ONLY = process.env.REGRESSION_ONLY?.split(',').map((x) => x.trim()).filter(Boolean);
const CASES = ONLY ? ALL_CASES.filter((c) => ONLY.includes(c.id)) : ALL_CASES;

function deterministicChecks(): string[] {
  const failures: string[] = [];
  const check = (label: string, got: unknown, want: unknown) => JSON.stringify(got) === JSON.stringify(want) || failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  const s = (raw: Record<string, unknown>) => sanitizeDemandFacts(raw, 'x')!;

  const approx = s({ budget_min: 350, budget_max: 350, budget_is_approximate: true });
  check('approx min=max becomes target', [approx.budget_min, approx.budget_max, approx.budget_target], [null, null, 350]);
  const swapped = s({ budget_min: 400, budget_max: 300 });
  check('min>max swapped', [swapped.budget_min, swapped.budget_max], [300, 400]);
  check('bad date rejected', s({ move_in_date: '2026-13-45' }).move_in_date, null);
  check('good date kept', s({ move_in_date: '2026-11-01' }).move_in_date, '2026-11-01');
  check('type aliases', s({ property_types: ['house', 'Villa', 'Studio', 'castle'] }).property_types, ['Private House', 'Private Villa', 'Studio']);
  check('currency dropped without budget', s({ currency: 'USD' }).currency, null);
  check('non-object rejected', sanitizeDemandFacts('nope', 'x'), null);
  check('people must be >= 1 integer', s({ people_count: 0 }).people_count, null);
  check('language en', detectLanguage('Looking for a room'), 'en');
  check('language km', detectLanguage('ខ្ញុំកំពុងរកផ្ទះជួល'), 'km');
  check('language ru', detectLanguage('Ищу квартиру в Сием Рип'), 'ru');
  check('empty facts have no criteria', hasActionableCriteria(s({})), false);
  check('budget counts as criteria', hasActionableCriteria(s({ budget_max: 400 })), true);
  return failures;
}

async function main() {
  const router = createAiRouter();
  const failures = deterministicChecks();
  console.log(`deterministic sanitizer checks: ${failures.length === 0 ? 'ok' : `FAILED (${failures.length})`}`);

  for (let i = 0; i < CASES.length; i += BATCH_SIZE) {
    const batch = CASES.slice(i, i + BATCH_SIZE);
    const { data, providerName, model, fallbackDepth } = await router.generateJson<{ items: Array<{ id: string; result?: unknown }> }>({
      systemPrompt: DEMAND_EXTRACTION_PROMPT,
      userPrompt: JSON.stringify(batch.map(({ id, text }) => ({ id, text, posted_at: POSTED_AT }))),
      validate: (res) => {
        const contract = validateCompleteBatchItems(res, batch.map((c) => c.id));
        if (contract !== true) return contract;
        return batch.every((c) => sanitizeDemandFacts(res.items.find((r) => r.id === c.id)?.result, c.text) !== null) || 'missing/invalid items';
      },
    });
    console.log(`batch ${i / BATCH_SIZE + 1}: ${providerName}/${model} (fallbackDepth ${fallbackDepth})`);
    for (const c of batch) {
      const facts = sanitizeDemandFacts(data.items.find((r) => r.id === c.id)?.result, c.text);
      const failure = facts ? c.expect(facts) : 'no result';
      console.log(`  ${failure ? 'FAIL' : 'ok  '} ${c.id}${failure ? ` -> ${failure}` : ''}`);
      if (failure) failures.push(`${c.id} [${providerName}]: ${failure}`);
    }
    if (i + BATCH_SIZE < CASES.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  console.log(failures.length === 0 ? '\nALL PASSED' : `\n${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥', err instanceof Error ? err.message : err);
  process.exit(1);
});
