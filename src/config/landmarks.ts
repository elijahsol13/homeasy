import type { CityKey } from './settings';

export interface LandmarkEntry {
  id: string;
  canonicalName: string;
  khmerName: string;
  city: CityKey;
  aliases: string[];
  gmapsLink: string;
}

export const CAMBODIA_LANDMARKS: LandmarkEntry[] = [
  // ─── Siem Reap Landmarks ───────────────────────────────────────────────────
  {
    id: 'pub_street',
    canonicalName: 'Pub Street / Old Market',
    khmerName: 'ផ្លូវផាប់ស្ទ្រីត / ផ្សារចាស់',
    city: 'siem_reap',
    aliases: [
      'pub street',
      'street 8',
      'паб стрит',
      'пабстрит',
      'old market',
      'phsar chas',
      'psar chas',
      'старый рынок',
      'night market',
      'ផ្សារចាស់',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Street+08,+Krong+Siem+Reap',
  },
  {
    id: 'nr6',
    canonicalName: 'National Road 6',
    khmerName: 'ផ្លូវជាតិលេខ ៦',
    city: 'siem_reap',
    aliases: [
      'national road 6',
      'nr6',
      'road 6',
      'трасса 6',
      'route 6',
      'национальная дорога 6',
      'highway 6',
      'ផ្លូវជាតិលេខ ៦',
      'ផ្លូវជាតិលេខ៦',
    ],
    gmapsLink: 'https://www.google.com/maps/place/National+Road+6,+Krong+Siem+Reap',
  },
  {
    id: 'road60',
    canonicalName: 'Road 60 (Sokha Road)',
    khmerName: 'ផ្លូវ៦០ម៉ែត្រ',
    city: 'siem_reap',
    aliases: [
      'road 60',
      'route 60',
      'трасса 60',
      'дорога 60',
      '60m road',
      'sokha road',
      'road 60m',
      'ផ្លូវ៦០ម៉ែត្រ',
      'ផ្លូវ ៦០ ម៉ែត្រ',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Road+60,+Krong+Siem+Reap',
  },
  {
    id: 'apsara_road',
    canonicalName: 'Apsara Road (Charles de Gaulle)',
    khmerName: 'ផ្លូវអប្សរា',
    city: 'siem_reap',
    aliases: [
      'apsara road',
      'apsara rd',
      'апсара роуд',
      'апсара роад',
      'апсара',
      'charles de gaulle',
      'charles degaulle',
      'charles de gaul',
      'ផ្លូវអប្សរា',
      'ផ្លូវឆាលដឺហ្គោល',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Charles+De+Gaulle,+Krong+Siem+Reap',
  },
  {
    id: 'phsar_leu',
    canonicalName: 'Phsar Leu Market',
    khmerName: 'ផ្សារលើធំថ្មី',
    city: 'siem_reap',
    aliases: [
      'phsar leu',
      'psar leu',
      'пса лы',
      'псар лы',
      'phsar leu thom thmey',
      'upper market',
      'ផ្សារលើ',
      'ផ្សារលើធំថ្មី',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Phsar+Leu+Thom+Thmey,+Siem+Reap',
  },
  {
    id: 'wat_bo',
    canonicalName: 'Wat Bo Temple Area',
    khmerName: 'វត្តបូព៌',
    city: 'siem_reap',
    aliases: [
      'wat bo',
      'ват бо',
      'wat d\'bo',
      'wat bo road',
      'វត្តបូព៌',
      'វត្តបូ',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Wat+Bo+Temple,+Siem+Reap',
  },
  {
    id: 'wat_damnak',
    canonicalName: 'Wat Damnak Area',
    khmerName: 'វត្តដំណាក់',
    city: 'siem_reap',
    aliases: [
      'wat damnak',
      'ват дамнак',
      'wat dam nak',
      'វត្តដំណាក់',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Wat+Damnak,+Siem+Reap',
  },
  {
    id: 'angkor_market',
    canonicalName: 'Angkor Market',
    khmerName: 'ផ្សារអង្គរ',
    city: 'siem_reap',
    aliases: [
      'angkor market',
      'анкор маркет',
      'supermarket angkor',
      'ផ្សារអង្គរ',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Angkor+Market,+Krong+Siem+Reap',
  },
  {
    id: 'heritage_walk',
    canonicalName: 'The Heritage Walk',
    khmerName: 'ដឹ ហេរីថេច វ៉ក',
    city: 'siem_reap',
    aliases: [
      'heritage walk',
      'the heritage walk',
      'херитаж волк',
      'херитэдж',
      'heritage mall',
    ],
    gmapsLink: 'https://www.google.com/maps/place/The+Heritage+Walk,+Siem+Reap',
  },
  {
    id: 'ring_road',
    canonicalName: 'Ring Road (Siem Reap)',
    khmerName: 'ផ្លូវខ្សែក្រវាត់',
    city: 'siem_reap',
    aliases: [
      'ring road',
      'ring rd',
      'объездная',
      'кольцевая',
      'ringroad',
      'outer ring road',
      'ផ្លូវខ្សែក្រវាត់',
    ],
    gmapsLink: 'https://www.google.com/maps/search/Ring+Road,+Siem+Reap',
  },
  {
    id: 'makro_sr',
    canonicalName: 'Makro Market Siem Reap',
    khmerName: 'ផ្សារម៉ាក្រូ សៀមរាប',
    city: 'siem_reap',
    aliases: [
      'makro',
      'макро',
      'macro',
      'makro siem reap',
      'ផ្សារម៉ាក្រូ',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Makro+Siem+Reap',
  },

  // ─── Phnom Penh Landmarks ──────────────────────────────────────────────────
  {
    id: 'central_market',
    canonicalName: 'Central Market (Phsar Thmey)',
    khmerName: 'ផ្សារធំថ្មី',
    city: 'phnom_penh',
    aliases: [
      'central market',
      'phsar thmey',
      'psar thmey',
      'центральный рынок',
      'псар тмей',
      'ផ្សារធំថ្មី',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Central+Market,+Phnom+Penh',
  },
  {
    id: 'russian_market',
    canonicalName: 'Russian Market (Toul Tom Poung)',
    khmerName: 'ផ្សារទួលទំពូង',
    city: 'phnom_penh',
    aliases: [
      'russian market',
      'русский рынок',
      'ttp',
      'toul tom poung',
      'tuol tompung',
      'psar toul tom poung',
      'ផ្សារទួលទំពូង',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Russian+Market,+Phnom+Penh',
  },
  {
    id: 'aeon_1',
    canonicalName: 'Aeon Mall 1 (Tonle Bassac)',
    khmerName: 'ផ្សារទំនើប អ៊ីអន ម៉ល ១',
    city: 'phnom_penh',
    aliases: [
      'aeon 1',
      'aeon mall tonle bassac',
      'аеон 1',
      'ион молл',
      'aeon phnom penh',
      'aeon mall 1',
      'ផ្សារទំនើប អ៊ីអន',
    ],
    gmapsLink: 'https://www.google.com/maps/place/AEON+Mall+Phnom+Penh',
  },
  {
    id: 'riverside_pp',
    canonicalName: 'Riverside (Sisowath Quay)',
    khmerName: 'មាត់ទន្លេ',
    city: 'phnom_penh',
    aliases: [
      'riverside',
      'sisowath quay',
      'набережная',
      'риверсайд',
      'quay',
      'មាត់ទន្លេ',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Sisowath+Quay,+Phnom+Penh',
  },
  {
    id: 'olympic_stadium',
    canonicalName: 'Olympic Stadium',
    khmerName: 'ពហុកីឡដ្ឋានជាតិអូឡាំពិក',
    city: 'phnom_penh',
    aliases: [
      'olympic stadium',
      'олимпийский стадион',
      'stade olympique',
      'olympic market',
      'ពហុកីឡដ្ឋានជាតិអូឡាំពិក',
    ],
    gmapsLink: 'https://www.google.com/maps/place/National+Olympic+Stadium,+Phnom+Penh',
  },
  {
    id: 'hun_sen_blvd',
    canonicalName: 'Hun Sen Boulevard',
    khmerName: 'មហាវិថី សម្តេច ហ៊ុន សែន',
    city: 'phnom_penh',
    aliases: [
      'hun sen blvd',
      'hun sen boulevard',
      '60m road phnom penh',
      'трасса хун сен',
      'улица 60 метров',
      'មហាវិថី សម្តេច ហ៊ុន សែន',
    ],
    gmapsLink: 'https://www.google.com/maps/place/Hun+Sen+Blvd,+Phnom+Penh',
  },
  
  // ─── Sihanoukville Landmarks ───────────────────────────────────────────────
  {
    id: 'otres_beach',
    canonicalName: 'Otres Beach',
    khmerName: 'ឆ្នេរអូរត្រេះ',
    city: 'sihanoukville',
    aliases: ['otres beach', 'otres', 'отрес'],
    gmapsLink: 'https://www.google.com/maps/place/Otres+Beach',
  },
  {
    id: 'serendipity_beach',
    canonicalName: 'Serendipity Beach',
    khmerName: 'ឆ្នេរសេរីភាព',
    city: 'sihanoukville',
    aliases: ['serendipity beach', 'serendipity'],
    gmapsLink: 'https://www.google.com/maps/place/Serendipity+Beach',
  },
  {
    id: 'sihanoukville_autonomous_port',
    canonicalName: 'Sihanoukville Port',
    khmerName: 'កំពង់ផែស្វយ័តក្រុងព្រះសីហនុ',
    city: 'sihanoukville',
    aliases: ['autonomous port', 'sihanoukville port', 'sihanoukville autonomous port'],
    gmapsLink: 'https://www.google.com/maps/place/Sihanoukville+Autonomous+Port',
  },
  {
    id: 'independence_beach',
    canonicalName: 'Independence Beach',
    khmerName: 'ឆ្នេរឯករាជ្យ',
    city: 'sihanoukville',
    aliases: ['independence beach', 'independence'],
    gmapsLink: 'https://www.google.com/maps/place/Independence+Beach',
  },
];

/**
 * Normalizes text for matching landmarks.
 */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds all known landmarks mentioned in the given text for a city.
 */
export function findLandmarksInText(text: string, city: CityKey): LandmarkEntry[] {
  if (!text || !text.trim()) return [];
  const raw = text;
  const norm = normalizeText(raw);
  const matched: LandmarkEntry[] = [];
  const seenIds = new Set<string>();

  for (const entry of CAMBODIA_LANDMARKS) {
    if (entry.city !== city) continue;
    if (seenIds.has(entry.id)) continue;

    // Check Khmer script match
    if (raw.includes(entry.khmerName)) {
      matched.push(entry);
      seenIds.add(entry.id);
      continue;
    }

    // Check aliases
    for (const alias of entry.aliases) {
      const normAlias = normalizeText(alias);
      if (normAlias.length < 3) continue;

      // Word boundary match
      const escaped = normAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(norm)) {
        matched.push(entry);
        seenIds.add(entry.id);
        break;
      }
    }
  }

  return matched;
}
