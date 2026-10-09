import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface TrackedLink {
  id: number;
  slug: string;
  kind: 'miniapp' | 'url';
  payload: string | null;
  source: string | null;
  campaign: string | null;
  group_id: string | null;
  post_id: string | null;
  request_id: string | null;
  listing_id: number | null;
  listing_public_ref: string | null;
  agent_id: number | null;
  metadata: Record<string, unknown>;
  clicks_count: number;
  last_clicked_at: string | null;
  created_at: string;
}

export interface CreateTrackedLinkInput {
  kind?: 'miniapp' | 'url';
  /** startapp payload for miniapp links, or the destination URL for kind='url'. */
  payload?: string | null;
  source?: string | null;
  campaign?: string | null;
  groupId?: string | null;
  postId?: string | null;
  requestId?: string | null;
  listingId?: number | null;
  listingPublicRef?: string | null;
  agentId?: number | null;
  metadata?: Record<string, unknown>;
}

interface TrackedLinkRow extends Omit<TrackedLink, 'metadata'> {
  metadata: string;
}

function rowToLink(row: TrackedLinkRow): TrackedLink {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || '{}');
  } catch {
    metadata = {};
  }
  return { ...row, metadata };
}

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SLUG_LENGTH = 8;

export function generateSlug(): string {
  const bytes = crypto.randomBytes(SLUG_LENGTH);
  let slug = '';
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return slug;
}

export class TrackedLinksRepository {
  constructor(private readonly db: DatabaseSync) {}

  createLink(input: CreateTrackedLinkInput): TrackedLink {
    const stmt = this.db.prepare(`
      INSERT INTO tracked_links
        (slug, kind, payload, source, campaign, group_id, post_id, request_id, listing_id, listing_public_ref, agent_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Retry on the astronomically unlikely slug collision (UNIQUE constraint).
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = generateSlug();
      try {
        const result = stmt.run(
          slug,
          input.kind ?? 'miniapp',
          input.payload ?? null,
          input.source ?? null,
          input.campaign ?? null,
          input.groupId ?? null,
          input.postId ?? null,
          input.requestId ?? null,
          input.listingId ?? null,
          input.listingPublicRef ?? null,
          input.agentId ?? null,
          JSON.stringify(input.metadata ?? {}),
        );
        return this.findById(Number(result.lastInsertRowid))!;
      } catch (err) {
        if (err instanceof Error && /UNIQUE/i.test(err.message)) continue;
        throw err;
      }
    }
    throw new Error('Failed to generate a unique tracking slug after 5 attempts');
  }

  findBySlug(slug: string): TrackedLink | undefined {
    const row = this.db
      .prepare('SELECT * FROM tracked_links WHERE slug = ?')
      .get(slug) as unknown as TrackedLinkRow | undefined;
    return row ? rowToLink(row) : undefined;
  }

  findById(id: number): TrackedLink | undefined {
    const row = this.db
      .prepare('SELECT * FROM tracked_links WHERE id = ?')
      .get(id) as unknown as TrackedLinkRow | undefined;
    return row ? rowToLink(row) : undefined;
  }

  recordClick(id: number): void {
    this.db
      .prepare(
        `UPDATE tracked_links
         SET clicks_count = clicks_count + 1,
             last_clicked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?`,
      )
      .run(id);
  }
}
