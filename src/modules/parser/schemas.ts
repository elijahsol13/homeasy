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
});

export type RawListing = z.infer<typeof RawListingSchema>;

/** Accepts either a single listing or an array (for bulk import). */
export const BulkImportSchema = z.union([RawListingSchema, z.array(RawListingSchema)]);

// ─── Normalised / clean property ─────────────────────────────────────────────

export const CleanPropertySchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  /** Price in USD cents */
  price: z.number().int().min(0),
  currency: z.enum(['USD', 'KHR']).default('USD'),
  type: z.enum(['rent', 'sale']),
  category: z.enum(['apartment', 'house', 'room', 'hotel']).nullable().default(null),
  bedrooms: z.number().int().min(0).nullable().default(null),
  bathrooms: z.number().int().min(0).nullable().default(null),
  deposit: z.number().int().min(0).nullable().default(null), // in USD cents
  min_lease: z.number().int().min(1).nullable().default(null), // in months
  has_pool: z.boolean().default(false),
  location: z.string().default(''),
  city: z.enum(['siem_reap', 'phnom_penh']),
  maps_url: z.string().nullable().default(null),
  source_url: z.string().nullable().default(null),
  photos: z.array(z.string()).default([]),
  image_phash: z.string().nullable().default(null),
  image_phashes: z.array(z.string()).default([]),
  direct_contact: z
    .object({
      phone: z.string().optional(),
      telegram: z.string().optional(),
    })
    .default({}),
  original_url: z.string().default(''),
  posted_at: z.string().nullable().default(null),
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
