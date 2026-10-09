import crypto from 'node:crypto';
import fs from 'node:fs';
import type { SourceAdapter, SourceRunContext, NormalizedSourceItem } from './ingestion-contracts';
import type { SourceType } from '../../database/repositories/source-ingestion.repo';
import type { SourceIdentifierInput } from '../../database/repositories/source-ingestion.repo';
import { stableMediaHash } from './media-identity';

export interface ClassifiedReplayPost {
  id: string | number;
  content?: string;
  groupId?: string | number | null;
  groupName?: string | null;
  groupUrl?: string | null;
  postUrl?: string | null;
  datePosted?: string | null;
  source?: string | null;
  userUrl?: string | null;
  userName?: string | null;
  classification?: string | null;
  classificationReason?: string | null;
  classifiedBy?: { provider?: string; model?: string; fallbackDepth?: number };
  extractedBy?: { provider?: string; model?: string; fallbackDepth?: number };
  aiAttempts?: Array<{
    stage: 'CLASSIFICATION' | 'SUPPLY_EXTRACTION' | 'DEMAND_EXTRACTION';
    provider?: string;
    model?: string;
    fallbackDepth?: number;
    callId?: string;
    attemptIndex?: number;
    success?: boolean;
    errorCode?: string;
    latencyMs?: number;
  }>;
  listingExtraction?: unknown;
  demandExtraction?: unknown;
  photos?: string[];
  photoAssets?: Array<{ url: string; perceptualHash?: string | null; hashAlgorithm?: string; hashVersion?: number }>;
  [key: string]: unknown;
}

function groupExternalId(post: ClassifiedReplayPost): string {
  const url = post.groupUrl ?? post.source ?? '';
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/groups\/([^/?#]+)/i);
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch { /* validated below */ }
  const groupId = post.groupId == null ? '' : String(post.groupId).trim();
  if (groupId) return groupId;
  throw new Error(`Post ${post.id} is missing a stable Facebook group identity`);
}

function normalizeClassification(value: string | null | undefined): NormalizedSourceItem['classification'] {
  const allowed = ['HOUSING_SUPPLY', 'HOUSING_DEMAND', 'HOUSING_ADJACENT', 'IRRELEVANT', 'UNCLASSIFIED'] as const;
  return allowed.includes(value as typeof allowed[number]) ? value as typeof allowed[number] : 'UNCLASSIFIED';
}

function stringArray(record: unknown, key: string): string[] {
  if (!record || typeof record !== 'object') return [];
  const value = (record as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export class ReplayAdapter implements SourceAdapter<ClassifiedReplayPost> {
  readonly sourceType: SourceType = 'FACEBOOK_GROUP';

  constructor(readonly inputPath: string) {}

  async *fetchNewItems(_context: SourceRunContext): AsyncIterable<ClassifiedReplayPost> {
    const parsed: unknown = JSON.parse(fs.readFileSync(this.inputPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { posts?: unknown }).posts)) {
      throw new Error('Replay input must be a classified dump with a posts array');
    }
    for (const post of (parsed as { posts: unknown[] }).posts) {
      yield post as ClassifiedReplayPost;
    }
  }

  normalize(post: ClassifiedReplayPost): NormalizedSourceItem<ClassifiedReplayPost> {
    if (!post || typeof post !== 'object') throw new Error('Replay item must be an object');
    const externalId = String(post.id ?? '').trim();
    if (!externalId) throw new Error('Replay post is missing an external id');
    const sourceExternalId = groupExternalId(post);
    const groupId = post.groupId == null ? sourceExternalId : String(post.groupId);
    const groupUrl = post.groupUrl ?? post.source ?? undefined;
    const groupName = post.groupName?.trim() || `Facebook group ${sourceExternalId}`;
    const content = typeof post.content === 'string' ? post.content : '';
    if (!post.classification) throw new Error(`Post ${externalId} has no saved classification; use REPARSE mode to classify it`);
    const groupHint = `${groupName} ${groupUrl ?? ''}`.toLowerCase();
    const city = /siem\s*reap|siemreap/i.test(groupHint) ? 'siem_reap' : undefined;
    const aiResults: NonNullable<NormalizedSourceItem['aiResults']> = Array.isArray(post.aiAttempts)
      ? post.aiAttempts.map((attempt) => ({ ...attempt }))
      : [];
    if (!post.aiAttempts && (post.classifiedBy?.provider || post.classifiedBy?.model)) {
      aiResults.push({ stage: 'CLASSIFICATION', ...post.classifiedBy });
    }
    if (!post.aiAttempts && post.listingExtraction && (post.extractedBy?.provider || post.extractedBy?.model)) {
      aiResults.push({ stage: 'SUPPLY_EXTRACTION', ...post.extractedBy });
    }
    if (!post.aiAttempts && post.demandExtraction && (post.extractedBy?.provider || post.extractedBy?.model)) {
      aiResults.push({ stage: 'DEMAND_EXTRACTION', ...post.extractedBy });
    }
    const deterministicIdentifiers: SourceIdentifierInput[] = [
      ...stringArray(post.listingExtraction, 'phone_numbers').map((value) => ({ type: 'PHONE' as const, rawValue: value, normalizedValue: value })),
      ...stringArray(post.listingExtraction, 'maps_urls').map((value) => ({ type: 'MAPS_URL' as const, rawValue: value, normalizedValue: value })),
      ...stringArray(post.listingExtraction, 'telegram_links').map((value) => ({ type: 'TELEGRAM' as const, rawValue: value, normalizedValue: value })),
    ];
    return {
      sourceIdentity: { sourceType: 'FACEBOOK_GROUP', externalSourceId: sourceExternalId, name: groupName,
        url: groupUrl, city },
      externalId,
      raw: post,
      canonicalUrl: post.postUrl ?? undefined,
      sourceUrl: post.postUrl ?? undefined,
      groupId,
      groupName,
      authorExternalId: post.userUrl ?? undefined,
      authorName: post.userName ?? undefined,
      authorUrl: post.userUrl ?? undefined,
      rawText: content,
      contentHash: crypto.createHash('sha256').update(content).digest('hex'),
      mediaHash: stableMediaHash([...(post.photos ?? []), ...(post.photoAssets ?? []).map((asset) => asset.url)]) ?? undefined,
      publishedAt: post.datePosted ?? undefined,
      classification: normalizeClassification(post.classification),
      metadata: { classificationReason: post.classificationReason ?? null },
      aiResults,
      deterministicIdentifiers,
    };
  }
}
