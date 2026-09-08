import { z } from 'zod';

// ─── Raw payload (external / unvalidated input) ───────────────────────────────

/**
 * Permissive schema for raw inbound listing data.
 */
export const RawListingSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  price: z.union([z.string(), z.number()]).optional(),
  currency: z.string().optional(),
  type: z.string().optional(),
  category: z.enum(['apartment', 'house', 'room', 'hotel']).or(z.string()).optional(),
  bedrooms: z.union([z.string(), z.number()]).optional(),
  bathrooms: z.union([z.string(), z.number()]).optional(),
  deposit: z.union([z.string(), z.number()]).optional(),
  min_lease: z.union([z.string(), z.number()]).optional(),
  has_pool: z.union([z.boolean(), z.number(), z.string()]).optional(),
  location: z.string().optional(),
  city: z.string().optional(),
  maps_url: z.string().optional(),
  source_url: z.string().optional(),
  photos: z.array(z.string()).optional().default([]),
  phone: z.string().optional(),
  telegram_contact: z.string().optional(),
  url: z.string().optional(),
  posted_at: z.string().optional(),
  latitude: z.union([z.string(), z.number()]).optional(),
  longitude: z.union([z.string(), z.number()]).optional(),
  // LLM-extracted fields passed through from parseFacebookPostText
  property_type: z.string().optional(),
  electricity: z.string().optional(),
  water: z.string().optional(),
  cleaning: z.string().optional(),
  restrictions: z.array(z.string()).optional(),
  pet_friendly: z.boolean().optional(),
  amenities: z.array(z.string()).optional(),
  marketing_landmarks: z.array(z.string()).optional(),
});

export type RawListing = z.infer<typeof RawListingSchema>;

/** Accepts either a single listing or an array (for bulk import). */
export const BulkImportSchema = z.union([RawListingSchema, z.array(RawListingSchema)]);

// ─── Normalised / clean property ─────────────────────────────────────────────

export const CleanPropertySchema = z.object({
  title: z.string(),
  description: z.string(),
  price: z.number(),
  currency: z.enum(['USD', 'KHR']).default('USD'),
  type: z.enum(['rent', 'sale']),
  category: z.enum(['apartment', 'house', 'room', 'hotel']).nullable().default(null),
  property_type: z.string().nullable().default(null),
  bedrooms: z.number().nullable(),
  bathrooms: z.number().nullable(),
  deposit: z.number().nullable().default(null),
  min_lease: z.number().nullable().default(null),
  has_pool: z.boolean().default(false),
  location: z.string(),
  city: z.enum(['siem_reap', 'phnom_penh', 'sihanoukville']),
  photos: z.array(z.string()),
  direct_contact: z.object({
    phone: z.string().optional(),
    telegram: z.string().optional(),
    whatsapp: z.string().optional(),
  }),
  maps_url: z.string().nullable().default(null),
  source_url: z.string().nullable().default(null),
  original_url: z.string(),
  posted_at: z.string().nullable().default(null),
  image_phash: z.string().nullable().default(null),
  image_phashes: z.array(z.string()).default([]),
  electricity: z.string().nullable().default(null),
  water: z.string().nullable().default(null),
  cleaning: z.string().nullable().default(null),
  restrictions: z.array(z.string()).default([]),
  pet_friendly: z.boolean().default(false),
  amenities: z.array(z.string()).default([]),
  primary_landmark: z.string().nullable().default(null),
  landmarks: z.array(z.string()).default([]),
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
});

export type CleanProperty = z.infer<typeof CleanPropertySchema>;

// ─── Ingest result ────────────────────────────────────────────────────────────

export interface IngestResult {
  status: 'inserted' | 'duplicate' | 'error';
  propertyId?: number;
  duplicateOfId?: number;
  hash?: string;
  image_phash?: string | null;
  image_phashes?: string[];
  reason?: string;
  error?: string;
}

export interface BulkIngestResult {
  total: number;
  inserted: number;
  duplicates: number;
  errors: number;
  results: IngestResult[];
}
