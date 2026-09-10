import type { CityKey } from './settings';

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

  // 2. query=lat,lng or q=lat,lng
  const qMatch = /[?&](?:query|q)=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url);
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

/**
 * City Centers and Max Radii for sanity checking coordinates.
 */
const CITY_GEO_BOUNDS = {
  siem_reap: {
    centerLat: 13.3611,
    centerLng: 103.8596,
    maxRadiusKm: 25,
    // Reject water coordinates inside Lake Tonle Sap
    isWater: (lat: number, lng: number) => lat < 13.18 && lng > 103.75,
  },
  phnom_penh: {
    centerLat: 11.5564,
    centerLng: 104.9282,
    maxRadiusKm: 30,
    isWater: () => false,
  },
} as const;

/**
 * Calculates distance in km between two GPS points using Haversine formula.
 */
export function calculateDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Checks if coordinates are realistically within the residential/commercial bounds of the city
 * and not dumped into Lake Tonle Sap or distant provinces.
 */
export function isCoordinateInSanityBounds(
  lat: number,
  lng: number,
  city: CityKey,
): boolean {
  const bounds = CITY_GEO_BOUNDS[city];
  if (!bounds) return false;

  // Check water zone (e.g. Tonle Sap)
  if (bounds.isWater(lat, lng)) return false;

  // Check radius from city center
  const dist = calculateDistanceKm(bounds.centerLat, bounds.centerLng, lat, lng);
  return dist <= bounds.maxRadiusKm;
}

/**
 * Centroid GPS coordinates for Sangkats and Khans across Cambodia.
 */
export const LOCATION_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  // Siem Reap Sangkats
  'Svay Dangkum': { lat: 13.3525, lng: 103.8440 },
  'Sala Kamreuk': { lat: 13.3512, lng: 103.8645 },
  'Sla Kram': { lat: 13.3640, lng: 103.8670 },
  'Chreav': { lat: 13.3250, lng: 103.8750 },
  'Kouk Chak': { lat: 13.3850, lng: 103.8450 },
  'Nokor Thum': { lat: 13.3880, lng: 103.8820 },
  'Sambour': { lat: 13.3320, lng: 103.8200 },
  'Siem Reap': { lat: 13.3540, lng: 103.8550 },
  'Srangae': { lat: 13.3650, lng: 103.8100 },
  'Tuek Vil': { lat: 13.3700, lng: 103.8000 },
  'Krabei Riel': { lat: 13.3750, lng: 103.7700 },
  'Chong Kneas': { lat: 13.2650, lng: 103.8250 },
  'Bakong': { lat: 13.3350, lng: 103.9650 },
  'Prasat Bakong': { lat: 13.3350, lng: 103.9650 },

  // Phnom Penh Khans & Sangkats
  'BKK1': { lat: 11.5520, lng: 104.9280 },
  'BKK2': { lat: 11.5480, lng: 104.9200 },
  'BKK3': { lat: 11.5440, lng: 104.9150 },
  'Boeung Keng Kang': { lat: 11.5480, lng: 104.9210 },
  'Chamkar Mon': { lat: 11.5380, lng: 104.9250 },
  'Tonle Bassac': { lat: 11.5470, lng: 104.9330 },
  'Tuol Tompoung': { lat: 11.5350, lng: 104.9150 },
  'Toul Tompoung': { lat: 11.5350, lng: 104.9150 },
  'Toul Tom Poung': { lat: 11.5350, lng: 104.9150 },
  'Daun Penh': { lat: 11.5720, lng: 104.9250 },
  'Tuol Kork': { lat: 11.5730, lng: 104.8980 },
  'Toul Kork': { lat: 11.5730, lng: 104.8980 },
  'Chroy Changvar': { lat: 11.5950, lng: 104.9350 },
  'Sen Sok': { lat: 11.5850, lng: 104.8700 },
  'Mean Chey': { lat: 11.5150, lng: 104.9100 },
  'Meanchey': { lat: 11.5150, lng: 104.9100 },
  'Russei Keo': { lat: 11.6150, lng: 104.9050 },
  'Russey Keo': { lat: 11.6150, lng: 104.9050 },
  'Chbar Ampov': { lat: 11.5300, lng: 104.9600 },
  'Dangkao': { lat: 11.4850, lng: 104.8700 },
  'Pou Senchey': { lat: 11.5500, lng: 104.8400 },
  'Por Senchey': { lat: 11.5500, lng: 104.8400 },
  'Boeung Kak': { lat: 11.5760, lng: 104.9120 },
};

/**
 * Returns the exact centroid GPS coordinates for a Sangkat/neighborhood
 * without artificial jitter or distortion.
 */
export function getSangkatCentroid(
  location: string | null | undefined,
  city: CityKey,
): { lat: number; lng: number } {
  if (location && location.trim().length > 0) {
    const locTrimmed = location.trim();
    if (LOCATION_CENTROIDS[locTrimmed]) {
      return LOCATION_CENTROIDS[locTrimmed];
    }
    const canonical = findCanonicalLocation(locTrimmed, city);
    if (canonical && LOCATION_CENTROIDS[canonical.canonicalName]) {
      return LOCATION_CENTROIDS[canonical.canonicalName];
    }
  }

  const cityBounds = CITY_GEO_BOUNDS[city] || CITY_GEO_BOUNDS.siem_reap;
  return { lat: cityBounds.centerLat, lng: cityBounds.centerLng };
}

export function getFallbackCoordinates(
  location: string | null | undefined,
  city: CityKey,
  propertyId: number = 0,
): { lat: number; lng: number } {
  const centroid = getSangkatCentroid(location, city);
  
  if (propertyId > 0) {
    // 1 degree is ~111km. 0.003 degrees is ~330m.
    const pseudoRandom1 = Math.sin(propertyId * 12.9898) * 43758.5453;
    const pseudoRandom2 = Math.cos(propertyId * 78.233) * 43758.5453;
    
    const latOffset = (pseudoRandom1 - Math.floor(pseudoRandom1) - 0.5) * 0.006;
    const lngOffset = (pseudoRandom2 - Math.floor(pseudoRandom2) - 0.5) * 0.006;
    
    return {
      lat: centroid.lat + latOffset,
      lng: centroid.lng + lngOffset
    };
  }
  
  return centroid;
}

export interface CrossValidatedLocation {
  resolvedLocation: string;
  finalMapsUrl: string;
  isExactPin: boolean;
  trustLevel: 'pin' | 'text' | 'attribute' | 'fallback';
}

/**
 * Cross-validates 3 location sources (Pin coordinates, Text mention, Platform attribute)
 * using a 2-against-1 majority vote to reject accidental copy-pastes or defaulted dropdowns.
 */
export function crossValidateLocation(
  city: CityKey,
  options: {
    pinCoords?: { latitude: number; longitude: number } | null;
    rawMapsUrl?: string | null;
    textLocation?: string | null;
    attributeLocation?: string | null;
    hotelName?: string | null;
  },
): CrossValidatedLocation {
  const cityLabel = city === 'phnom_penh' ? 'Phnom Penh' : 'Siem Reap';

  // Hotel special case: if a verified hotel name is detected
  if (options.hotelName && options.hotelName.trim().length > 2) {
    const query = `${options.hotelName.trim()}, ${cityLabel}, Cambodia`;
    return {
      resolvedLocation: options.textLocation || options.hotelName.trim(),
      finalMapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
      isExactPin: false,
      trustLevel: 'text',
    };
  }

  // Canonical matches for Text & Attribute
  const textMatch = options.textLocation ? findCanonicalLocation(options.textLocation, city) : undefined;
  const attrMatch = options.attributeLocation ? findCanonicalLocation(options.attributeLocation, city) : undefined;

  // Sanity check coordinates if provided
  let coordsRejected = false;
  let validCoords = options.pinCoords;
  if (validCoords) {
    if (!isCoordinateInSanityBounds(validCoords.latitude, validCoords.longitude, city)) {
      validCoords = null; // Discard wild / water coordinates
      coordsRejected = true;
    }
  }

  // Case 1: Text and Attribute both agree (2 against 1 consensus)
  if (textMatch && attrMatch && textMatch.canonicalName === attrMatch.canonicalName) {
    // Both text and form attribute agree! Maximum text confidence.
    // If map URL is provided and not rejected, use it for navigation link
    if (!coordsRejected && options.rawMapsUrl) {
      return {
        resolvedLocation: textMatch.canonicalName,
        finalMapsUrl: options.rawMapsUrl,
        isExactPin: true,
        trustLevel: 'pin',
      };
    }
    return {
      resolvedLocation: textMatch.canonicalName,
      finalMapsUrl: formatGoogleMapsUrl(textMatch.canonicalName, city),
      isExactPin: false,
      trustLevel: 'text',
    };
  }

  // Case 2: Valid map URL provided and not rejected
  if (!coordsRejected && options.rawMapsUrl) {
    // If text was mentioned and valid, use text name for label, exact pin for URL
    const label = textMatch?.canonicalName || options.textLocation || attrMatch?.canonicalName || cityLabel;
    return {
      resolvedLocation: label,
      finalMapsUrl: options.rawMapsUrl,
      isExactPin: true,
      trustLevel: 'pin',
    };
  }

  // Case 3: Text mention exists
  if (textMatch) {
    return {
      resolvedLocation: textMatch.canonicalName,
      finalMapsUrl: formatGoogleMapsUrl(textMatch.canonicalName, city),
      isExactPin: false,
      trustLevel: 'text',
    };
  }

  // Case 4: Attribute fallback (Khmer24 dropdown)
  if (attrMatch) {
    return {
      resolvedLocation: attrMatch.canonicalName,
      finalMapsUrl: formatGoogleMapsUrl(attrMatch.canonicalName, city),
      isExactPin: false,
      trustLevel: 'attribute',
    };
  }

  // Case 5: Fallback to city
  return {
    resolvedLocation: cityLabel,
    finalMapsUrl: formatGoogleMapsUrl(cityLabel, city),
    isExactPin: false,
    trustLevel: 'fallback',
  };
}


