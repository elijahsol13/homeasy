// ─── Rate Limiting ────────────────────────────────────────────────────────────

export const RATE_LIMIT = {
  /** Minimum ms between messages to the same user (1 msg/sec) */
  PER_USER_INTERVAL_MS: 1_000,
  /** Queue processing tick interval */
  QUEUE_TICK_MS: 500,
} as const;

// ─── Cambodia Geography ───────────────────────────────────────────────────────

export const CITIES = {
  siem_reap: 'Siem Reap',
  phnom_penh: 'Phnom Penh',
} as const;

export type CityKey = keyof typeof CITIES;

export const DISTRICTS: Record<CityKey, readonly string[]> = {
  siem_reap: [
    'Svay Dangkum',
    'Sala Kamreuk',
    'Slor Kram',
    'Chreav',
    'Nokor Thum',
    'Sambuor',
    'Krang',
    'Siem Reap Thmey',
  ],
  phnom_penh: [
    'BKK1 (Boeung Keng Kang 1)',
    'BKK2 (Boeung Keng Kang 2)',
    'BKK3 (Boeung Keng Kang 3)',
    'Daun Penh',
    'Chamkarmon',
    'Tuol Kork',
    'Toul Tompoung',
    'Chroy Changva',
    'Sen Sok',
    'Mean Chey',
    'Russey Keo',
    'Dangkao',
    'Por Sen Chey',
    'Chbar Ampov',
  ],
};

// ─── Property Categories ──────────────────────────────────────────────────────

export const CATEGORY_OPTIONS = [
  { label: '🏢 Any Category', value: null },
  { label: '🏬 Apartment / Condo', value: 'apartment' as const },
  { label: '🏡 House / Villa', value: 'house' as const },
  { label: '🛏️ Room / Studio', value: 'room' as const },
] as const;

export type PropertyCategory = 'apartment' | 'house' | 'room';

// ─── Pool Options ─────────────────────────────────────────────────────────────

export const POOL_OPTIONS = [
  { label: '🏊 Pool Required', value: true },
  { label: "🤷 Doesn't Matter", value: false },
] as const;

// ─── Lease Term Options ───────────────────────────────────────────────────────

export const LEASE_OPTIONS = [
  { label: '⏱️ Any Lease Term', value: null, description: 'Any contract length' },
  { label: '📅 Short-term (1–5 mos)', value: 5, description: 'Up to 5 months' },
  { label: '📆 Long-term (6+ mos)', value: 6, description: '6+ months' },
] as const;

// ─── Budget Ranges (USD) ──────────────────────────────────────────────────────

export const BUDGET_RANGES = [
  { label: 'Under $200', min: 0, max: 200 },
  { label: '$200 – $400', min: 200, max: 400 },
  { label: '$400 – $700', min: 400, max: 700 },
  { label: '$700 – $1,200', min: 700, max: 1_200 },
  { label: '$1,200 – $2,000', min: 1_200, max: 2_000 },
  { label: 'Over $2,000', min: 2_000, max: null },
] as const;

export type BudgetRange = (typeof BUDGET_RANGES)[number];

// ─── Bedroom Options ──────────────────────────────────────────────────────────

export const BEDROOM_OPTIONS = [
  { label: 'Any 🛏', value: null },
  { label: 'Studio', value: 0 },
  { label: '1 BR', value: 1 },
  { label: '2 BR', value: 2 },
  { label: '3 BR', value: 3 },
  { label: '4+ BR', value: 4 },
] as const;

export type BedroomOption = (typeof BEDROOM_OPTIONS)[number];

// ─── Currency ─────────────────────────────────────────────────────────────────

/** Approximate KHR → USD rate. Update periodically. */
export const KHR_TO_USD_RATE = 4_100;

// ─── Deduplication Constants ──────────────────────────────────────────────────

export const PHASH_HAMMING_THRESHOLD = 5;

// ─── Misc ─────────────────────────────────────────────────────────────────────

export const MAX_FAVORITES_PER_USER = 50;
export const LISTING_DESCRIPTION_MAX_LEN = 300;

// ─── Facebook Groups Configuration ────────────────────────────────────────────

export interface FBGroupConfig {
  name: string;
  url: string;
  city: CityKey;
  defaultCategory?: PropertyCategory;
}

export const FB_GROUPS: readonly FBGroupConfig[] = [
  {
    name: 'Siem Reap Expats & Locals',
    url: 'https://www.facebook.com/groups/SiemReapExpatsLocals?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Expats and locals living in Siem Reap, Cambodia',
    url: 'https://www.facebook.com/groups/900185676717876?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Siem Reap Rent, Sell and Buy properties (សៀមរាប ជួល លក់ និងទិញ)',
    url: 'https://www.facebook.com/groups/527059360763438?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Siem Reap Real Estate (Group 1435)',
    url: 'https://www.facebook.com/groups/1435004449876640?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Cheap Rent Siem Reap',
    url: 'https://www.facebook.com/groups/cheaprentsiemreap?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Siem Reap Real Estate & Rentals (Group 1449)',
    url: 'https://www.facebook.com/groups/1449080965124368?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'SIEM REAP - Rent House, Villa, Apartment, Flat, Condo',
    url: 'https://www.facebook.com/groups/201561753758474?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Siem Reap Real Estate',
    url: 'https://www.facebook.com/groups/siemreaprealestate?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Siem Reap Brother Property Service',
    url: 'https://www.facebook.com/groups/524937017713486?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Apartments & Houses In Siem Reap for Rent or Sale',
    url: 'https://www.facebook.com/groups/templecityrealestate?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Siem Reap Real Estate S R',
    url: 'https://www.facebook.com/groups/632004323920718?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Siem Reap Real Estate Unique',
    url: 'https://www.facebook.com/groups/534172030116578?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Sell and Buy Everything in Siem Reap',
    url: 'https://www.facebook.com/groups/2033812786836267?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
  {
    name: 'Siem Reap Buy and Sell',
    url: 'https://www.facebook.com/groups/youthfitness2014?sorting_setting=CHRONOLOGICAL',
    city: 'siem_reap',
  },
] as const;
