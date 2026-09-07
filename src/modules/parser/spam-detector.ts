// ─── Non-Real-Estate Spam Patterns ──────────────────────────────────────────

export const SPAM_REGEXES: RegExp[] = [
  // Vehicles / scooters
  /\b(?:zoomer|scoopy|scooby|motorcycle|motorbike)\b/i,
  /មានកាតគ្រី/, // "has registration card" (vehicle title in Cambodia)
  // Transportation / Taxis
  /\b(?:airport transfer|taxi driver|reliable driver|transportation service)\b/i,
  // Jobs & Employment
  /\b(?:seeking a (?:cook|waiter|chef|cleaner)|line\/prep cook|salary is negotiable)\b/i,
  /ទទួលយកការងារផ្នែកសំណង់/, // "accepting all construction work"
  // Goods / Delivery ads
  /ប្រេងក្រអូប/, // fragrant oil
  /\b(?:free delivery|special promotion)\b/i,
  /ដឹកជញ្ជូនឥតគិតថ្លៃ/, // "free delivery"
  // Entertainment / Movies / Drama
  /រឿង\s*មន្តស្នេហ៍/,
  /\b(?:drama series|episode|ភាគ\d+)\b/i,
  // Short-term hotel / guesthouse per night
  /\b(?:1\s*night|per\s*night)\b/i,
  /1\s*យប់\s*\d+\$/, // "1 night $XX"
  // Beauty, Hair, Nails, Massage & Salons
  /\b(?:hair\s*salon|nail\s*salon|beauty\s*salon|massage|layer\s*perm|perm|uonnongtieuchuan)\b/i,
  /#Rin26\b/i,
  /ហាងកាត់សក់|សាឡន/, // barbershop / salon in Khmer
];

/**
 * Checks if a post is non-real-estate spam (vehicles, taxis, jobs, delivery ads, salons, pure land).
 * Run BEFORE submitting to AI models to save tokens/quotas.
 */
export function isNonRealEstateSpam(
  title: string,
  description: string,
): { isSpam: boolean; reason?: string } {
  const combined = `${title} ${description}`.trim();

  // Exclude real estate posts that merely mention walking distance to airport or coffee shops
  if (/\b(?:apartment|villa|condo|house for rent|room for rent)\b/i.test(title)) {
    return { isSpam: false };
  }

  for (const regex of SPAM_REGEXES) {
    if (regex.test(combined)) {
      return { isSpam: true, reason: `Matched spam regex: ${regex}` };
    }
  }

  // Pure land sales (we only list residential properties: apartments, houses, rooms)
  if (
    /^\s*ដី(?![\s\S]*(?:ផ្ទះ|house|villa|apartment))/i.test(title) &&
    !/ផ្ទះ|house|villa/i.test(combined)
  ) {
    return { isSpam: true, reason: 'Pure land sale listing (no residential structure)' };
  }

  return { isSpam: false };
}
