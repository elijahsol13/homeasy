/** Conservative source-first geography triage for the Siem Reap cutover audit.
 * Structured listing fields and generated prose are useful conflict signals,
 * but only the original post can justify an automatic out-of-city rejection.
 */
export type SourceGeographyInput = {
  rawText?: string | null;
  title?: string | null;
  description?: string | null;
  city?: string | null;
  propertyCity?: string | null;
  sangkat?: string | null;
  explicitLocation?: string | null;
  sourceCity?: string | null;
};

export type SourceGeographyTier =
  | 'CONTRADICTION_CITY'
  | 'GEOGRAPHY_CONFLICT'
  | 'EXACT_CITY'
  | 'PROBABLE_CITY'
  | 'UNKNOWN_CITY';

/** Khmer24's historic Siem Reap administrative `post.location.map` centre.
 * Independently observed in unrelated ads across several sangkats; it is not
 * proof of a property's location even when earlier enrichment copied it into
 * listing facts, a canonical property or a synthesized Google Maps URL.
 * Limit this check to the known centre and Khmer24 provenance at call sites. */
export function isKnownKhmer24AdministrativePin(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude - 13.35789016603966) < 0.0000001
    && Math.abs(longitude - 103.86067953898747) < 0.0000001;
}

const outsideCity = /\b(?:phnom\s*penh|phnompenh|kandal|battambang|poipet|kampong\s*(?:cham|thom|speu|chhnang)|sihanoukville|preah\s*sihanouk|takeo|kampot|kep|pursat|prey\s*veng|svay\s*rieng|ratanakiri|mondulkiri|stung\s*treng|kratie|oddar\s*meanchey|koh\s*kong|pailin)\b|(?:តាកែវ|កណ្ដាល|ភ្នំពេញ|បាត់ដំបង|កំពង់ចាម|កំពង់ធំ|កំពង់ស្ពឺ|ព្រះសីហនុ)/i;
const siemReap = /\bsiem\s*reap\b|សៀមរាប/i;
const siemArea = /\b(?:sala\s*kam(?:reuk|roek)|svay\s*dangkum|slor\s*kram|sla\s*kram|slorkram|wat\s*bo|wat\s*damnak|wat\s*polanka|chreav|bakong|pub\s*street|old\s*market)\b/i;

// A named sangkat asserted as the property's address is stronger evidence of
// Siem Reap than a nearby attraction. Do not infer a pin from the sangkat or
// trust "5 minutes to Pub Street" as an address. Agency offices are unrelated.
const sangkat = '(?:svay\\s*da(?:ng|n|kg)kum|sala\\s*kam(?:reuk|raeuk|roek)|sla\\s*kram|slor\\s*kram|kok\\s*chak)';
const locatedInSangkat = new RegExp(`\\b(?:located|situated)\\s+(?:in|at)\\s+(?:the\\s+)?${sangkat}\\b`, 'i');
const sangkatAsLocation = new RegExp(`^(?:(?:city\\s+center|sangkat|commune)\\s*[,:-]?\\s*)?${sangkat}\\b`, 'i');
const labelledSangkat = new RegExp(`^(?:property\\s+)?(?:location|address|area)\\s*[:=-]\\s*${sangkat}\\b`, 'i');

function assertsPropertySangkat(raw: string): boolean {
  return raw.split(/\r?\n/).some((line) => {
    const value = line.trim().replace(/^[\s✅📍🔹📌•*+\-–—:]+/u, '');
    if (/\b(?:agency|office|showroom|headquarters|contact)\b|ការិយាល័យ/i.test(value)) return false;
    return locatedInSangkat.test(value) || sangkatAsLocation.test(value) || labelledSangkat.test(value);
  });
}

function hasLocationAssertionOutside(raw: string): boolean {
  // Avoid mistaking incidental mentions ("owner relocated to Phnom Penh",
  // bus routes, agent contact address) for the property's location.
  return raw.split(/\r?\n/).some((line) => {
    const normalized = line.trim().replace(/^[📍🏠\s]+/u, '');
    if (/^(?:location|property\s+location|address|city|located\s+in|situated\s+in|ទីតាំង)\s*(?::|-|\s)/i.test(normalized)) {
      return outsideCity.test(normalized);
    }
    return /^(?:.{0,45}\b(?:apartment|house|villa|condo|land|studio|room)\b.{0,70}\b(?:in|at)\s+)/i.test(normalized)
      && outsideCity.test(normalized);
  });
}

export function assessSiemReapGeography(input: SourceGeographyInput): {
  tier: SourceGeographyTier;
  flags: string[];
} {
  const raw = input.rawText ?? '';
  const structured = [input.sangkat, input.explicitLocation].filter(Boolean).join(' ');
  const generated = [input.title, input.description].filter(Boolean).join(' ');
  const rawExact = siemReap.test(raw);
  const rawArea = siemArea.test(raw);
  const derivedLocal = siemReap.test(structured) || siemArea.test(structured);
  const sourceOutsideLocation = hasLocationAssertionOutside(raw);
  const sourceOutsideMention = outsideCity.test(raw);
  const derivedOutside = outsideCity.test(generated) || outsideCity.test(structured)
    || [input.city, input.propertyCity].some((c) => outsideCity.test((c ?? '').replaceAll('_', ' ')));
  const flags: string[] = [];

  if (sourceOutsideLocation && !rawExact && !rawArea) {
    flags.push('SOURCE_OUTSIDE_CITY');
    return { tier: 'CONTRADICTION_CITY', flags };
  }

  if (sourceOutsideLocation || sourceOutsideMention || derivedOutside) {
    flags.push('GEOGRAPHY_NEEDS_SOURCE_REVIEW');
    return { tier: 'GEOGRAPHY_CONFLICT', flags };
  }

  if (rawExact || assertsPropertySangkat(raw)) return { tier: 'EXACT_CITY', flags };
  if (rawArea || derivedLocal || siemReap.test((input.sourceCity ?? '').replaceAll('_', ' '))) {
    flags.push('PROBABLE_CITY_REQUIRES_REVIEW');
    return { tier: 'PROBABLE_CITY', flags };
  }
  flags.push('INSUFFICIENT_SOURCE_GEOGRAPHY');
  return { tier: 'UNKNOWN_CITY', flags };
}
