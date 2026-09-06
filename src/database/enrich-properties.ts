/**
 * HomEasy Property Database Enrichment & Backfill Script
 *
 * Scans all existing listings in SQLite database and:
 *  1. Deactivates non-real-estate posts (scooters, taxis, jobs, delivery ads, movie clips).
 *  2. Deactivates land-only sale listings (not residential properties).
 *  3. Recovers missing bedrooms & bathrooms using Khmer and English regex patterns.
 *  4. Recovers category: 'room' bedroom default (1 BR).
 *  5. Recovers swimming pool presence from Khmer ('អាងហែលទឹក') and English terms.
 *  6. Normalizes location/sangkat from Khmer and English text when missing or generic.
 *  7. Recovers missing contacts (phone numbers, telegram handles).
 *  8. Backfills posted_at from relative post timestamps or created_at/parsed_at fallback.
 */

import { createDatabase } from './db';
import { runMigrations } from './migrate';
import { normalizePhoneNumber } from '../modules/parser/normalizer';
import { extractElectricity, extractWater } from '../modules/parser/extractor';
import { extractCleaning, extractRestrictions } from '../services/notifier';
import { findLandmarksInText } from '../config/landmarks';
import type { PropertyCategory } from '../config/settings';

export interface PropertyRecord {
  id: number;
  hash: string;
  title: string;
  description: string;
  price: number;
  currency: 'USD' | 'KHR';
  type: 'rent' | 'sale';
  category: PropertyCategory | null;
  bedrooms: number | null;
  bathrooms: number | null;
  deposit: number | null;
  min_lease: number | null;
  has_pool: number | boolean;
  location: string;
  city: 'siem_reap' | 'phnom_penh';
  maps_url: string | null;
  source_url: string | null;
  photos: string;
  image_phash: string | null;
  image_phashes: string;
  direct_contact: string;
  original_url: string;
  reports_count: number;
  is_active: number;
  parsed_at: string;
  created_at: string;
  posted_at: string | null;
  updated_at: string;
  electricity?: string | null;
  water?: string | null;
  cleaning?: string | null;
  restrictions?: string | null;
  pet_friendly?: number | boolean;
  primary_landmark?: string | null;
  landmarks?: string | null;
}

export interface EnrichmentResult {
  updated: boolean;
  deactivated: boolean;
  deactivateReason?: string;
  changes: Record<string, { oldVal: unknown; newVal: unknown }>;
  patch: Partial<PropertyRecord>;
}

export interface EnrichmentStats {
  totalScanned: number;
  deactivatedSpam: number;
  recoveredBedrooms: number;
  recoveredBathrooms: number;
  recoveredPool: number;
  recoveredLocation: number;
  recoveredCategory: number;
  recoveredPhone: number;
  recoveredTelegram: number;
  backfilledPostedAt: number;
  recoveredElectricity: number;
  recoveredWater: number;
  recoveredCleaning: number;
  recoveredPetFriendly: number;
  recoveredLandmarks: number;
  totalUpdated: number;
}

// ─── Non-Real-Estate Spam Patterns ──────────────────────────────────────────

const SPAM_REGEXES = [
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

export function isNonRealEstateSpam(title: string, description: string): { isSpam: boolean; reason?: string } {
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

// ─── Pure Enrichment Logic ───────────────────────────────────────────────────

export function enrichPropertyRecord(prop: PropertyRecord): EnrichmentResult {
  const changes: Record<string, { oldVal: unknown; newVal: unknown }> = {};
  const patch: Partial<PropertyRecord> = {};
  const text = `${prop.title} ${prop.description}`.trim();

  // 1. Check for spam / non-real-estate
  if (prop.is_active === 1) {
    const { isSpam, reason } = isNonRealEstateSpam(prop.title, prop.description);
    if (isSpam) {
      return {
        updated: true,
        deactivated: true,
        deactivateReason: reason,
        changes: { is_active: { oldVal: 1, newVal: 0 } },
        patch: { is_active: 0 },
      };
    }
  }

  // 2. Category recovery
  let category = prop.category;
  if (!category) {
    if (/\b(?:hotel\s+room|boutique\s+hotel|hotel\s+suite|hotel-style|hotel)\b/i.test(text)) {
      category = 'hotel';
    } else if (/វីឡា|ផ្ទះ|\b(?:villa|house|townhouse|borey)\b/i.test(text)) {
      category = 'house';
    } else if (/ខុនដូ|អាផាតមិន|\b(?:condo|apartment|flat|serviced apartment)\b/i.test(text)) {
      category = 'apartment';
    } else if (/បន្ទប់|\b(?:room|studio)\b/i.test(text)) {
      category = 'room';
    }
    if (category) {
      changes.category = { oldVal: prop.category, newVal: category };
      patch.category = category;
    }
  }

  // 3. Bedrooms recovery
  let bedrooms = prop.bedrooms;
  if (bedrooms === null) {
    if (category === 'room' || category === 'hotel') {
      bedrooms = 1;
    } else {
      // Khmer: e.g. "2បន្ទប់គេង", "3 បន្ទប់គេង"
      const khmerMatch = /(\d+)\s*បន្ទប់គេង/.exec(text);
      if (khmerMatch?.[1]) {
        bedrooms = parseInt(khmerMatch[1], 10);
      } else {
        // English: e.g. "2BR", "2 bedrooms", "studio"
        if (/\bstudio\b/i.test(text)) {
          bedrooms = 0;
        } else {
          const engMatch = /(\d+)\s*(?:BR|bed(?:room)?s?|BDR|BDRM)\b/i.exec(text);
          if (engMatch?.[1]) {
            bedrooms = parseInt(engMatch[1], 10);
          }
        }
      }
    }
    if (bedrooms !== null && bedrooms >= 0 && bedrooms <= 30) {
      changes.bedrooms = { oldVal: prop.bedrooms, newVal: bedrooms };
      patch.bedrooms = bedrooms;
    }
  }

  // 4. Bathrooms recovery
  let bathrooms = prop.bathrooms;
  if (bathrooms === null) {
    const khmerBath = /(\d+)\s*បន្ទប់ទឹក/.exec(text);
    if (khmerBath?.[1]) {
      bathrooms = parseInt(khmerBath[1], 10);
    } else {
      const engBath = /(\d+)\s*(?:bath(?:room)?s?|WC)\b/i.exec(text);
      if (engBath?.[1]) {
        bathrooms = parseInt(engBath[1], 10);
      }
    }
    if (bathrooms !== null && bathrooms >= 0 && bathrooms <= 30) {
      changes.bathrooms = { oldVal: prop.bathrooms, newVal: bathrooms };
      patch.bathrooms = bathrooms;
    }
  }

  // 5. Swimming Pool recovery
  const currentPool = Boolean(prop.has_pool);
  if (!currentPool) {
    const hasPoolText =
      /អាងហែលទឹក/.test(text) ||
      /\b(?:swimming pool|swimmingpool|private pool|rooftop pool|shared pool|pool access|with pool|has pool)\b/i.test(text);

    if (hasPoolText) {
      changes.has_pool = { oldVal: prop.has_pool, newVal: 1 };
      patch.has_pool = 1;
    }
  }

  // 6. Sangkat / District location recovery
  const genericLocations = ['', 'siem reap thmey', 'siem reap', 'phnom penh', 'city centre'];
  const isGenericLoc = !prop.location || genericLocations.includes(prop.location.trim().toLowerCase());

  if (isGenericLoc) {
    let resolvedLoc: string | null = null;
    // Check specific known sangkats
    if (/ស្វាយដង្គុំ|Svay Dangkum/i.test(text)) resolvedLoc = 'Svay Dangkum';
    else if (/សាលាកំរើក|Sala Kamreuk/i.test(text)) resolvedLoc = 'Sala Kamreuk';
    else if (/ស្លក្រាម|Slor Kram/i.test(text)) resolvedLoc = 'Slor Kram';
    else if (/ជ្រាវ|Chreav/i.test(text)) resolvedLoc = 'Chreav';
    else if (/វត្តបូព៌|វត្តបូ|Wat Bo/i.test(text)) resolvedLoc = 'Wat Bo';
    else if (/វត្តដំណាក់|Wat Damnak/i.test(text)) resolvedLoc = 'Wat Damnak';
    else if (/គោកចក|Kouk Chak/i.test(text)) resolvedLoc = 'Kouk Chak';
    else if (/សំបួរ|Sambuor/i.test(text)) resolvedLoc = 'Sambuor';
    else if (/បឹងកេងកង|BKK1|BKK\s*1/i.test(text)) resolvedLoc = 'BKK1';
    else if (/ទួលទំពូង|Toul Tom Poung|Russian Market/i.test(text)) resolvedLoc = 'Toul Tom Poung';
    else if (/ទន្លេបាសាក់|Tonle Bassac/i.test(text)) resolvedLoc = 'Tonle Bassac';
    else if (/ដូនពេញ|Daun Penh/i.test(text)) resolvedLoc = 'Daun Penh';
    else if (/ទួលគោក|Tuol Kouk/i.test(text)) resolvedLoc = 'Tuol Kouk';
    else if (/ជ្រោយចង្វារ|Chroy Changvar/i.test(text)) resolvedLoc = 'Chroy Changvar';
    else if (/ច្បារអំពៅ|Chbar Ampov/i.test(text)) resolvedLoc = 'Chbar Ampov';

    if (resolvedLoc && resolvedLoc !== prop.location) {
      changes.location = { oldVal: prop.location, newVal: resolvedLoc };
      patch.location = resolvedLoc;
    }
  }

  // 7. Contacts recovery
  let contacts: { phone?: string; telegram?: string } = {};
  try {
    contacts = JSON.parse(prop.direct_contact || '{}');
  } catch {
    contacts = {};
  }

  let contactsModified = false;
  if (!contacts.phone) {
    const phoneMatch = /(?:\+855|0)\s*[1-9]\d{1,2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/.exec(text);
    if (phoneMatch) {
      const cleanPhone = normalizePhoneNumber(phoneMatch[0]);
      if (cleanPhone) {
        contacts.phone = cleanPhone;
        contactsModified = true;
      }
    }
  }

  if (!contacts.telegram) {
    const tgMatch = /(?:telegram|tg)\s*(?::|is|=|at)?\s*@?([a-zA-Z0-9_]{5,32})\b/i.exec(text)
      || /@([a-zA-Z0-9_]{5,32})\b/.exec(text);
    if (tgMatch?.[1]) {
      const handle = tgMatch[1].toLowerCase();
      // Skip common non-usernames
      if (!['gmail', 'hotmail', 'yahoo', 'facebook', 'khmer24', 'channel'].includes(handle)) {
        contacts.telegram = `@${tgMatch[1]}`;
        contactsModified = true;
      }
    }
  }

  if (contactsModified) {
    const newContactJson = JSON.stringify(contacts);
    changes.direct_contact = { oldVal: prop.direct_contact, newVal: newContactJson };
    patch.direct_contact = newContactJson;
  }

  // 8. Backfill posted_at
  if (!prop.posted_at) {
    let extractedDate: string | null = null;
    // Check if text has Facebook relative timestamp: e.g. "Services Rental1 ч.", "5 мин.", "2 д."
    const relMatch = /(\d+)\s*(ч\.|д\.|мин\.|hours?|hrs?|days?|minutes?|mins?)\b/i.exec(text);
    if (relMatch?.[1] && relMatch?.[2]) {
      const amount = parseInt(relMatch[1], 10);
      const unit = relMatch[2].toLowerCase();
      const now = new Date(prop.created_at || Date.now()).getTime();
      let deltaMs = 0;
      if (unit.startsWith('мин') || unit.startsWith('min')) deltaMs = amount * 60 * 1000;
      else if (unit.startsWith('ч') || unit.startsWith('h')) deltaMs = amount * 3600 * 1000;
      else if (unit.startsWith('д') || unit.startsWith('d')) deltaMs = amount * 86400 * 1000;

      if (deltaMs > 0) {
        extractedDate = new Date(now - deltaMs).toISOString();
      }
    }

    const finalPostedAt = extractedDate || prop.created_at || prop.parsed_at || new Date().toISOString();
    changes.posted_at = { oldVal: prop.posted_at, newVal: finalPostedAt };
    patch.posted_at = finalPostedAt;
  }

  // 9. Utilities recovery (Electricity & Water & Cleaning)
  if (!prop.electricity) {
    const elec = extractElectricity(text);
    if (elec) {
      changes.electricity = { oldVal: prop.electricity, newVal: elec };
      patch.electricity = elec;
    }
  }

  if (!prop.water) {
    const water = extractWater(text);
    if (water) {
      changes.water = { oldVal: prop.water, newVal: water };
      patch.water = water;
    }
  }

  if (!prop.cleaning) {
    const cleaning = extractCleaning(text);
    if (cleaning) {
      changes.cleaning = { oldVal: prop.cleaning, newVal: cleaning };
      patch.cleaning = cleaning;
    }
  }

  // 10. Restrictions & Pet-friendly recovery
  let currentRestrictions: string[] = [];
  try {
    if (prop.restrictions) {
      currentRestrictions = JSON.parse(prop.restrictions);
    }
  } catch {
    currentRestrictions = [];
  }

  if (currentRestrictions.length === 0) {
    const restr = extractRestrictions(text);
    if (restr.length > 0) {
      const restrJson = JSON.stringify(restr);
      changes.restrictions = { oldVal: prop.restrictions, newVal: restrJson };
      patch.restrictions = restrJson;
    }
  }

  if (!prop.pet_friendly) {
    const restrictionsList = (patch.restrictions ? JSON.parse(patch.restrictions) : currentRestrictions) as string[];
    const hasPetRestriction = restrictionsList.includes('🚫 No Pets');
    if (!hasPetRestriction && /\b(?:pet friendly|pets allowed)\b/i.test(text)) {
      changes.pet_friendly = { oldVal: prop.pet_friendly, newVal: 1 };
      patch.pet_friendly = 1;
    }
  }

  // 11. Landmarks recovery
  if (!prop.primary_landmark) {
    const landmarksFound = findLandmarksInText(text, prop.city);
    if (landmarksFound.length > 0) {
      const primary = landmarksFound[0].canonicalName;
      const allLandmarksJson = JSON.stringify(landmarksFound.map((l) => l.canonicalName));
      changes.primary_landmark = { oldVal: prop.primary_landmark, newVal: primary };
      patch.primary_landmark = primary;
      patch.landmarks = allLandmarksJson;
    }
  }

  // 12. Normalize desktop web.facebook.com to www.facebook.com for mobile accessibility
  if (prop.original_url && prop.original_url.includes('web.facebook.com')) {
    const fixedUrl = prop.original_url.replace('web.facebook.com', 'www.facebook.com');
    changes.original_url = { oldVal: prop.original_url, newVal: fixedUrl };
    patch.original_url = fixedUrl;
  }
  if (prop.source_url && prop.source_url.includes('web.facebook.com')) {
    const fixedUrl = prop.source_url.replace('web.facebook.com', 'www.facebook.com');
    changes.source_url = { oldVal: prop.source_url, newVal: fixedUrl };
    patch.source_url = fixedUrl;
  }

  const updated = Object.keys(changes).length > 0;
  return { updated, deactivated: false, changes, patch };
}

// ─── Database Batch Runner ───────────────────────────────────────────────────

export function runEnrichment(customDbPath?: string): EnrichmentStats {
  const db = createDatabase(customDbPath);
  runMigrations(db);

  const stats: EnrichmentStats = {
    totalScanned: 0,
    deactivatedSpam: 0,
    recoveredBedrooms: 0,
    recoveredBathrooms: 0,
    recoveredPool: 0,
    recoveredLocation: 0,
    recoveredCategory: 0,
    recoveredPhone: 0,
    recoveredTelegram: 0,
    backfilledPostedAt: 0,
    recoveredElectricity: 0,
    recoveredWater: 0,
    recoveredCleaning: 0,
    recoveredPetFriendly: 0,
    recoveredLandmarks: 0,
    totalUpdated: 0,
  };

  const rows = db.prepare('SELECT * FROM properties').all() as unknown as PropertyRecord[];
  stats.totalScanned = rows.length;

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`🔍 HomEasy Database Enrichment & Backfill`);
  console.log(`📦 Total properties in database: ${stats.totalScanned}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  for (const prop of rows) {
    const res = enrichPropertyRecord(prop);
    if (!res.updated) continue;

    stats.totalUpdated++;

    if (res.deactivated) {
      stats.deactivatedSpam++;
      db.prepare('UPDATE properties SET is_active = 0 WHERE id = ?').run(prop.id);
      console.log(`  🚫 Deactivated spam listing #${prop.id} ("${prop.title.slice(0, 40)}..."): ${res.deactivateReason}`);
      continue;
    }

    if (res.changes.bedrooms) stats.recoveredBedrooms++;
    if (res.changes.bathrooms) stats.recoveredBathrooms++;
    if (res.changes.has_pool) stats.recoveredPool++;
    if (res.changes.location) stats.recoveredLocation++;
    if (res.changes.category) stats.recoveredCategory++;
    if (res.changes.posted_at) stats.backfilledPostedAt++;
    if (res.changes.electricity) stats.recoveredElectricity++;
    if (res.changes.water) stats.recoveredWater++;
    if (res.changes.cleaning) stats.recoveredCleaning++;
    if (res.changes.pet_friendly) stats.recoveredPetFriendly++;
    if (res.changes.primary_landmark) stats.recoveredLandmarks++;
    if (res.changes.direct_contact) {
      const oldContacts = JSON.parse(String(res.changes.direct_contact.oldVal || '{}'));
      const newContacts = JSON.parse(String(res.changes.direct_contact.newVal || '{}'));
      if (!oldContacts.phone && newContacts.phone) stats.recoveredPhone++;
      if (!oldContacts.telegram && newContacts.telegram) stats.recoveredTelegram++;
    }

    // Build dynamic SQL update statement
    const fields = Object.keys(res.patch);
    if (fields.length > 0) {
      const setClause = fields.map((f) => `${f} = ?`).join(', ');
      const values = fields.map((f) => {
        const val = (res.patch as Record<string, unknown>)[f];
        if (typeof val === 'boolean') return val ? 1 : 0;
        return (val ?? null) as string | number | null;
      });
      db.prepare(`UPDATE properties SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(...values, prop.id);
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`📊 Enrichment Summary Results:`);
  console.log(`  • Total listings scanned:       ${stats.totalScanned}`);
  console.log(`  • Total listings enriched:      ${stats.totalUpdated}`);
  console.log(`  • Spam / Non-real-estate culled:${stats.deactivatedSpam}`);
  console.log(`  • Bedrooms recovered:           ${stats.recoveredBedrooms}`);
  console.log(`  • Bathrooms recovered:          ${stats.recoveredBathrooms}`);
  console.log(`  • Swimming pool recovered:      ${stats.recoveredPool}`);
  console.log(`  • Locations/Sangkats recovered: ${stats.recoveredLocation}`);
  console.log(`  • Categories recovered:         ${stats.recoveredCategory}`);
  console.log(`  • Phones / Telegrams recovered: ${stats.recoveredPhone + stats.recoveredTelegram}`);
  console.log(`  • posted_at backfilled:         ${stats.backfilledPostedAt}`);
  console.log(`  • Electricity tariffs parsed:   ${stats.recoveredElectricity}`);
  console.log(`  • Water tariffs parsed:         ${stats.recoveredWater}`);
  console.log(`  • Cleaning services parsed:     ${stats.recoveredCleaning}`);
  console.log(`  • Pet-friendly tags recovered:  ${stats.recoveredPetFriendly}`);
  console.log(`  • Landmarks matched:            ${stats.recoveredLandmarks}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  return stats;
}

// CLI Execution
if (require.main === module) {
  runEnrichment();
}
