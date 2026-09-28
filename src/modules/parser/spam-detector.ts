// ─── Non-Real-Estate Spam Patterns ──────────────────────────────────────────

export const SPAM_REGEXES: RegExp[] = [
  // Vehicles / scooters / cars
  /\b(?:zoomer|pcx|scoopy|scooby|honda dream|click|exciter|prius|lexus|rx300|highlander|tuktuk|passapp|motorcycle|motorbike|camry|corolla|tundra|tacoma|starex|alphard)\b/i,
  /ម៉ូតូ|ឡាន|មានការគ្រី|ស្លាកលេខ/i, // moto, car, has registration card, license plate
  
  // Transportation / Taxis / Tours & Activities
  /\b(?:airport transfer|taxi driver|reliable driver|transportation service)\b/i,
  /\b(?:butterfly|butterflies|peacock|peacocks|cluedo|hit the course|golf course|photo tour|landscape and portrait)\b/i,
  /\b(?:book your wonderful plant|houseplant|plants for sale)\b/i,

  // Jobs, Visa, Employment & Services
  /\b(?:seeking a (?:cook|waiter|chef|cleaner)|line\/prep cook|salary is negotiable)\b/i,
  /ទទួលយកការងារផ្នែកសំណង់/, // "accepting all construction work"
  /\b(?:visa extension|travel assistance|dengue|fever|#doctor|#clinic|pharmacy)\b/i,

  // Computers, hardware, laptops, gadgets & PC components
  /\b(?:laptop|vivobook|thinkpad|macbook|dell latitude|asus|lenovo|acer|hp elitebook|intel core|ryzen|gaming pc|nvidia|geforce|radeon|gtx|rtx|ram\s*:\s*\d+|ssd\s*:\s*\d+|ddr[345]|vga\s*:)\b/i,

  // Peripherals, Audio & Electronics
  /\b(?:keyboard gaming|razer|mechanical keyboard|logitech|mouse pad|gaming headset|earbuds|airpods|headphone)\b/i,
  /\b(?:iphone|samsung galaxy|ipad|xiaomi|redmi|oppo|vivo|smartphone|smartwatch|apple watch)\b/i,
  /\b(?:camera|dslr|gopro|canon|nikon|sony alpha)\b/i,

  // Household standalone appliances / Knick-knacks resale
  /\b(?:blender|battery fan|cooling fan|laundry basket|digital clock|alarm clock|air fryer|microwave oven|smart cooling fan|toaster)\b/i,

  // Goods / Delivery / Clothing & Store photo dumps
  /ប្រេងក្រអូប/, // fragrant oil
  /\b(?:free delivery|special promotion)\b/i,
  /ដឹកជញ្ជូនឥតគិតថ្លៃ/, // "free delivery"
  /\b(?:store добавил|store added|новых? фото в альбом|album set|t-shirt|shoes|sneakers|dress|handbag|skincare|cosmetics|lipstick|perfume)\b/i,
  /\b(?:second-hand local items|comes with all (?:the )?accessories|brand new in box|bnib|used once only)\b/i,

  // Social media UI artifacts
  /\b(?:кто угодно может видеть участников группы|anyone can see who's in the group|IRRELEVANT_CONTENT)\b/i,

  // Entertainment / Movies / Drama
  /រឿង\s*មន្តស្នេហ៍/,
  /\b(?:drama series|episode|ភាគ\d+)\b/i,

  // Short-term hotel / guesthouse / daily rent
  /\b(?:1\s*night|per\s*night|\/night|មួយយប់|per\s*day|\/day|មួយថ្ងៃ)\b/i,
  /1\s*យប់\s*\d+\$/, // "1 night $XX"

  // Beauty, Hair, Nails, Massage & Salons
  /\b(?:hair\s*salon|nail\s*salon|beauty\s*salon|massage|layer\s*perm|perm|uonnongtieuchuan)\b/i,
  /#Rin26\b/i,
  /ហាងកាត់សក់|សាឡន/, // barbershop / salon in Khmer

  // Commercial Real Estate & Generic Agency Ads
  /\b(?:warehouse|restaurant space|office space|office for rent|commercial space)\b/i,
  /ហាងសំរាប់ជួល/, // shop for rent
  /\b(?:lowbudget rooms|many rooms from|we have many rooms|we have properties|many options available)\b/i,
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

  let score = 0;
  const evidence: string[] = [];

  for (const regex of SPAM_REGEXES) {
    if (regex.test(combined)) {
      score += 4;
      evidence.push(`spam:${regex}`);
    }
  }

  if (/\b(?:apartment|villa|condo|house for rent|room for rent|studio)\b/i.test(title)) {
    score -= 2;
    evidence.push('residential_title');
  }
  if (/\b(?:per month|monthly|\/month|month rent|long[ -]?term|lease)\b/i.test(combined)) {
    score -= 2;
    evidence.push('monthly_rental');
  }
  if (/\b\d+\s*(?:bed(?:room)?s?|br)|\b\d+\s*(?:bath(?:room)?s?|wc)\b/i.test(combined)) {
    score -= 1;
    evidence.push('property_specs');
  }

  if (score >= 4) {
    return { isSpam: true, reason: `Spam evidence score ${score}: ${evidence.join(', ')}` };
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

