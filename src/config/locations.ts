import { CityKey } from './settings';

export interface LocationEntry {
  canonicalName: string;
  khmerName: string;
  city: CityKey;
  administrativeType: 'sangkat' | 'khan' | 'district';
  aliases: string[];
  googleMapsPlaceQuery: string;
}

export const CAMBODIA_LOCATIONS: LocationEntry[] = [
  // ─── Siem Reap Sangkats & Districts ──────────────────────────────────────────
  {
    canonicalName: 'Svay Dangkum',
    khmerName: 'ស្វាយដង្គុំ',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['svay dangkum', 'svay dang kum', 'svaydangkum'],
    googleMapsPlaceQuery: 'Sangkat Svay Dangkum, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Sala Kamreuk',
    khmerName: 'សាលាកំរើក',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['sala kamreuk', 'sala kamreak', 'salakamreuk', 'wat damnak'],
    googleMapsPlaceQuery: 'Sangkat Sala Kamreuk, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Sla Kram',
    khmerName: 'ស្លក្រាម',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['sla kram', 'slor kram', 'slakram', 'wat bo'],
    googleMapsPlaceQuery: 'Sangkat Sla Kram, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Chreav',
    khmerName: 'ជ្រាវ',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['chreav', 'chraev', 'chrav'],
    googleMapsPlaceQuery: 'Sangkat Chreav, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Kouk Chak',
    khmerName: 'គោកចក',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['kouk chak', 'kok chak', 'koukchak'],
    googleMapsPlaceQuery: 'Sangkat Kouk Chak, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Nokor Thum',
    khmerName: 'នគរធំ',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['nokor thum', 'nokor thom', 'nokorthum', 'angkor kyung yu'],
    googleMapsPlaceQuery: 'Sangkat Nokor Thum, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Sambour',
    khmerName: 'សំបួរ',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['sambour', 'sambuor', 'sambor'],
    googleMapsPlaceQuery: 'Sangkat Sambour, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Siem Reap',
    khmerName: 'សៀមរាប',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['sangkat siem reap', 'siem reap thmey', 'phsar kraom', 'phsar leu'],
    googleMapsPlaceQuery: 'Sangkat Siem Reap, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Srangae',
    khmerName: 'ស្រង៉ែ',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['srangae', 'srange', 'srongae'],
    googleMapsPlaceQuery: 'Sangkat Srangae, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Tuek Vil',
    khmerName: 'ទឹកវិល',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['tuek vil', 'teuk vil', 'tuk vil', 'airport road'],
    googleMapsPlaceQuery: 'Sangkat Tuek Vil, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Krabei Riel',
    khmerName: 'ក្របីរៀល',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['krabei riel', 'krabei reel', 'krabeiriel'],
    googleMapsPlaceQuery: 'Sangkat Krabei Riel, Krong Siem Reap, Cambodia',
  },
  {
    canonicalName: 'Chong Kneas',
    khmerName: 'ចុងឃ្នៀស',
    city: 'siem_reap',
    administrativeType: 'sangkat',
    aliases: ['chong kneas', 'chong knies', 'tonle sap port'],
    googleMapsPlaceQuery: 'Sangkat Chong Kneas, Krong Siem Reap, Cambodia',
  },
  {
    // Bakong District (Prasat Bakong): Critical fix so it never points to the ancient temple ruin
    canonicalName: 'Bakong',
    khmerName: 'ប្រាសាទបាគង',
    city: 'siem_reap',
    administrativeType: 'district',
    aliases: ['bakong', 'prasat bakong', 'bakong district', 'roluos'],
    googleMapsPlaceQuery: 'Prasat Bakong District, Siem Reap, Cambodia',
  },

  // ─── Phnom Penh Khans & Major Sangkats ─────────────────────────────────────
  {
    canonicalName: 'BKK1',
    khmerName: 'បឹងកេងកង១',
    city: 'phnom_penh',
    administrativeType: 'sangkat',
    aliases: ['bkk1', 'bkk 1', 'boeung keng kang 1', 'boeng keng kang 1', 'boeng keng kang ti muoy'],
    googleMapsPlaceQuery: 'Sangkat Boeng Keng Kang Ti Muoy, Khan Boeng Keng Kang, Phnom Penh',
  },
  {
    canonicalName: 'BKK2',
    khmerName: 'បឹងកេងកង២',
    city: 'phnom_penh',
    administrativeType: 'sangkat',
    aliases: ['bkk2', 'bkk 2', 'boeung keng kang 2', 'boeng keng kang 2', 'boeng keng kang ti pir'],
    googleMapsPlaceQuery: 'Sangkat Boeng Keng Kang Ti Pir, Khan Boeng Keng Kang, Phnom Penh',
  },
  {
    canonicalName: 'BKK3',
    khmerName: 'បឹងកេងកង៣',
    city: 'phnom_penh',
    administrativeType: 'sangkat',
    aliases: ['bkk3', 'bkk 3', 'boeung keng kang 3', 'boeng keng kang 3', 'boeng keng kang ti bei'],
    googleMapsPlaceQuery: 'Sangkat Boeng Keng Kang Ti Bei, Khan Boeng Keng Kang, Phnom Penh',
  },
  {
    canonicalName: 'Boeung Keng Kang',
    khmerName: 'បឹងកេងកង',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['bkk', 'boeung keng kang', 'boeng keng kang'],
    googleMapsPlaceQuery: 'Khan Boeng Keng Kang, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Chamkar Mon',
    khmerName: 'ចំការមន',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['chamkar mon', 'chamkarmon', 'chamkarmorn'],
    googleMapsPlaceQuery: 'Khan Chamkar Mon, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Tonle Bassac',
    khmerName: 'ទន្លេបាសាក់',
    city: 'phnom_penh',
    administrativeType: 'sangkat',
    aliases: ['tonle bassac', 'tonle basac', 'koh pich', 'diamond island'],
    googleMapsPlaceQuery: 'Sangkat Tonle Bassac, Khan Chamkar Mon, Phnom Penh',
  },
  {
    canonicalName: 'Tuol Tompoung',
    khmerName: 'ទួលទំពូង',
    city: 'phnom_penh',
    administrativeType: 'sangkat',
    aliases: ['tuol tompoung', 'toul tompoung', 'toul tom poung', 'ttp', 'russian market'],
    googleMapsPlaceQuery: 'Sangkat Tuol Tompoung, Khan Chamkar Mon, Phnom Penh',
  },
  {
    canonicalName: 'Daun Penh',
    khmerName: 'ដូនពេញ',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['daun penh', 'doun penh', 'riverside', 'phsar kandal', 'chey chumneah'],
    googleMapsPlaceQuery: 'Khan Daun Penh, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Tuol Kork',
    khmerName: 'ទួលគោក',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['tuol kork', 'toul kork', 'tuol kouk', 'tk'],
    googleMapsPlaceQuery: 'Khan Tuol Kouk, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Chroy Changvar',
    khmerName: 'ជ្រោយចង្វារ',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['chroy changvar', 'chroy changva', 'ocic'],
    googleMapsPlaceQuery: 'Khan Chroy Changvar, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Sen Sok',
    khmerName: 'សែនសុខ',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['sen sok', 'sensok', 'phnom penh thmey', 'aeon 2'],
    googleMapsPlaceQuery: 'Khan Sen Sok, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Mean Chey',
    khmerName: 'មានជ័យ',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['mean chey', 'meanchey', 'steung meanchey', 'chak angre'],
    googleMapsPlaceQuery: 'Khan Mean Chey, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Russei Keo',
    khmerName: 'ឫស្សីកែវ',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['russei keo', 'russey keo', 'ruessei kaev', 'km 6'],
    googleMapsPlaceQuery: 'Khan Ruessei Kaev, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Chbar Ampov',
    khmerName: 'ច្បារអំពៅ',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['chbar ampov', 'chbar ampov', 'nirouth', 'peng huoth boeung snor'],
    googleMapsPlaceQuery: 'Khan Chbar Ampov, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Dangkao',
    khmerName: 'ដង្កោ',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['dangkao', 'dangkor'],
    googleMapsPlaceQuery: 'Khan Dangkao, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Pou Senchey',
    khmerName: 'ពោធិ៍សែនជ័យ',
    city: 'phnom_penh',
    administrativeType: 'khan',
    aliases: ['pou senchey', 'por sen chey', 'porsenchey', 'phnom penh airport'],
    googleMapsPlaceQuery: 'Khan Pou Senchey, Phnom Penh, Cambodia',
  },
  {
    canonicalName: 'Boeung Kak',
    khmerName: 'បឹងកក់',
    city: 'phnom_penh',
    administrativeType: 'sangkat',
    aliases: ['boeung kak', 'boeng kak', 'edc'],
    googleMapsPlaceQuery: 'Sangkat Boeng Kak, Khan Tuol Kouk, Phnom Penh',
  },
];

/**
 * Normalizes location string for fast fuzzy-matching.
 */
function normalizeLoc(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds matching canonical location entry by string (English alias or Khmer name).
 */
export function findCanonicalLocation(
  query: string,
  city?: CityKey,
): LocationEntry | undefined {
  if (!query || !query.trim()) return undefined;
  const raw = query.trim();
  const norm = normalizeLoc(raw);

  // 1. Direct match on Khmer name
  for (const entry of CAMBODIA_LOCATIONS) {
    if (city && entry.city !== city) continue;
    if (raw.includes(entry.khmerName)) {
      return entry;
    }
  }

  // 2. Exact match on canonical or aliases
  for (const entry of CAMBODIA_LOCATIONS) {
    if (city && entry.city !== city) continue;
    if (norm === normalizeLoc(entry.canonicalName)) return entry;
    for (const alias of entry.aliases) {
      if (norm === normalizeLoc(alias)) return entry;
    }
  }

  // 3. Substring match (e.g. "Bakong, Siem Reap" -> "Bakong")
  for (const entry of CAMBODIA_LOCATIONS) {
    if (city && entry.city !== city) continue;
    const normCan = normalizeLoc(entry.canonicalName);
    if (norm.includes(normCan)) return entry;
    for (const alias of entry.aliases) {
      const normAlias = normalizeLoc(alias);
      if (normAlias.length >= 4 && norm.includes(normAlias)) return entry;
    }
  }

  return undefined;
}

/**
 * Builds an official Google Maps Place search URL that renders the administrative boundary
 * of the Sangkat/District/Khan instead of matching landmarks, temples, or businesses.
 */
export function formatGoogleMapsUrl(
  location: string | null | undefined,
  city: CityKey | string,
  existingMapsUrl?: string | null,
): string {
  // If property already has an exact GPS or maps URL, use it directly
  if (existingMapsUrl && existingMapsUrl.trim().length > 0) {
    return existingMapsUrl.trim();
  }

  const cityKey: CityKey = city === 'phnom_penh' ? 'phnom_penh' : 'siem_reap';
  const cityLabel = cityKey === 'phnom_penh' ? 'Phnom Penh' : 'Siem Reap';

  if (!location || !location.trim()) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${cityLabel}, Cambodia`)}`;
  }

  const loc = location.trim();
  const lower = loc.toLowerCase();

  // If location is just city name
  if (lower === 'siem reap' || lower === 'phnom penh' || lower === cityKey) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${cityLabel}, Cambodia`)}`;
  }

  // Look up in canonical dictionary
  const matched = findCanonicalLocation(loc, cityKey);
  if (matched) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(matched.googleMapsPlaceQuery)}`;
  }

  // Smart fallback: if in Siem Reap and doesn't mention "Sangkat" or "District", prepend "Sangkat"
  if (cityKey === 'siem_reap') {
    const query = lower.includes('sangkat') || lower.includes('district')
      ? `${loc}, Krong Siem Reap, Cambodia`
      : `Sangkat ${loc}, Krong Siem Reap, Cambodia`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  // Smart fallback for Phnom Penh
  const query = lower.includes('khan') || lower.includes('sangkat')
    ? `${loc}, Phnom Penh, Cambodia`
    : `Khan ${loc}, Phnom Penh, Cambodia`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Extracts latitude and longitude from a Google Maps URL if present.
 * Supports patterns:
 * - /@13.354123,103.861234
 * - ?q=13.354123,103.861234
 * - ?ll=13.354123,103.861234
 * - !3d13.354123!4d103.861234
 */
export function extractCoordinatesFromMapsUrl(
  url: string,
): { latitude: number; longitude: number } | null {
  if (!url) return null;

  // 1. @lat,lng
  const atMatch = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url);
  if (atMatch) {
    const lat = parseFloat(atMatch[1]);
    const lng = parseFloat(atMatch[2]);
    if (!isNaN(lat) && !isNaN(lng)) return { latitude: lat, longitude: lng };
  }

  // 2. q=lat,lng
  const qMatch = /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url);
  if (qMatch) {
    const lat = parseFloat(qMatch[1]);
    const lng = parseFloat(qMatch[2]);
    if (!isNaN(lat) && !isNaN(lng)) return { latitude: lat, longitude: lng };
  }

  // 3. ll=lat,lng
  const llMatch = /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url);
  if (llMatch) {
    const lat = parseFloat(llMatch[1]);
    const lng = parseFloat(llMatch[2]);
    if (!isNaN(lat) && !isNaN(lng)) return { latitude: lat, longitude: lng };
  }

  // 4. Protobuf !3dlat!4dlng
  const protoMatch = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(url);
  if (protoMatch) {
    const lat = parseFloat(protoMatch[1]);
    const lng = parseFloat(protoMatch[2]);
    if (!isNaN(lat) && !isNaN(lng)) return { latitude: lat, longitude: lng };
  }

  return null;
}

/**
 * Resolves short Google Maps URLs (maps.app.goo.gl or goo.gl/maps) by following HTTP redirects,
 * extracting canonical URL and coordinates if available.
 */
export async function resolveGoogleMapsShortlink(
  shortUrl: string,
  timeoutMs = 4000,
): Promise<{ resolvedUrl: string; coordinates: { latitude: number; longitude: number } | null }> {
  if (!shortUrl) return { resolvedUrl: shortUrl, coordinates: null };

  // Only attempt network resolution for known shortlink patterns
  if (!/(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(shortUrl)) {
    return {
      resolvedUrl: shortUrl,
      coordinates: extractCoordinatesFromMapsUrl(shortUrl),
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(shortUrl, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timeoutId);

    const resolvedUrl = response.url || shortUrl;
    const coords = extractCoordinatesFromMapsUrl(resolvedUrl);
    return { resolvedUrl, coordinates: coords };
  } catch {
    // If HEAD fails or timeouts, fallback to original
    return {
      resolvedUrl: shortUrl,
      coordinates: extractCoordinatesFromMapsUrl(shortUrl),
    };
  }
}

