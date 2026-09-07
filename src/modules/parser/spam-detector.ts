// ─── Non-Real-Estate Spam Patterns ──────────────────────────────────────────

export const SPAM_REGEXES: RegExp[] = [
  // Vehicles / scooters / cars
  /\b(?:zoomer|scoopy|scooby|motorcycle|motorbike)\b/i,
  /មានកាតគ្រី/, // "has registration card" (vehicle title in Cambodia)
  /\b(?:prius|lexus rx|camry|highlander|corolla|tundra|tacoma|starex|alphard)\b/i,

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

