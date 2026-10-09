import type { DatabaseSync } from 'node:sqlite';

export interface ListingCandidatePhoto {
  sourceItemId: number;
  sourceUrl: string;
  perceptualHash: string | null;
}

export interface ListingCandidateIdentifier {
  sourceItemId: number;
  type: string;
  value: string;
}

export interface ListingCandidate {
  candidateId: string;
  sourceType: string;
  representativeSourceItemId: number;
  canonicalUrl: string | null;
  sourceUrl: string | null;
  contentHash: string | null;
  authorKey: string | null;
  repostClusterId: string | null;
  sourceItemIds: number[];
  facts: Record<string, unknown>;
  identifiers: ListingCandidateIdentifier[];
  photoAssets: ListingCandidatePhoto[];
  normalizedText: string;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  currency: 'USD' | 'KHR' | null;
  price: number | null;
  category: string | null;
  offerType: 'rent' | 'sale' | null;
}

interface SourceItemRow {
  id: number; source_type: string; external_id: string; source_registry_id: number;
  canonical_url: string | null; source_url: string | null; group_id: string | null; group_name: string | null;
  author_external_id: string | null; author_name: string | null; author_url: string | null;
  raw_text: string | null; raw_payload_json: string; content_hash: string | null;
  published_at: string | null; first_seen_at: string; last_seen_at: string;
}

interface IdentifierRow { source_item_id: number; type: string; normalized_value: string }

function parseObject(value: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}

function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string') return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
}

function asString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function asNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null; }

function canonicalFacts(item: SourceItemRow, payload: Record<string, unknown>): Record<string, unknown> {
  const extracted = payload.listingExtraction && typeof payload.listingExtraction === 'object'
    ? payload.listingExtraction as Record<string, unknown>
    : payload.listingFacts && typeof payload.listingFacts === 'object'
      ? payload.listingFacts as Record<string, unknown>
      : {};
  if (item.source_type === 'KHMER24') return extracted;
  return extracted;
}

function collectUrls(value: unknown, urls = new Set<string>(), path = ''): string[] {
  if (typeof value === 'string') {
    if (/https?:\/\//i.test(value) && (/photo|image|media|attachment/i.test(path) || /\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(value))) urls.add(value.trim());
  } else if (Array.isArray(value)) {
    for (const part of value) collectUrls(part, urls, path);
  } else if (value && typeof value === 'object') {
    for (const [key, part] of Object.entries(value as Record<string, unknown>)) collectUrls(part, urls, `${path}.${key}`);
  }
  return [...urls].sort();
}

function normalizeText(text: string | null): string {
  return (text ?? '').normalize('NFKC').toLocaleLowerCase('en')
    .replace(/https?:\/\/\S+/g, ' ').replace(/(?:\+?855|0)[1-9]\d{1,2}(?:[\s().-]*\d){6,8}/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\p{L}\p{N}$%#+_-]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function parsePriceFromText(rawText: string | null): { price: number; currency: 'USD' | 'KHR' | null } | null {
  if (!rawText) return null;
  const patterns = [
    /(?:monthly\s+rent|rental?\s+price|asking\s+price|monthly\s+rate|rental?\s+rate|price)\s*[:|]?\s*(USD|KHR|\$|៛)?\s*([\d][\d,]*(?:\.\d+)?)/i,
    /\bUSD\s*([\d][\d,]*(?:\.\d+)?)/i,
  ];
  for (let i=0;i<patterns.length;i++) {
    const match=patterns[i]!.exec(rawText);if(!match)continue;
    const amount=Number((match[i===0?2:1]??'').replace(/,/g,''));if(!Number.isFinite(amount)||amount<=0)continue;
    const currencyLabel=(match[i===0?1:0]??'').toUpperCase();
    return{price:amount,currency:currencyLabel==='KHR'||currencyLabel==='៛'?'KHR':currencyLabel==='USD'||currencyLabel==='$'?'USD':null};
  }
  return null;
}

function inferOfferType(rawText: string | null, facts: Record<string,unknown>): 'rent'|'sale'|null {
  const declared=(asString(facts.offer_type)??'').toLowerCase();if(declared==='rent'||declared==='sale')return declared;
  const value=(rawText??'').toLowerCase();
  if(/\b(for\s+sale|house\s+for\s+sell|property\s+for\s+sell|selling price|សម្រាប់លក់|លក់ផ្ទះ|លក់បន្ទាន់)\b/.test(value))return'sale';
  if(/\b(for\s+rent|rent(?:al)? price|monthly rent|\$\s*[\d,]+\s*\/\s*month|ជួល|សម្រាប់ជួល)\b/.test(value))return'rent';
  return null;
}

function photoAssets(item: SourceItemRow, payload: Record<string, unknown>): ListingCandidatePhoto[] {
  const rawPhotoAssets = Array.isArray(payload.photoAssets) ? payload.photoAssets as Array<{ url?: unknown; perceptualHash?: unknown }> : [];
  const rawPhotos = parseArray<unknown>(payload.photos);
  const phashes = parseArray<unknown>(payload.imagePhashes);
  const discovered = rawPhotoAssets.length ? rawPhotoAssets.map((asset) => ({ url: asset.url, hash: asset.perceptualHash }))
    : [...rawPhotos, ...collectUrls(payload)].map((url, index) => ({ url, hash: phashes[index] }));
  const result = new Map<string, ListingCandidatePhoto>();
  for (let i = 0; i < discovered.length; i++) {
    const url = asString(discovered[i]!.url);
    if (!url || !/^https?:\/\//i.test(url) || /\/app\/images\/sim\//i.test(url)) continue;
    const hash = asString(discovered[i]!.hash);
    const existing = result.get(url);
    result.set(url, { sourceItemId: item.id, sourceUrl: url, perceptualHash: existing?.perceptualHash ?? (hash && /^[01]{64}$/.test(hash) ? hash : null) });
  }
  return [...result.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
}

export class ListingCandidateBuilder {
  constructor(private readonly db: DatabaseSync, private readonly repostAlgorithmVersion = 'repost-v1') {}

  build(): ListingCandidate[] {
    const rows = this.db.prepare(`
      SELECT id,source_type,external_id,source_registry_id,canonical_url,source_url,group_id,group_name,
        author_external_id,author_name,author_url,raw_text,raw_payload_json,content_hash,published_at,first_seen_at,last_seen_at
      FROM source_items WHERE classification='HOUSING_SUPPLY' AND source_type IN ('FACEBOOK_GROUP','KHMER24') ORDER BY id
    `).all() as unknown as SourceItemRow[];
    const ids = rows.map((row) => row.id);
    const identifiers = ids.length
      ? this.db.prepare(`SELECT source_item_id,type,normalized_value FROM source_item_identifiers WHERE source_item_id IN (${ids.map(() => '?').join(',')}) ORDER BY source_item_id,type,normalized_value`).all(...ids) as unknown as IdentifierRow[]
      : [];
    const identifiersByItem = new Map<number, ListingCandidateIdentifier[]>();
    for (const entry of identifiers) {
      const list = identifiersByItem.get(entry.source_item_id) ?? [];
      list.push({ sourceItemId: entry.source_item_id, type: entry.type, value: entry.normalized_value });
      identifiersByItem.set(entry.source_item_id, list);
    }
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const groups: Array<{ sourceType: string; representativeId: number; memberIds: number[]; clusterId: string | null }> = [];
    const fbClusters = this.db.prepare(`
      SELECT c.id,c.cluster_key,c.representative_source_item_id,m.source_item_id
      FROM dedupe_clusters c JOIN dedupe_cluster_members m ON m.cluster_id=c.id
      JOIN source_items s ON s.id=m.source_item_id
      WHERE c.algorithm_version=? AND c.entity_type='SUPPLY_REPOST' AND s.source_type='FACEBOOK_GROUP'
      ORDER BY c.id,m.source_item_id
    `).all(this.repostAlgorithmVersion) as Array<{ id: number; cluster_key: string; representative_source_item_id: number; source_item_id: number }>;
    const fbByCluster = new Map<number, typeof fbClusters>();
    for (const member of fbClusters) {
      const group = fbByCluster.get(member.id) ?? [];
      group.push(member);
      fbByCluster.set(member.id, group);
    }
    const groupedFbItemIds = new Set<number>();
    for (const [clusterId, members] of fbByCluster) {
      const representativeId = members[0]!.representative_source_item_id;
      const memberIds = [...new Set(members.map((member) => member.source_item_id))].sort((a, b) => a - b);
      memberIds.forEach((id) => groupedFbItemIds.add(id));
      groups.push({ sourceType: 'FACEBOOK_GROUP', representativeId, memberIds, clusterId: members[0]!.cluster_key ?? String(clusterId) });
    }
    for (const row of rows) {
      if (row.source_type === 'FACEBOOK_GROUP' && !groupedFbItemIds.has(row.id)) {
        groups.push({ sourceType: row.source_type, representativeId: row.id, memberIds: [row.id], clusterId: null });
      } else if (row.source_type === 'KHMER24') {
        groups.push({ sourceType: row.source_type, representativeId: row.id, memberIds: [row.id], clusterId: null });
      }
    }

    const candidates: ListingCandidate[] = [];
    for (const group of groups) {
      const representative = rowById.get(group.representativeId);
      if (!representative) continue;
      const payload = parseObject(representative.raw_payload_json);
      const facts = canonicalFacts(representative, payload);
      const priceFromText=parsePriceFromText(representative.raw_text);
      const memberRows = group.memberIds.map((id) => rowById.get(id)).filter((row): row is SourceItemRow => Boolean(row));
      const allIdentifiers = memberRows.flatMap((item) => identifiersByItem.get(item.id) ?? []);
      const media = memberRows.flatMap((item) => photoAssets(item, parseObject(item.raw_payload_json)));
      const photoMap = new Map<string, ListingCandidatePhoto>();
      for (const photo of media) {
        const prior = photoMap.get(photo.sourceUrl);
        photoMap.set(photo.sourceUrl, { ...photo, perceptualHash: prior?.perceptualHash ?? photo.perceptualHash });
      }
      const currency = facts.currency === 'USD' || facts.currency === 'KHR' ? facts.currency : null;
      const factsPrice = asNumber(facts.price);
      const extractedPrice = priceFromText?.price ?? factsPrice;
      const candidateId = `${group.sourceType.toLowerCase()}:${representative.id}`;
      candidates.push({
        candidateId, sourceType: group.sourceType, representativeSourceItemId: representative.id,
        canonicalUrl: representative.canonical_url, sourceUrl: representative.source_url,
        contentHash: representative.content_hash,
        authorKey: representative.author_external_id?.trim().toLowerCase() ?? representative.author_name?.trim().toLowerCase() ?? null,
        repostClusterId: group.clusterId, sourceItemIds: group.memberIds,
        facts, identifiers: allIdentifiers, photoAssets: [...photoMap.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl)),
        normalizedText: normalizeText(representative.raw_text),
        publishedAt: representative.published_at,
        firstSeenAt: memberRows.map((item) => item.first_seen_at).sort()[0] ?? representative.first_seen_at,
        lastSeenAt: memberRows.map((item) => item.last_seen_at).sort().at(-1) ?? representative.last_seen_at,
        currency: priceFromText?.currency??currency,
        price: extractedPrice === null ? null : (priceFromText?.currency ?? currency) === 'KHR' ? extractedPrice / 4000 : extractedPrice,
        category: asString(facts.category),
        offerType: inferOfferType(representative.raw_text,facts),
      });
    }
    return candidates.sort((a, b) => a.representativeSourceItemId - b.representativeSourceItemId);
  }
}
