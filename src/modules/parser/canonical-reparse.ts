import type { DatabaseSync } from 'node:sqlite';
import { extractCanonicalListingsBatch } from './canonical-listing-extractor';
import { geographyStatus } from './listing-extraction';
import { toLegacyListingExtraction } from './canonical-listing-adapter';

interface ReparseRow {
  id: number;
  title: string;
  description: string;
  raw_text: string | null;
}

/** Re-extract stored text without fetching source pages or silently deactivating listings. */
export async function reparseCanonicalListings(
  db: DatabaseSync,
  options: { limit?: number; apply?: boolean } = {},
): Promise<{ extracted: number; updated: number; needsReview: number }> {
  const limit = Number.isInteger(options.limit) && options.limit! > 0 ? options.limit! : 50;
  const rows = db.prepare(
    `SELECT id, title, description, raw_text FROM properties
     WHERE city = 'siem_reap' AND COALESCE(raw_text, description, '') <> '' ORDER BY id DESC LIMIT ?`,
  ).all(limit) as unknown as ReparseRow[];
  const result = { extracted: 0, updated: 0, needsReview: 0 };

  for (let i = 0; i < rows.length; i += 3) {
    const chunk = rows.slice(i, i + 3);
    const factsById = await extractCanonicalListingsBatch(chunk.map((row) => ({
      id: row.id,
      text: `${row.title}\n\n${row.raw_text || row.description}`,
    })));
    for (const row of chunk) {
      const facts = factsById.get(row.id);
      if (!facts) continue;
      result.extracted++;
      const inScope = facts.is_supported_listing === true && geographyStatus(facts.city) !== 'out_of_area';
      if (!inScope) result.needsReview++;
      if (!options.apply) continue;

      // Preserve existing public fields on an uncertain/rejected result. The stored
      // facts can be reviewed separately; a rental never becomes a fake "sale".
      if (!inScope) {
        db.prepare(`UPDATE properties SET listing_facts_json = ? WHERE id = ?`)
          .run(JSON.stringify(facts), row.id);
        result.updated++;
        continue;
      }

      const legacy = toLegacyListingExtraction(facts);
      const priceCents = facts.price !== null && facts.currency
        ? Math.round((facts.currency === 'KHR' ? facts.price / 4000 : facts.price) * 100)
        : null;
      db.prepare(`UPDATE properties SET
        listing_facts_json = ?,
        title = COALESCE(NULLIF(?, ''), title),
        description = COALESCE(NULLIF(?, ''), description),
        price = COALESCE(?, price),
        category = COALESCE(?, category),
        property_type = COALESCE(?, property_type),
        bedrooms = COALESCE(?, bedrooms),
        bathrooms = COALESCE(?, bathrooms),
        min_lease = COALESCE(?, min_lease),
        electricity = COALESCE(?, electricity),
        water = COALESCE(?, water),
        cleaning = COALESCE(?, cleaning),
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`).run(
        JSON.stringify(facts), legacy.title_en, legacy.description_en,
        priceCents, legacy.category, legacy.property_type ?? null, legacy.bedrooms,
        legacy.bathrooms, legacy.min_lease, legacy.electricity ?? null, legacy.water ?? null,
        legacy.cleaning ?? null, row.id,
      );
      result.updated++;
    }
  }
  return result;
}
