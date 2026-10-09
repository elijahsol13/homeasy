import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CanonicalListingRepository } from '../src/database/repositories/canonical-listing.repo';
import type { PropertyFilterOptions } from '../src/database/repositories/properties.repo';

const db = new DatabaseSync(process.env.PHASE6A4_DB ?? 'data/backups/homeasy_phase6a4_precanary_20261007.db', { readOnly: true });
const queries: Array<{ name: string; options: PropertyFilterOptions }> = [
  { name: 'broad_siem_reap', options: { city: 'siem_reap', type: 'rent', limit: 20 } },
  { name: 'apartment', options: { city: 'siem_reap', type: 'rent', category: 'apartment', limit: 20 } },
  { name: 'house', options: { city: 'siem_reap', type: 'rent', category: 'house', limit: 20 } },
  { name: 'one_bedroom', options: { city: 'siem_reap', type: 'rent', bedrooms: [1], limit: 20 } },
  { name: 'two_bedrooms', options: { city: 'siem_reap', type: 'rent', bedrooms: [2], limit: 20 } },
  { name: 'up_to_300', options: { city: 'siem_reap', type: 'rent', maxPrice: 30000, limit: 20 } },
  { name: '300_to_500', options: { city: 'siem_reap', type: 'rent', minPrice: 30000, maxPrice: 50000, limit: 20 } },
  { name: 'wat_bo', options: { city: 'siem_reap', type: 'rent', locations: ['Wat Bo'], limit: 20 } },
  { name: 'sala_kamreuk', options: { city: 'siem_reap', type: 'rent', locations: ['Sala Kamreuk'], limit: 20 } },
  { name: 'svay_dangkum', options: { city: 'siem_reap', type: 'rent', locations: ['Svay Dangkum'], limit: 20 } },
];
try {
  const repo = new CanonicalListingRepository(db);
  const report = queries.map(({ name, options }) => {
    const result = repo.searchProperties(options);
    return {
      name, total: result.total, diagnostics: repo.lastDiagnostics,
      top20: result.items.map((item) => ({
        publicRef: item.public_listing_ref ?? null, title: item.title, location: item.location,
        priceUsd: item.price > 0 ? Math.round(item.price / 100) : null,
        bedrooms: item.bedrooms, type: item.type, category: item.category,
        matchTier: item.match_tier ?? 'UNKNOWN', cityTier: item.city_tier ?? 'UNKNOWN_CITY',
        cityEvidence: item.city_evidence ?? null,
      })),
    };
  });
  const out = 'reports/phase6a4-ranking-audit-20261007.json';
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), queries: report }, null, 2) + '\n');
  console.log(JSON.stringify({ out, queries: report.map(({ name, total, diagnostics, top20 }) => ({ name, total, count: top20.length, diagnostics })) }, null, 2));
} finally {
  db.close();
}
