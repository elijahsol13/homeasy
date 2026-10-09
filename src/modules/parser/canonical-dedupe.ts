import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { computeHammingDistance } from './phash';
import { ListingCandidateBuilder, type ListingCandidate, type ListingCandidatePhoto } from './listing-candidates';
import { SourceIngestionRepository } from '../../database/repositories/source-ingestion.repo';

export const CANONICAL_DEDUPE_VERSION = 'canonical-dedupe-v1';

export type CanonicalDecision = 'SAME_LISTING' | 'SAME_PROPERTY_DIFFERENT_LISTING' | 'POSSIBLE_SAME_PROPERTY' | 'DIFFERENT_PROPERTY';

interface Evidence {
  propertyScore: number;
  listingScore: number;
  propertyFamilies: Record<string, number>;
  listingFamilies: Record<string, number>;
  reasons: string[];
  sharedIdentifiers: string[];
  matchedPhotos: Array<{ left: string; right: string; distance: number }>;
  textSimilarity: number;
  decision: CanonicalDecision;
  retrievedBy: string[];
}

interface CandidatePair { a: ListingCandidate; b: ListingCandidate; retrievedBy: Set<string> }
interface PersistedDecision extends Evidence { a: ListingCandidate; b: ListingCandidate }

export interface CanonicalShadowReport {
  algorithmVersion: string;
  candidateCount: number;
  facebookCandidates: number;
  khmer24Candidates: number;
  totalPossibleCrossSourcePairs: number;
  pairsActuallyScored: number;
  pairsAvoided: number;
  pairReductionFactor: number;
  decisionCounts: Record<CanonicalDecision, number>;
  canonicalProperties: number;
  canonicalListings: number;
  sourceOccurrences: number;
  mediaAssets: number;
  mediaReusedFromLegacy: number;
  mediaNewlyHashed: number;
  pHashComparisons: number;
  pHashMatches: number;
  crossSourceCanonicalMatches: number;
  singleSourceProperties: number;
  multiSourceProperties: number;
  largestOccurrencesPerListing: number;
  examples: Record<CanonicalDecision, Array<Record<string, unknown>>>;
}

export interface CanonicalCalibrationPair {
  candidateA: string;
  candidateB: string;
  sourceItemA: number;
  sourceItemB: number;
  titleA: string;
  titleB: string;
  priceA: number | null;
  priceB: number | null;
  currencyA: string | null;
  currencyB: string | null;
  offerTypeA: string | null;
  offerTypeB: string | null;
  locationA: string;
  locationB: string;
  bedroomsA: number | null;
  bedroomsB: number | null;
  bathroomsA: number | null;
  bathroomsB: number | null;
  propertyTypeA: string;
  propertyTypeB: string;
  propertyScore: number;
  listingScore: number;
  propertyFamilies: Record<string, number>;
  listingFamilies: Record<string, number>;
  sharedIdentifiers: string[];
  photoMatchCount: number;
  reasons: string[];
  decision: CanonicalDecision;
  selectedByProductionRetrieval: boolean;
  retrievalSignals: string[];
}

export interface CanonicalCalibrationReport {
  algorithmVersion: string;
  facebookCandidates: number;
  khmer24Candidates: number;
  cartesianPairs: number;
  productionSelectedPairs: number;
  excludedPairs: number;
  cartesianPHashComparisons: number;
  cartesianPHashMatches: number;
  excludedPhotoMatchPairs: number;
  selectedPhotoMatchPairs: number;
  excludedPropertyScoreAtLeast070: number;
  excludedPropertyScoreAtLeast060: number;
  selectedPropertyScoreAtLeast070: number;
  humanPositiveRecallAt070: null;
  excludedTop50: CanonicalCalibrationPair[];
}

export interface CanonicalGoldenPairInput { candidateA:string; candidateB:string; humanLabel:CanonicalDecision|'UNKNOWN' }
export interface CanonicalGoldenEvaluation {
  algorithmVersion:string;
  goldenPairCount:number;
  pairs:Array<{
    candidateA:string;candidateB:string;humanLabel:CanonicalDecision|'UNKNOWN';decision:CanonicalDecision;
    propertyScore:number;listingScore:number;propertyFamilies:Record<string,number>;listingFamilies:Record<string,number>;
    photoMatchCount:number;photoHammingDistances:number[];selectedByProductionRetrieval:boolean;reasons:string[];
  }>;
}

const PROPERTY_CAPS = { IDENTIFIERS: 1.00, MEDIA: 0.55, CONTACT: 0.35, LOCATION: 0.30, STRUCTURED: 0.25, TEXT: 0.15 };
const LISTING_CAPS = { IDENTIFIERS: 1.00, MEDIA: 0.35, CONTACT: 0.65, LOCATION: 0.25, STRUCTURED: 0.45, TEXT: 0.20 };
const DECISION_THRESHOLDS = { sameListingProperty: 0.90, sameListingOffer: 0.90, sameProperty: 0.90, possibleProperty: 0.70 };
const TEXT_STOP = new Set(['a','an','and','are','as','at','be','by','for','from','has','have','in','is','it','of','on','or','the','to','with','rent','rental','apartment','house','property','bedroom','bedrooms']);

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function objectJson(value: string | null): Record<string, unknown> { try { return object(JSON.parse(value ?? '{}')); } catch { return {}; } }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function num(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function sqlValue(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return Number(value);
  if (value && typeof value === 'object') return JSON.stringify(value);
  return null;
}
function norm(value: unknown): string { return text(value).normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim(); }
function fact(c: ListingCandidate, ...names: string[]): unknown { for (const name of names) if (c.facts[name] !== undefined && c.facts[name] !== null && c.facts[name] !== '') return c.facts[name]; return null; }
function stableHash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function compareText(a: string, b: string): number {
  const at = new Set(norm(a).split(' ').filter((t) => t.length > 1 && !TEXT_STOP.has(t)));
  const bt = new Set(norm(b).split(' ').filter((t) => t.length > 1 && !TEXT_STOP.has(t)));
  if (!at.size || !bt.size) return 0;
  let n = 0; for (const token of at) if (bt.has(token)) n++;
  return n / (at.size + bt.size - n);
}
function familyScore(values: number[], cap: number): number { return Math.min(cap, values.reduce((sum, value) => sum + value, 0)); }
function boolSame(a: unknown, b: unknown): boolean { return a !== null && b !== null && a !== undefined && b !== undefined && String(a).toLowerCase() === String(b).toLowerCase(); }

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value); url.protocol = 'https:'; url.hostname = url.hostname.toLowerCase().replace(/^www\./, ''); url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort(); return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function identifierSets(candidate: ListingCandidate): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const identifier of candidate.identifiers) {
    const set = map.get(identifier.type) ?? new Set<string>(); set.add(identifier.value.toLowerCase()); map.set(identifier.type, set);
  }
  return map;
}

function sharedIdentifiers(a: ListingCandidate, b: ListingCandidate): string[] {
  const left = identifierSets(a); const right = identifierSets(b); const result: string[] = [];
  for (const [type, values] of left) for (const value of values) if (right.get(type)?.has(value)) result.push(`${type}:${value}`);
  return result.sort();
}

function imageMatches(a: ListingCandidatePhoto[], b: ListingCandidatePhoto[]): { matches: Evidence['matchedPhotos']; comparisons: number; overlap: number } {
  const left = a.filter((photo) => photo.perceptualHash && /^[01]{64}$/.test(photo.perceptualHash));
  const right = b.filter((photo) => photo.perceptualHash && /^[01]{64}$/.test(photo.perceptualHash));
  let comparisons = 0; const matches: Evidence['matchedPhotos'] = [];
  for (const x of left) for (const y of right) {
    comparisons++;
    const distance = computeHammingDistance(x.perceptualHash, y.perceptualHash);
    if (distance <= 5) matches.push({ left: x.sourceUrl, right: y.sourceUrl, distance });
  }
  const exactUrls = new Set(a.map((photo) => normalizedUrl(photo.sourceUrl)).filter(Boolean));
  const sharedUrlCount = b.filter((photo) => exactUrls.has(normalizedUrl(photo.sourceUrl))).length;
  const overlap = Math.min(a.length, b.length) ? sharedUrlCount / Math.min(a.length, b.length) : 0;
  const uniqueMatches = new Map<string, Evidence['matchedPhotos'][number]>();
  for (const match of matches) uniqueMatches.set(`${match.left}\0${match.right}`, match);
  return { matches: [...uniqueMatches.values()], comparisons, overlap };
}

function samePrice(a: number | null, b: number | null, tolerance: number): boolean {
  if (a === null || b === null || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= tolerance;
}

function scorePair(a: ListingCandidate, b: ListingCandidate, retrievedBy: Set<string>, imageStats: { matches: Evidence['matchedPhotos']; comparisons: number; overlap: number }): Evidence {
  const shared = sharedIdentifiers(a, b);
  const codes = shared.filter((entry) => entry.startsWith('PROPERTY_CODE:') || entry.startsWith('AGENCY_CODE:'));
  const maps = shared.filter((entry) => entry.startsWith('MAPS_URL:') || entry.startsWith('MAPS_PLACE_ID:'));
  const phones = shared.filter((entry) => entry.startsWith('PHONE:'));
  const messaging = shared.filter((entry) => /^(TELEGRAM|WHATSAPP|EMAIL):/.test(entry));
  const sameSourceUrl = Boolean(a.sourceUrl && b.sourceUrl && normalizedUrl(a.sourceUrl) === normalizedUrl(b.sourceUrl));
  const sameContentHash = Boolean(a.contentHash && a.contentHash === b.contentHash);
  const sameExactText = Boolean(a.normalizedText && a.normalizedText === b.normalizedText);
  const sameAuthor = Boolean(a.authorKey && a.authorKey === b.authorKey);
  const cityA = norm(fact(a, 'city')); const cityB = norm(fact(b, 'city'));
  const cityKnown = Boolean(cityA && cityB);
  const sameCity = cityKnown && cityA === cityB;
  const explicitA = norm(fact(a, 'sangkat', 'explicit_location', 'location'));
  const explicitB = norm(fact(b, 'sangkat', 'explicit_location', 'location'));
  const sameArea = Boolean(explicitA && explicitB && explicitA === explicitB);
  const typeA = norm(fact(a, 'property_type', 'category')); const typeB = norm(fact(b, 'property_type', 'category'));
  const bedsA = num(fact(a, 'bedrooms')); const bedsB = num(fact(b, 'bedrooms'));
  const bathsA = num(fact(a, 'bathrooms')); const bathsB = num(fact(b, 'bathrooms'));
  const sameType = Boolean(typeA && typeB && typeA === typeB);
  const sameBeds = bedsA !== null && bedsB !== null && bedsA === bedsB;
  const sameBaths = bathsA !== null && bathsB !== null && bathsA === bathsB;
  const similarPriceForProperty = samePrice(a.price, b.price, 0.10);
  const sameTerms = ['min_lease_months','lease_term_text','deposit_amount','deposit_months','electricity_type','electricity_rate','water_type','water_rate']
    .some((key) => fact(a, key) !== null && fact(b, key) !== null && boolSame(fact(a, key), fact(b, key)));
  const sameOfferType = Boolean(a.offerType && b.offerType && a.offerType === b.offerType);
  const conflictingOfferType = Boolean(a.offerType && b.offerType && a.offerType !== b.offerType);
  const textSimilarity = compareText(a.normalizedText, b.normalizedText);
  const twoOrMoreMediaMatches = imageStats.matches.length >= 2;
  const highPhotoOverlap = imageStats.overlap >= 0.6 && Math.min(a.photoAssets.length, b.photoAssets.length) >= 2;

  const idProperty = [...(codes.length ? [0.60] : []), ...(maps.length ? [0.60] : [])];
  const idListing = [...(codes.length ? [0.50] : []), ...(maps.length ? [0.35] : [])];
  const mediaProperty = [...(twoOrMoreMediaMatches ? [0.45] : imageStats.matches.length === 1 ? [0.25] : []), ...(highPhotoOverlap ? [0.25] : [])];
  const mediaListing = [...(twoOrMoreMediaMatches ? [0.20] : []), ...(highPhotoOverlap ? [0.10] : [])];
  const contactProperty = [...(phones.length ? [0.25] : []), ...(messaging.length ? [0.15] : []), ...(sameAuthor ? [0.10] : [])];
  const contactListing = [...(phones.length || messaging.length || sameAuthor ? [0.45] : [])];
  const locationProperty = [...(sameArea ? [0.12, 0.15] : sameCity ? [0.08] : []), ...(boolSame(fact(a,'latitude'), fact(b,'latitude')) && fact(a,'latitude') !== null ? [0.15] : [])];
  const locationListing = [...(sameArea ? [0.05] : [])];
  const structuredProperty = [...(sameBeds ? [0.08] : []), ...(sameBaths ? [0.05] : []), ...(sameType ? [0.07] : []), ...(similarPriceForProperty ? [0.05] : [])];
  const structuredListing = [...(sameBeds ? [0.08] : []), ...(sameBaths ? [0.05] : []), ...(sameType ? [0.07] : []), ...(samePrice(a.price,b.price,0.05) ? [0.25] : []), ...(sameTerms ? [0.15] : []), ...(sameOfferType ? [0.05] : [])];
  const textProperty = textSimilarity >= 0.8 ? [0.10] : textSimilarity >= 0.6 ? [0.05] : [];
  const textListing = textSimilarity >= 0.8 ? [0.10] : textSimilarity >= 0.6 ? [0.05] : [];
  const propertyFamilies = {
    IDENTIFIERS: familyScore(idProperty, PROPERTY_CAPS.IDENTIFIERS), MEDIA: familyScore(mediaProperty, PROPERTY_CAPS.MEDIA),
    CONTACT: familyScore(contactProperty, PROPERTY_CAPS.CONTACT), LOCATION: familyScore(locationProperty, PROPERTY_CAPS.LOCATION),
    STRUCTURED: familyScore(structuredProperty, PROPERTY_CAPS.STRUCTURED), TEXT: familyScore(textProperty, PROPERTY_CAPS.TEXT),
  };
  const listingFamilies = {
    IDENTIFIERS: familyScore([...idListing, ...(sameSourceUrl ? [0.40] : []), ...(sameExactText ? [0.40] : [])], LISTING_CAPS.IDENTIFIERS),
    MEDIA: familyScore(mediaListing, LISTING_CAPS.MEDIA), CONTACT: familyScore(contactListing, LISTING_CAPS.CONTACT),
    LOCATION: familyScore(locationListing, LISTING_CAPS.LOCATION), STRUCTURED: familyScore(structuredListing, LISTING_CAPS.STRUCTURED),
    TEXT: familyScore(textListing, LISTING_CAPS.TEXT),
  };
  let propertyScore = Math.min(1, Object.values(propertyFamilies).reduce((sum, value) => sum + value, 0));
  let listingScore = Math.min(1, Object.values(listingFamilies).reduce((sum, value) => sum + value, 0));
  if (conflictingOfferType) listingScore = Math.min(listingScore,0.69);
  if (cityKnown && !sameCity) propertyScore = Math.min(propertyScore, 0.20);
  const evidenceForDecision={propertyScore,listingScore,propertyFamilies,listingFamilies,reasons:[] as string[],sharedIdentifiers:shared,
    matchedPhotos:imageStats.matches,textSimilarity,retrievedBy:[...retrievedBy].sort()};
  const decision=new PropertyDeduplicator().decide(a,b,evidenceForDecision);

  const reasons: string[] = [];
  if (codes.length) reasons.push(`shared listing/property identifier: ${codes.join(', ')}`);
  if (maps.length) reasons.push(`shared maps reference: ${maps.join(', ')}`);
  if (imageStats.matches.length) reasons.push(`${imageStats.matches.length} matching dHash photo pair(s), Hamming <= 5`);
  if (highPhotoOverlap) reasons.push(`photo URL overlap ${(imageStats.overlap * 100).toFixed(0)}%`);
  if (phones.length) reasons.push(`shared phone: ${phones.join(', ')}`);
  if (messaging.length) reasons.push(`shared messaging/email identifiers: ${messaging.join(', ')}`);
  if (sameAuthor) reasons.push('same author identity');
  if (sameArea) reasons.push(`same location: ${text(fact(a,'sangkat','explicit_location','location'))}`);
  if (sameBeds) reasons.push(`same bedrooms: ${bedsA}`);
  if (sameType) reasons.push(`same property type: ${text(fact(a,'property_type','category'))}`);
  if (samePrice(a.price,b.price,0.05)) reasons.push('same asking price within 5%');
  if (sameTerms) reasons.push('same lease/deposit/utility terms');
  if (sameOfferType) reasons.push(`same offer type: ${a.offerType}`);
  if (conflictingOfferType) reasons.push(`conflicting offer types: ${a.offerType} vs ${b.offerType}`);
  if (sameContentHash || sameExactText) reasons.push('same exact source content');
  reasons.push(`text_jaccard=${textSimilarity.toFixed(3)}`, `property_score=${propertyScore.toFixed(3)}`, `listing_score=${listingScore.toFixed(3)}`);
  return { propertyScore, listingScore, propertyFamilies, listingFamilies, reasons, sharedIdentifiers: shared,
    matchedPhotos: imageStats.matches, textSimilarity, decision, retrievedBy: [...retrievedBy].sort() };
}

function candidateTokens(candidate: ListingCandidate): string[] {
  return [...new Set(norm(candidate.normalizedText).split(' ').filter((token) => token.length >= 4 && !TEXT_STOP.has(token) && !/^\d+$/.test(token)))];
}

function candidatePriceBucket(candidate: ListingCandidate): string | null {
  if (!candidate.price || candidate.price <= 0) return null;
  return `${Math.round(Math.log(candidate.price) / Math.log(1.2))}`;
}

function directRetrievalSignals(a: ListingCandidate, b: ListingCandidate): string[] {
  const signals = new Set<string>();
  for (const identifier of sharedIdentifiers(a, b)) signals.add(`identifier:${identifier}`);
  const cityA=norm(fact(a,'city'));const cityB=norm(fact(b,'city'));
  const areaA=norm(fact(a,'sangkat','explicit_location','location'));const areaB=norm(fact(b,'sangkat','explicit_location','location'));
  const typeA=norm(fact(a,'property_type','category'));const typeB=norm(fact(b,'property_type','category'));
  const bedsA=num(fact(a,'bedrooms'));const bedsB=num(fact(b,'bedrooms'));
  if(cityA&&cityA===cityB&&areaA&&areaA===areaB){
    signals.add(`location:${cityA}:${areaA}`);
    if(typeA&&typeA===typeB&&bedsA!==null&&bedsA===bedsB)signals.add(`structured:${cityA}:${areaA}:${typeA}:${bedsA}`);
    const priceA=candidatePriceBucket(a);const priceB=candidatePriceBucket(b);
    if(priceA&&priceA===priceB)signals.add(`price:${cityA}:${areaA}:${typeA}:${priceA}`);
  }
  const tokensA=new Set(candidateTokens(a));for(const token of candidateTokens(b))if(tokensA.has(token))signals.add(`token:${token}`);
  const bands=(candidate:ListingCandidate)=>new Set(candidate.photoAssets.filter((photo)=>photo.perceptualHash&&/^[01]{64}$/.test(photo.perceptualHash))
    .flatMap((photo)=>Array.from({length:8},(_,i)=>`phash:${i}:${photo.perceptualHash!.slice(i*8,i*8+8)}`)));
  const bandsA=bands(a);for(const value of bands(b))if(bandsA.has(value))signals.add(value);
  return [...signals].sort();
}

function getFactsForSourceItem(db: DatabaseSync, id: number): Record<string, unknown> {
  const row = db.prepare('SELECT source_type,raw_payload_json FROM source_items WHERE id=?').get(id) as { source_type: string; raw_payload_json: string } | undefined;
  if (!row) return {};
  let payload: Record<string, unknown> = {};
  try { payload = object(JSON.parse(row.raw_payload_json)); } catch { /* ignore malformed raw data */ }
  return object(row.source_type === 'KHMER24' ? payload.listingFacts : payload.listingExtraction);
}

function observedTimestamps(db: DatabaseSync, id: number): { firstSeenAt: string; lastSeenAt: string } {
  const row = db.prepare('SELECT source_type,first_seen_at,last_seen_at,raw_payload_json FROM source_items WHERE id=?').get(id) as { source_type: string; first_seen_at: string; last_seen_at: string; raw_payload_json: string };
  if (row.source_type === 'KHMER24') {
    try {
      const payload = object(JSON.parse(row.raw_payload_json));
      const created = text(payload.legacyCreatedAt) || text(object(payload.legacyProperty).created_at);
      const updated = text(payload.legacyUpdatedAt) || text(object(payload.legacyProperty).updated_at);
      return { firstSeenAt: created || row.first_seen_at, lastSeenAt: updated || row.last_seen_at };
    } catch { /* raw payload can be absent */ }
  }
  return { firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at };
}

function representativeScore(candidate: ListingCandidate): number {
  const knownFacts = Object.values(candidate.facts).filter((value) => value !== null && value !== undefined && value !== '').length;
  return knownFacts * 2 + candidate.identifiers.length + candidate.photoAssets.length + candidate.normalizedText.length / 1000;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(value: string): string { const parent = this.parent.get(value); if (!parent) { this.parent.set(value,value); return value; } if (parent === value) return value; const root = this.find(parent); this.parent.set(value,root); return root; }
  union(a: string,b: string): void { const x=this.find(a),y=this.find(b); if(x!==y)this.parent.set([x,y].sort().at(-1)!,[x,y].sort()[0]!); }
}

export class PropertyDeduplicator {
  decide(a: ListingCandidate,b: ListingCandidate,evidence: Omit<Evidence,'decision'|'reasons'>): CanonicalDecision {
    if (new ListingDeduplicator().sameOffer(a,b,evidence)) return 'SAME_LISTING';
    if (evidence.propertyScore >= DECISION_THRESHOLDS.sameProperty && evidence.listingScore < 0.70) return 'SAME_PROPERTY_DIFFERENT_LISTING';
    if (evidence.propertyScore >= DECISION_THRESHOLDS.possibleProperty) return 'POSSIBLE_SAME_PROPERTY';
    return 'DIFFERENT_PROPERTY';
  }
}

export class ListingDeduplicator {
  sameOffer(a: ListingCandidate,b: ListingCandidate,evidence: Omit<Evidence,'decision'|'reasons'>): boolean {
    return evidence.propertyScore >= DECISION_THRESHOLDS.sameListingProperty
      && evidence.listingScore >= DECISION_THRESHOLDS.sameListingOffer;
  }
}

export class CanonicalShadowService {
  constructor(private readonly db: DatabaseSync, private readonly algorithmVersion = CANONICAL_DEDUPE_VERSION,
    private readonly repostAlgorithmVersion = 'repost-v1') {}

  run(options: { dryRun: boolean }): CanonicalShadowReport {
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(this.algorithmVersion)) throw new Error('Invalid canonical algorithm version');
    const candidates = new ListingCandidateBuilder(this.db, this.repostAlgorithmVersion).build();
    const fb = candidates.filter((candidate) => candidate.sourceType === 'FACEBOOK_GROUP');
    const k24 = candidates.filter((candidate) => candidate.sourceType === 'KHMER24');
    const pairs = this.retrieveCandidates(fb,k24);
    let pHashComparisons = 0; let pHashMatches = 0;
    const decisions: PersistedDecision[] = [];
    for (const pair of pairs.values()) {
      const photos = imageMatches(pair.a.photoAssets,pair.b.photoAssets);
      pHashComparisons += photos.comparisons; pHashMatches += photos.matches.length;
      const base = scorePair(pair.a,pair.b,pair.retrievedBy,photos);
      const decision = base.decision;
      decisions.push({ ...base, decision, a: pair.a, b: pair.b });
    }
    const propertyUnion = new UnionFind(); const listingUnion = new UnionFind();
    for (const candidate of candidates) { propertyUnion.find(candidate.candidateId); listingUnion.find(candidate.candidateId); }
    for (const decision of decisions) {
      if (decision.decision === 'SAME_LISTING' || decision.decision === 'SAME_PROPERTY_DIFFERENT_LISTING') propertyUnion.union(decision.a.candidateId,decision.b.candidateId);
      if (decision.decision === 'SAME_LISTING') listingUnion.union(decision.a.candidateId,decision.b.candidateId);
    }
    const propertyGroups = this.groups(candidates,propertyUnion);
    const listingGroups = this.groups(candidates,listingUnion);
    const canonicalData = this.buildCanonicalGroups(candidates,propertyGroups,listingGroups);
    const decisionCounts: CanonicalShadowReport['decisionCounts'] = { SAME_LISTING:0,SAME_PROPERTY_DIFFERENT_LISTING:0,POSSIBLE_SAME_PROPERTY:0,DIFFERENT_PROPERTY:0 };
    for (const decision of decisions) decisionCounts[decision.decision]++;
    let persisted: { canonicalProperties: number; canonicalListings: number; sourceOccurrences: number; mediaAssets: number } | null = null;
    if (!options.dryRun) persisted = this.persist(candidates,decisions,canonicalData);
    const reportExamples = this.examples(decisions);
    const possiblePairs = fb.length * k24.length;
    const propertySourceCounts = canonicalData.properties.map((group) => new Set(group.candidates.map((candidate) => candidate.sourceType)).size);
    const listingOccurrenceCounts = canonicalData.listings.map((group) => group.candidates.reduce((sum,candidate) => sum + candidate.sourceItemIds.length,0));
    return {
      algorithmVersion: this.algorithmVersion, candidateCount: candidates.length, facebookCandidates: fb.length, khmer24Candidates: k24.length,
      totalPossibleCrossSourcePairs: possiblePairs, pairsActuallyScored: decisions.length, pairsAvoided: Math.max(0,possiblePairs-decisions.length),
      pairReductionFactor: decisions.length ? Number((possiblePairs/decisions.length).toFixed(2)) : possiblePairs,
      decisionCounts, canonicalProperties: canonicalData.properties.length, canonicalListings: canonicalData.listings.length,
      sourceOccurrences: candidates.reduce((sum,candidate)=>sum+candidate.sourceItemIds.length,0),
      mediaAssets: persisted?.mediaAssets ?? canonicalData.photos.length,
      mediaReusedFromLegacy: candidates.flatMap((candidate)=>candidate.photoAssets).filter((photo)=>photo.perceptualHash).length,
      mediaNewlyHashed: 0, pHashComparisons, pHashMatches,
      crossSourceCanonicalMatches: decisions.filter((entry)=>entry.decision==='SAME_LISTING'||entry.decision==='SAME_PROPERTY_DIFFERENT_LISTING').length,
      singleSourceProperties: propertySourceCounts.filter((count)=>count===1).length,
      multiSourceProperties: propertySourceCounts.filter((count)=>count>1).length,
      largestOccurrencesPerListing: Math.max(0,...listingOccurrenceCounts), examples: reportExamples,
    };
  }

  /** Updates an existing canonical binding, or attaches a repost member to its cluster's sole binding. */
  reconcileBoundSourceItems(sourceItemIds:number[],observedAt=new Date().toISOString()):{
    processed:number;occurrencesAttached:number;bindingsUpdated:number;repurposed:number;needsGlobalMatch:number;inconsistencies:Array<{sourceItemId:number;listingIds:number[]}>;
  }{
    this.db.exec('SAVEPOINT canonical_bound_reconcile');
    try{
      const result=this.reconcileBoundSourceItemsUnsafe(sourceItemIds,observedAt);
      this.db.exec('RELEASE canonical_bound_reconcile');
      return result;
    }catch(error){
      this.db.exec('ROLLBACK TO canonical_bound_reconcile');this.db.exec('RELEASE canonical_bound_reconcile');throw error;
    }
  }

  private reconcileBoundSourceItemsUnsafe(sourceItemIds:number[],observedAt:string):{
    processed:number;occurrencesAttached:number;bindingsUpdated:number;repurposed:number;needsGlobalMatch:number;inconsistencies:Array<{sourceItemId:number;listingIds:number[]}>;
  }{
    const candidates=new ListingCandidateBuilder(this.db,this.repostAlgorithmVersion).build();
    const candidateByItem=new Map<number,ListingCandidate>();for(const candidate of candidates)for(const id of candidate.sourceItemIds)candidateByItem.set(id,candidate);
    const repo=new SourceIngestionRepository(this.db);const out={processed:0,occurrencesAttached:0,bindingsUpdated:0,repurposed:0,needsGlobalMatch:0,inconsistencies:[] as Array<{sourceItemId:number;listingIds:number[]}>};
    for(const sourceItemId of [...new Set(sourceItemIds)]){
      const candidate=candidateByItem.get(sourceItemId);if(!candidate){out.needsGlobalMatch++;continue;}
      const memberIds=candidate.sourceItemIds;
      const bindings=this.db.prepare(`SELECT o.id AS occurrence_id,o.source_item_id,o.listing_id,l.property_id,l.primary_source_occurrence_id,
        l.sangkat,l.city,l.property_type,l.category,l.bedrooms,l.listing_facts_json,l.availability_status
        FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
        WHERE o.source_entity_key=? AND o.is_current=1 AND o.source_item_id IN (${memberIds.map(()=>'?').join(',')})`)
        .all(this.algorithmVersion,...memberIds) as Array<{occurrence_id:number;source_item_id:number;listing_id:number;property_id:number|null;primary_source_occurrence_id:number|null;
          sangkat:string|null;city:string|null;property_type:string|null;category:string|null;bedrooms:number|null;listing_facts_json:string|null;availability_status:string|null}>;
      const listingIds=[...new Set(bindings.map((row)=>row.listing_id))];
      if(listingIds.length>1){out.inconsistencies.push({sourceItemId,listingIds});continue;}
      if(!listingIds.length){out.needsGlobalMatch++;continue;}
      const listingId=listingIds[0]!;const existing=bindings.find((row)=>row.source_item_id===sourceItemId);const listing=bindings[0]!;
      const facts=getFactsForSourceItem(this.db,sourceItemId);
      const asText=(value:unknown)=>typeof value==='string'?value.trim():'';
      const newArea=norm(fact(candidate,'sangkat','explicit_location','location'));
      const oldArea=norm(listing.sangkat);
      const newBeds=num(facts.bedrooms)??num(fact(candidate,'bedrooms'));
      const oldFacts=objectJson(listing.listing_facts_json);
      const oldBeds=listing.bedrooms;
      const newType=norm(facts.property_type??facts.category??candidate.category);
      const oldType=norm(listing.property_type??listing.category);
      const newCode=asText(facts.property_code??facts.unit_identifier);
      const oldCode=asText(oldFacts.property_code??oldFacts.unit_identifier);
      const areaConflict=Boolean(oldArea&&newArea&&oldArea!==newArea&&!oldArea.includes(newArea)&&!newArea.includes(oldArea));
      const bedsConflict=oldBeds!==null&&newBeds!==null&&Math.abs(oldBeds-newBeds)>=2;
      const typeConflict=Boolean(oldType&&newType&&oldType!==newType);
      const codeConflict=Boolean(oldCode&&newCode&&oldCode.toLowerCase()!==newCode.toLowerCase());
      if(existing&&((codeConflict&&(areaConflict||bedsConflict||typeConflict))||(areaConflict&&bedsConflict&&typeConflict))){
        repo.closeCurrentCanonicalBindings(sourceItemId,this.algorithmVersion,observedAt);out.repurposed++;out.needsGlobalMatch++;continue;
      }
      const source=this.db.prepare(`SELECT id,source_registry_id,external_id,canonical_url,source_url,group_id,group_name,author_external_id,author_name,author_url,published_at,content_hash,media_hash,first_seen_at,last_seen_at
        FROM source_items WHERE id=?`).get(sourceItemId) as {id:number;source_registry_id:number;external_id:string;canonical_url:string|null;source_url:string|null;group_id:string|null;group_name:string|null;
          author_external_id:string|null;author_name:string|null;author_url:string|null;published_at:string|null;content_hash:string|null;media_hash:string|null;first_seen_at:string;last_seen_at:string}|undefined;
      if(!source){out.needsGlobalMatch++;continue;}
      const price=num(facts.price)??(sourceItemId===candidate.representativeSourceItemId?candidate.price:null);
      const currency=asText(facts.currency)||candidate.currency;
      const priceCents=price===null?null:Math.round((currency==='KHR'?price/4000:price)*100);
      let occurrenceId=existing?.occurrence_id;
      if(existing){
        this.db.prepare(`UPDATE canonical_listing_source_occurrences SET last_seen_at=?,content_hash=?,media_hash=?,price_seen=?,currency_seen=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND is_current=1`)
          .run(source.last_seen_at,source.content_hash,source.media_hash,priceCents,currency,existing.occurrence_id);
        out.bindingsUpdated++;
      }else{
        const cluster=this.db.prepare(`SELECT c.cluster_key FROM dedupe_clusters c JOIN dedupe_cluster_members m ON m.cluster_id=c.id
          WHERE c.algorithm_version=? AND c.entity_type='SUPPLY_REPOST' AND m.source_item_id=? LIMIT 1`).get(this.repostAlgorithmVersion,sourceItemId) as {cluster_key:string}|undefined;
        const insert=this.db.prepare(`INSERT INTO canonical_listing_source_occurrences
          (source_item_id,listing_id,source_registry_id,external_id,source_url,group_id,group_name,author_external_id,author_name,author_url,posted_at,first_seen_at,last_seen_at,content_hash,media_hash,price_seen,currency_seen,repost_cluster_id,source_entity_key,is_current)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(source_item_id,source_entity_key) WHERE is_current=1 DO NOTHING`);
        insert.run(sourceItemId,listingId,source.source_registry_id,source.external_id,source.canonical_url??source.source_url,source.group_id,source.group_name,
          source.author_external_id,source.author_name,source.author_url,source.published_at,source.first_seen_at,source.last_seen_at,source.content_hash,source.media_hash,priceCents,currency,cluster?.cluster_key??null,this.algorithmVersion);
        const row=this.db.prepare(`SELECT id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND source_entity_key=? AND is_current=1`).get(sourceItemId,this.algorithmVersion) as {id:number};
        occurrenceId=row.id;out.occurrencesAttached++;
      }
      const occurrenceCount=this.db.prepare(`SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE listing_id=? AND source_entity_key=? AND is_current=1`).get(listingId,this.algorithmVersion) as {n:number};
      const mayUpdateListing=occurrenceCount.n===1||listing.primary_source_occurrence_id===occurrenceId;
      if(mayUpdateListing){
        this.db.prepare(`UPDATE canonical_listings SET price=COALESCE(?,price),currency=COALESCE(?,currency),
          title=COALESCE(?,title),description=COALESCE(?,description),listing_facts_json=?,last_seen_at=MAX(last_seen_at,?),
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
          .run(priceCents,currency,asText(facts.title_en)||null,asText(facts.description_en)||null,JSON.stringify(facts),source.last_seen_at,listingId);
      }else this.db.prepare(`UPDATE canonical_listings SET last_seen_at=MAX(last_seen_at,?),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(source.last_seen_at,listingId);
      if(listing.property_id!==null)this.db.prepare(`UPDATE canonical_properties SET last_observed_at=MAX(COALESCE(last_observed_at,''),?),
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(source.last_seen_at,listing.property_id);
      this.reconcileMediaForSourceItem(sourceItemId,occurrenceId??null,listingId,listing.property_id,candidate.photoAssets.filter((photo)=>photo.sourceItemId===sourceItemId),observedAt);
      out.processed++;
    }
    return out;
  }

  private reconcileMediaForSourceItem(sourceItemId:number,occurrenceId:number|null,listingId:number,propertyId:number|null,photos:ListingCandidatePhoto[],observedAt:string):void{
    const urls=new Set(photos.map((photo)=>normalizedUrl(photo.sourceUrl)).filter(Boolean));
    const joins=this.db.prepare('SELECT media_asset_id FROM media_asset_source_occurrences WHERE source_item_id=?').all(sourceItemId) as Array<{media_asset_id:number}>;
    this.db.prepare('DELETE FROM media_asset_source_occurrences WHERE source_item_id=?').run(sourceItemId);
    for(const old of joins)if(!urls.size||!photos.some((photo)=>normalizedUrl(photo.sourceUrl)===((this.db.prepare('SELECT normalized_url FROM media_assets WHERE id=?').get(old.media_asset_id) as {normalized_url:string|null}|undefined)?.normalized_url)))
      this.db.prepare('DELETE FROM media_assets WHERE id=? AND source_item_id=?').run(old.media_asset_id,sourceItemId);
    const asset=this.db.prepare(`INSERT INTO media_assets(source_item_id,source_occurrence_id,listing_id,property_id,source_url,normalized_url,perceptual_hash,hash_algorithm,hash_version,download_status,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,'dhash',1,?,?,?) ON CONFLICT(normalized_url) WHERE normalized_url IS NOT NULL DO UPDATE SET
      perceptual_hash=COALESCE(media_assets.perceptual_hash,excluded.perceptual_hash),last_seen_at=MAX(media_assets.last_seen_at,excluded.last_seen_at),
      download_status=CASE WHEN COALESCE(media_assets.perceptual_hash,excluded.perceptual_hash) IS NULL THEN 'pending' ELSE 'downloaded' END,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
    const join=this.db.prepare(`INSERT INTO media_asset_source_occurrences(media_asset_id,source_item_id,source_occurrence_id,listing_id,property_id)
      VALUES(?,?,?,?,?) ON CONFLICT(media_asset_id,source_item_id) DO UPDATE SET source_occurrence_id=excluded.source_occurrence_id,listing_id=excluded.listing_id,property_id=excluded.property_id`);
    for(const photo of photos){const url=normalizedUrl(photo.sourceUrl);if(!url)continue;const seen=observedTimestamps(this.db,sourceItemId);asset.run(sourceItemId,occurrenceId,listingId,propertyId,photo.sourceUrl,url,photo.perceptualHash,photo.perceptualHash?'downloaded':'pending',seen.firstSeenAt,observedAt);const row=this.db.prepare('SELECT id FROM media_assets WHERE normalized_url=?').get(url) as {id:number};join.run(row.id,sourceItemId,occurrenceId,listingId,propertyId);}
  }

  auditCrossSourceCartesian(): CanonicalCalibrationReport {
    const candidates=new ListingCandidateBuilder(this.db,this.repostAlgorithmVersion).build();
    const fb=candidates.filter((candidate)=>candidate.sourceType==='FACEBOOK_GROUP');
    const k24=candidates.filter((candidate)=>candidate.sourceType==='KHMER24');
    const retrieved=this.retrieveCandidates(fb,k24);
    const excluded:CanonicalCalibrationPair[]=[];
    let selectedPropertyScoreAtLeast070=0;
    let cartesianPHashComparisons=0;let cartesianPHashMatches=0;let excludedPhotoMatchPairs=0;let selectedPhotoMatchPairs=0;
    for(const a of fb)for(const b of k24){
      const key=`${a.candidateId}|${b.candidateId}`;
      const selected=retrieved.has(key);
      const imageStats=imageMatches(a.photoAssets,b.photoAssets);
      cartesianPHashComparisons+=imageStats.comparisons;cartesianPHashMatches+=imageStats.matches.length;
      if(imageStats.matches.length){if(selected)selectedPhotoMatchPairs++;else excludedPhotoMatchPairs++;}
      const score=scorePair(a,b,retrieved.get(key)?.retrievedBy??new Set<string>(),imageStats);
      if(selected){if(score.propertyScore>=0.70)selectedPropertyScoreAtLeast070++;continue;}
      excluded.push({
        candidateA:a.candidateId,candidateB:b.candidateId,sourceItemA:a.representativeSourceItemId,sourceItemB:b.representativeSourceItemId,
        titleA:text(fact(a,'title_en'))||a.normalizedText.slice(0,220),titleB:text(fact(b,'title_en'))||b.normalizedText.slice(0,220),
        priceA:a.price,priceB:b.price,currencyA:a.currency,currencyB:b.currency,offerTypeA:a.offerType,offerTypeB:b.offerType,
        locationA:text(fact(a,'sangkat','explicit_location','location')),locationB:text(fact(b,'sangkat','explicit_location','location')),
        bedroomsA:num(fact(a,'bedrooms')),bedroomsB:num(fact(b,'bedrooms')),bathroomsA:num(fact(a,'bathrooms')),bathroomsB:num(fact(b,'bathrooms')),
        propertyTypeA:text(fact(a,'property_type','category')),propertyTypeB:text(fact(b,'property_type','category')),
        propertyScore:score.propertyScore,listingScore:score.listingScore,propertyFamilies:score.propertyFamilies,listingFamilies:score.listingFamilies,
        sharedIdentifiers:score.sharedIdentifiers,photoMatchCount:score.matchedPhotos.length,reasons:score.reasons,decision:score.decision,
        selectedByProductionRetrieval:false,retrievalSignals:directRetrievalSignals(a,b),
      });
    }
    excluded.sort((a,b)=>b.propertyScore-a.propertyScore||b.listingScore-a.listingScore||a.candidateA.localeCompare(b.candidateA)||a.candidateB.localeCompare(b.candidateB));
    return{algorithmVersion:this.algorithmVersion,facebookCandidates:fb.length,khmer24Candidates:k24.length,cartesianPairs:fb.length*k24.length,
      productionSelectedPairs:retrieved.size,excludedPairs:fb.length*k24.length-retrieved.size,cartesianPHashComparisons,cartesianPHashMatches,
      excludedPhotoMatchPairs,selectedPhotoMatchPairs,
      excludedPropertyScoreAtLeast070:excluded.filter((entry)=>entry.propertyScore>=0.70).length,
      excludedPropertyScoreAtLeast060:excluded.filter((entry)=>entry.propertyScore>=0.60).length,
      selectedPropertyScoreAtLeast070,humanPositiveRecallAt070:null,excludedTop50:excluded.slice(0,50)};
  }

  evaluateGoldenPairs(goldenPairs:CanonicalGoldenPairInput[]):CanonicalGoldenEvaluation {
    const candidates=new ListingCandidateBuilder(this.db,this.repostAlgorithmVersion).build();
    const byId=new Map(candidates.map((candidate)=>[candidate.candidateId,candidate]));
    const fb=candidates.filter((candidate)=>candidate.sourceType==='FACEBOOK_GROUP');
    const k24=candidates.filter((candidate)=>candidate.sourceType==='KHMER24');
    const retrieved=this.retrieveCandidates(fb,k24);
    const pairs=goldenPairs.map((gold)=>{
      const a=byId.get(gold.candidateA);const b=byId.get(gold.candidateB);
      if(!a||!b)throw new Error(`Golden pair references missing candidate: ${gold.candidateA} ↔ ${gold.candidateB}`);
      if(a.sourceType===b.sourceType)throw new Error(`Golden pair is not cross-source: ${gold.candidateA} ↔ ${gold.candidateB}`);
      const key=`${a.candidateId}|${b.candidateId}`;const selected=retrieved.get(key);
      const score=scorePair(a,b,selected?.retrievedBy??new Set<string>(),imageMatches(a.photoAssets,b.photoAssets));
      return{candidateA:a.candidateId,candidateB:b.candidateId,humanLabel:gold.humanLabel,decision:score.decision,
        propertyScore:Number(score.propertyScore.toFixed(3)),listingScore:Number(score.listingScore.toFixed(3)),
        propertyFamilies:score.propertyFamilies,listingFamilies:score.listingFamilies,photoMatchCount:score.matchedPhotos.length,
        photoHammingDistances:score.matchedPhotos.map((match)=>match.distance),selectedByProductionRetrieval:Boolean(selected),reasons:score.reasons};
    });
    return{algorithmVersion:this.algorithmVersion,goldenPairCount:pairs.length,pairs};
  }

  private retrieveCandidates(fb: ListingCandidate[],k24: ListingCandidate[]): Map<string,CandidatePair> {
    const candidates = new Map<string,CandidatePair>();
    const add = (a: ListingCandidate,b: ListingCandidate,signal: string) => {
      const key = `${a.candidateId}|${b.candidateId}`;
      const pair = candidates.get(key) ?? { a,b,retrievedBy:new Set<string>() }; pair.retrievedBy.add(signal); candidates.set(key,pair);
    };
    const bucket = new Map<string,{fb:ListingCandidate[];k24:ListingCandidate[]}>();
    const put = (key:string,candidate:ListingCandidate) => { const entry=bucket.get(key)??{fb:[],k24:[]};entry[candidate.sourceType==='FACEBOOK_GROUP'?'fb':'k24'].push(candidate);bucket.set(key,entry); };
    const index = (candidate:ListingCandidate) => {
      for (const identifier of candidate.identifiers) put(`identifier:${identifier.type}:${identifier.value.toLowerCase()}`,candidate);
      const city=norm(fact(candidate,'city')); const area=norm(fact(candidate,'sangkat','explicit_location','location'));
      const type=norm(fact(candidate,'property_type','category')); const beds=num(fact(candidate,'bedrooms'));
      if(city&&area)put(`location:${city}:${area}`,candidate);
      if(city&&area&&type&&beds!==null)put(`structured:${city}:${area}:${type}:${beds}`,candidate);
      const priceBucket=candidatePriceBucket(candidate); if(city&&area&&priceBucket)put(`price:${city}:${area}:${type}:${priceBucket}`,candidate);
      for(const token of candidateTokens(candidate))put(`token:${token}`,candidate);
      for(const photo of candidate.photoAssets) if(photo.perceptualHash&&/^[01]{64}$/.test(photo.perceptualHash))for(let band=0;band<8;band++)put(`phash:${band}:${photo.perceptualHash.slice(band*8,band*8+8)}`,candidate);
    };
    [...fb,...k24].forEach(index);
    for(const [signal,entry] of bucket){
      const left=[...new Map(entry.fb.map((c)=>[c.candidateId,c])).values()].sort((a,b)=>a.candidateId.localeCompare(b.candidateId));
      const right=[...new Map(entry.k24.map((c)=>[c.candidateId,c])).values()].sort((a,b)=>a.candidateId.localeCompare(b.candidateId));
      if(!left.length||!right.length)continue;
      if(left.length*right.length<=64){for(const a of left)for(const b of right)add(a,b,signal);}
      else {
        const a0=left[0]!,b0=right[0]!;
        for(const a of left)add(a,b0,signal);
        for(const b of right)add(a0,b,signal);
      }
    }
    return candidates;
  }

  private groups(candidates:ListingCandidate[],union:UnionFind):Array<{key:string;candidates:ListingCandidate[]}>{
    const map=new Map<string,ListingCandidate[]>();for(const candidate of candidates){const root=union.find(candidate.candidateId);const group=map.get(root)??[];group.push(candidate);map.set(root,group);}
    return [...map.values()].map((members)=>{members.sort((a,b)=>a.candidateId.localeCompare(b.candidateId));return{key:stableHash(members.map((x)=>x.candidateId).join('|')),candidates:members};}).sort((a,b)=>a.key.localeCompare(b.key));
  }

  private buildCanonicalGroups(candidates:ListingCandidate[],properties:Array<{key:string;candidates:ListingCandidate[]}>,listings:Array<{key:string;candidates:ListingCandidate[]}>) {
    const rebindKey=(group:{key:string;candidates:ListingCandidate[]})=>{
      if(group.candidates.length!==1)return group.key;
      const candidate=group.candidates[0]!;
      const historical=this.db.prepare(`SELECT 1 FROM canonical_listing_source_occurrences WHERE source_entity_key=? AND source_item_id IN (${candidate.sourceItemIds.map(()=>'?').join(',')}) AND is_current=0 LIMIT 1`)
        .get(this.algorithmVersion,...candidate.sourceItemIds);
      return historical?stableHash(`${group.key}|rebind:${candidate.contentHash??candidate.representativeSourceItemId}`):group.key;
    };
    const propertyGroups=properties.map((group)=>({...group,key:rebindKey(group)}));
    const listingGroups=listings.map((group)=>({...group,key:rebindKey(group)}));
    const propertyKeyByCandidate=new Map<string,string>();for(const group of propertyGroups)for(const candidate of group.candidates)propertyKeyByCandidate.set(candidate.candidateId,group.key);
    const propertyByKey=new Map(propertyGroups.map((group)=>[group.key,group]));
    const listingData=listingGroups.map((group)=>({key:group.key,candidates:group.candidates,propertyKey:propertyKeyByCandidate.get(group.candidates[0]!.candidateId)!}));
    const photos=new Map<string,ListingCandidatePhoto>();for(const candidate of candidates)for(const photo of candidate.photoAssets){const key=normalizedUrl(photo.sourceUrl);if(!key)continue;const old=photos.get(key);photos.set(key,{...photo,sourceUrl:key,perceptualHash:old?.perceptualHash??photo.perceptualHash});}
    return {properties:propertyGroups,listings:listingData,propertyByKey,photos:[...photos.values()]};
  }

  private examples(decisions:PersistedDecision[]):CanonicalShadowReport['examples']{
    const result:CanonicalShadowReport['examples']={SAME_LISTING:[],SAME_PROPERTY_DIFFERENT_LISTING:[],POSSIBLE_SAME_PROPERTY:[],DIFFERENT_PROPERTY:[]};
    for(const decision of decisions){const a=decision.a,b=decision.b;result[decision.decision].push({
      candidateA:a.candidateId,candidateB:b.candidateId,sourceA:a.sourceType,sourceB:b.sourceType,
      snippetA:text(fact(a,'title_en'))||a.normalizedText.slice(0,220),snippetB:text(fact(b,'title_en'))||b.normalizedText.slice(0,220),
      priceA:a.price,currencyA:a.currency,priceB:b.price,currencyB:b.currency,
      offerTypeA:a.offerType,offerTypeB:b.offerType,
      locationA:fact(a,'sangkat','explicit_location','location'),locationB:fact(b,'sangkat','explicit_location','location'),
      bedroomsA:fact(a,'bedrooms'),bedroomsB:fact(b,'bedrooms'),contacts:decision.sharedIdentifiers.filter((id)=>/^(PHONE|TELEGRAM|WHATSAPP|EMAIL):/.test(id)),
      codes:decision.sharedIdentifiers.filter((id)=>/^(PROPERTY_CODE|AGENCY_CODE):/.test(id)),photoMatchCount:decision.matchedPhotos.length,
      propertyFamilies:decision.propertyFamilies,listingFamilies:decision.listingFamilies,
      photoHammingDistances:decision.matchedPhotos.map((match)=>match.distance),
      retrievedBy:decision.retrievedBy,
      propertyScore:Number(decision.propertyScore.toFixed(3)),listingScore:Number(decision.listingScore.toFixed(3)),reasons:decision.reasons,decision:decision.decision,
    });}
    for(const type of Object.keys(result) as CanonicalDecision[]){
      const max=type==='SAME_PROPERTY_DIFFERENT_LISTING'?10:type==='DIFFERENT_PROPERTY'?40:5;
      result[type]=result[type].sort((a,b)=>Number(b.propertyScore)-Number(a.propertyScore)).slice(0,max);
    }
    return result;
  }

  private persist(candidates:ListingCandidate[],decisions:PersistedDecision[],data:ReturnType<CanonicalShadowService['buildCanonicalGroups']>):{canonicalProperties:number;canonicalListings:number;sourceOccurrences:number;mediaAssets:number}{
    this.db.exec('SAVEPOINT canonical_shadow_build');
    try{
      const upsertProperty=this.db.prepare(`INSERT INTO canonical_properties
        (city,sangkat,canonical_address,explicit_location,property_type,bedrooms,bathrooms,building_name,unit_identifier,property_fingerprint,algorithm_version,canonical_key,first_observed_at,last_observed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(algorithm_version,canonical_key) WHERE canonical_key IS NOT NULL DO UPDATE SET
        city=excluded.city,sangkat=excluded.sangkat,canonical_address=excluded.canonical_address,explicit_location=excluded.explicit_location,
        property_type=excluded.property_type,bedrooms=excluded.bedrooms,bathrooms=excluded.bathrooms,building_name=excluded.building_name,
        unit_identifier=excluded.unit_identifier,property_fingerprint=excluded.property_fingerprint,first_observed_at=excluded.first_observed_at,
        last_observed_at=excluded.last_observed_at,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
      const propertyId=(key:string)=> (this.db.prepare('SELECT id FROM canonical_properties WHERE algorithm_version=? AND canonical_key=?').get(this.algorithmVersion,key) as {id:number}).id;
      for(const group of data.properties){
        const sorted=[...group.candidates].sort((a,b)=>representativeScore(b)-representativeScore(a)||a.representativeSourceItemId-b.representativeSourceItemId);const best=sorted[0]!;
        const cityValue=norm(fact(best,'city'));const city=cityValue.includes('siem reap')||cityValue.includes('siem_reap')?'siem_reap':cityValue.includes('phnom penh')||cityValue.includes('phnom_penh')?'phnom_penh':null;
        const timestamps=group.candidates.flatMap((candidate)=>candidate.sourceItemIds.map((id)=>observedTimestamps(this.db,id)));
        const first=[...timestamps.map((x)=>x.firstSeenAt)].sort()[0]??best.firstSeenAt;const last=[...timestamps.map((x)=>x.lastSeenAt)].sort().at(-1)??best.lastSeenAt;
        const memberIds=group.candidates.flatMap((candidate)=>candidate.sourceItemIds);
        const bound=this.db.prepare(`SELECT DISTINCT l.property_id FROM canonical_listing_source_occurrences o JOIN canonical_listings l ON l.id=o.listing_id
          WHERE o.source_entity_key=? AND o.is_current=1 AND o.source_item_id IN (${memberIds.map(()=>'?').join(',')}) AND l.property_id IS NOT NULL ORDER BY l.property_id`)
          .all(this.algorithmVersion,...memberIds) as Array<{property_id:number}>;
        if(bound.length===1)this.db.prepare('UPDATE canonical_properties SET canonical_key=? WHERE id=?').run(group.key,bound[0]!.property_id);
        upsertProperty.run(city,sqlValue(fact(best,'sangkat','location')),sqlValue(fact(best,'explicit_location','location')),sqlValue(fact(best,'explicit_location')),sqlValue(fact(best,'property_type')),num(fact(best,'bedrooms')),num(fact(best,'bathrooms')),sqlValue(fact(best,'building_name')),sqlValue(fact(best,'unit_identifier')),group.key,this.algorithmVersion,group.key,first,last);
      }
      const upsertListing=this.db.prepare(`INSERT INTO canonical_listings
        (property_id,public_ref,status,availability_status,price,currency,title,description,property_type,category,bedrooms,bathrooms,min_lease_months,lease_term_text,deposit_amount,deposit_months,pet_friendly,amenities,restrictions,electricity_type,electricity_rate,water_type,water_rate,city,sangkat,explicit_location,first_seen_at,last_seen_at,dedupe_confidence,listing_facts_json,content_hash,algorithm_version,canonical_key)
        VALUES(?,?, 'active','unknown',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(algorithm_version,canonical_key) WHERE canonical_key IS NOT NULL DO UPDATE SET
        property_id=excluded.property_id,price=excluded.price,currency=excluded.currency,title=excluded.title,description=excluded.description,
        property_type=excluded.property_type,category=excluded.category,bedrooms=excluded.bedrooms,bathrooms=excluded.bathrooms,
        min_lease_months=excluded.min_lease_months,lease_term_text=excluded.lease_term_text,deposit_amount=excluded.deposit_amount,
        deposit_months=excluded.deposit_months,pet_friendly=excluded.pet_friendly,amenities=excluded.amenities,restrictions=excluded.restrictions,
        electricity_type=excluded.electricity_type,electricity_rate=excluded.electricity_rate,water_type=excluded.water_type,water_rate=excluded.water_rate,
        city=excluded.city,sangkat=excluded.sangkat,explicit_location=excluded.explicit_location,first_seen_at=excluded.first_seen_at,
        last_seen_at=excluded.last_seen_at,dedupe_confidence=excluded.dedupe_confidence,listing_facts_json=excluded.listing_facts_json,
        content_hash=excluded.content_hash,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
      for(const group of data.listings){
        const best=[...group.candidates].sort((a,b)=>representativeScore(b)-representativeScore(a)||a.representativeSourceItemId-b.representativeSourceItemId)[0]!;
        const timestamps=group.candidates.flatMap((candidate)=>candidate.sourceItemIds.map((id)=>observedTimestamps(this.db,id)));
        const first=[...timestamps.map((x)=>x.firstSeenAt)].sort()[0]??best.firstSeenAt;const last=[...timestamps.map((x)=>x.lastSeenAt)].sort().at(-1)??best.lastSeenAt;
        const cityValue=norm(fact(best,'city'));const city=cityValue.includes('siem reap')||cityValue.includes('siem_reap')?'siem_reap':cityValue.includes('phnom penh')||cityValue.includes('phnom_penh')?'phnom_penh':null;
        const contentHash=best.contentHash;
        const matched=decisions.filter((entry)=>group.candidates.some((c)=>c.candidateId===entry.a.candidateId)&&group.candidates.some((c)=>c.candidateId===entry.b.candidateId));
        const confidence=matched.length?Math.max(...matched.map((entry)=>entry.listingScore)):null;
        const facts=best.facts;
        const memberIds=group.candidates.flatMap((candidate)=>candidate.sourceItemIds);
        const bound=this.db.prepare(`SELECT DISTINCT o.listing_id FROM canonical_listing_source_occurrences o
          WHERE o.source_entity_key=? AND o.is_current=1 AND o.source_item_id IN (${memberIds.map(()=>'?').join(',')}) AND o.listing_id IS NOT NULL ORDER BY o.listing_id`)
          .all(this.algorithmVersion,...memberIds) as Array<{listing_id:number}>;
        if(bound.length===1)this.db.prepare('UPDATE canonical_listings SET canonical_key=? WHERE id=?').run(group.key,bound[0]!.listing_id);
        upsertListing.run(propertyId(group.propertyKey),crypto.randomBytes(16).toString('hex').replace(/^/,'lst_'),best.price?Math.round(best.price*100):null,best.currency,text(fact(best,'title_en'))||best.normalizedText.slice(0,220)||`Listing ${best.representativeSourceItemId}`,
          text(fact(best,'description_en'))||best.normalizedText,sqlValue(fact(best,'property_type')),sqlValue(fact(best,'category'))||null,num(fact(best,'bedrooms')),num(fact(best,'bathrooms')),
          num(fact(best,'min_lease_months','min_lease')),text(fact(best,'lease_term_text'))||null,num(fact(best,'deposit_amount','deposit')),num(fact(best,'deposit_months')),
          typeof fact(best,'pet_friendly')==='boolean'?Number(fact(best,'pet_friendly')):null,JSON.stringify(fact(best,'discovered_amenities')??fact(best,'amenities')??[]),
          JSON.stringify(fact(best,'restrictions')??[]),sqlValue(fact(best,'electricity_type')),sqlValue(fact(best,'electricity_rate')),sqlValue(fact(best,'water_type')),sqlValue(fact(best,'water_rate')),city,
          sqlValue(fact(best,'sangkat','location')),sqlValue(fact(best,'explicit_location')),first,last,confidence,JSON.stringify(facts),contentHash,this.algorithmVersion,group.key);
      }
      const propertyIdByCandidate=new Map<string,number>();for(const group of data.properties)for(const candidate of group.candidates)propertyIdByCandidate.set(candidate.candidateId,propertyId(group.key));
      const listingIdByCandidate=new Map<string,number>();for(const group of data.listings){const id=(this.db.prepare('SELECT id FROM canonical_listings WHERE algorithm_version=? AND canonical_key=?').get(this.algorithmVersion,group.key) as {id:number}).id;for(const candidate of group.candidates)listingIdByCandidate.set(candidate.candidateId,id);}
      for(const [candidateId,listingId] of listingIdByCandidate){
        const ref=(this.db.prepare('SELECT public_ref FROM canonical_listings WHERE id=?').get(listingId) as {public_ref:string}).public_ref;
        this.db.prepare(`INSERT OR IGNORE INTO canonical_listing_aliases(namespace,alias,listing_id) VALUES('canonical_listing_id',?,?)`).run(String(listingId),listingId);
        this.db.prepare(`INSERT OR IGNORE INTO canonical_listing_aliases(namespace,alias,listing_id) VALUES('public_listing_ref',?,?)`).run(ref,listingId);
        this.db.prepare(`INSERT OR IGNORE INTO canonical_listing_moderation(listing_id,review_status) VALUES(?,'pending')`).run(listingId);
        const candidate=data.listings.flatMap((group)=>group.candidates).find((entry)=>entry.candidateId===candidateId);
        for(const sourceItemId of candidate?.sourceItemIds??[]){
          const legacyRows=this.db.prepare(`SELECT p.id,p.review_status,p.review_reason FROM properties p JOIN source_items s ON p.original_url=s.canonical_url OR p.source_url=s.source_url WHERE s.id=?`).all(sourceItemId) as Array<{id:number;review_status:string;review_reason:string|null}>;
          for(const legacy of legacyRows)this.db.prepare(`INSERT OR IGNORE INTO canonical_listing_aliases(namespace,alias,listing_id) VALUES('legacy_property_id',?,?)`).run(String(legacy.id),listingId);
          const attachableLegacyRows=legacyRows.filter((legacy)=>{
            const owner=this.db.prepare(`SELECT listing_id FROM canonical_listing_aliases WHERE namespace='legacy_property_id' AND alias=?`).get(String(legacy.id)) as {listing_id:number}|undefined;
            return owner?.listing_id===listingId;
          });
          const hasLegacyAliasConflict=attachableLegacyRows.length!==legacyRows.length;
          if(legacyRows.length&&hasLegacyAliasConflict){
            // Never let a canonical Listing inherit legacy approval when its
            // numeric alias is already bound elsewhere or could not be stored.
            this.db.prepare(`UPDATE canonical_listing_moderation SET review_status='pending',
              review_reason='Legacy identity alias conflict; manual review required',decision_origin='DEFAULT_PENDING',
              updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
              WHERE listing_id=? AND decision_origin='MIGRATED_LEGACY' AND review_status='approved'`).run(listingId);
          }else if(attachableLegacyRows.length){
            const statuses=new Set(attachableLegacyRows.map((row)=>row.review_status));
            const status=statuses.has('rejected')?'rejected':statuses.has('pending')?'pending':'approved';
            const reason=statuses.size>1?'Conflicting legacy moderation states; conservative policy applied':attachableLegacyRows.map((row)=>row.review_reason).find(Boolean)??null;
            this.db.prepare(`UPDATE canonical_listing_moderation SET review_status=?,review_reason=?,decision_origin='MIGRATED_LEGACY',updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
              WHERE listing_id=? AND decision_origin NOT IN ('EXPLICIT_CANONICAL','INGESTION_VALIDATED_V1')`).run(status,reason,listingId);
          }
        }
      }
      const decisionIds=new Map<string,number>();
      const upsertDecision=this.db.prepare(`INSERT INTO dedupe_decisions(candidate_a_type,candidate_a_id,candidate_b_type,candidate_b_id,decision,property_score,listing_score,reasons_json,details_json,algorithm_version)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(algorithm_version,candidate_a_type,candidate_a_id,candidate_b_type,candidate_b_id) DO UPDATE SET
        decision=excluded.decision,property_score=excluded.property_score,listing_score=excluded.listing_score,reasons_json=excluded.reasons_json,details_json=excluded.details_json`);
      const selectDecision=this.db.prepare(`SELECT id FROM dedupe_decisions WHERE algorithm_version=? AND candidate_a_type=? AND candidate_a_id=? AND candidate_b_type=? AND candidate_b_id=?`);
      const liveDecisionKeys=new Set<string>();
      for(const entry of decisions){
        const low=Math.min(entry.a.representativeSourceItemId,entry.b.representativeSourceItemId);const high=Math.max(entry.a.representativeSourceItemId,entry.b.representativeSourceItemId);
        const aType='SOURCE_ITEM',bType='SOURCE_ITEM';const key=`${aType}:${low}:${bType}:${high}`;liveDecisionKeys.add(key);
        const details={propertyFamilies:entry.propertyFamilies,listingFamilies:entry.listingFamilies,retrievedBy:entry.retrievedBy,sharedIdentifiers:entry.sharedIdentifiers,
          matchedPhotos:entry.matchedPhotos,textSimilarity:entry.textSimilarity,thresholds:DECISION_THRESHOLDS};
        upsertDecision.run(aType,low,bType,high,entry.decision,entry.propertyScore,entry.listingScore,JSON.stringify(entry.reasons),JSON.stringify(details),this.algorithmVersion);
        const row=selectDecision.get(this.algorithmVersion,aType,low,bType,high) as {id:number};decisionIds.set(key,row.id);
      }
      const oldDecisionRows=this.db.prepare('SELECT id,candidate_a_type,candidate_a_id,candidate_b_type,candidate_b_id FROM dedupe_decisions WHERE algorithm_version=?').all(this.algorithmVersion) as Array<{id:number;candidate_a_type:string;candidate_a_id:number;candidate_b_type:string;candidate_b_id:number}>;
      const deleteDecision=this.db.prepare('DELETE FROM dedupe_decisions WHERE id=?');for(const row of oldDecisionRows)if(!liveDecisionKeys.has(`${row.candidate_a_type}:${row.candidate_a_id}:${row.candidate_b_type}:${row.candidate_b_id}`))deleteDecision.run(row.id);
      const occurrenceInsert=this.db.prepare(`INSERT INTO canonical_listing_source_occurrences
        (source_item_id,listing_id,source_registry_id,external_id,source_url,group_id,group_name,author_external_id,author_name,author_url,posted_at,first_seen_at,last_seen_at,content_hash,media_hash,price_seen,currency_seen,discovery_credit,discovery_rank,repost_cluster_id,dedupe_decision_id,dedupe_method,dedupe_score,source_entity_key,property_discovery_credit)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_item_id,source_entity_key) WHERE is_current=1 DO UPDATE SET
        listing_id=excluded.listing_id,source_registry_id=excluded.source_registry_id,external_id=excluded.external_id,source_url=excluded.source_url,
        group_id=excluded.group_id,group_name=excluded.group_name,author_external_id=excluded.author_external_id,author_name=excluded.author_name,
        author_url=excluded.author_url,posted_at=excluded.posted_at,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,
        content_hash=excluded.content_hash,media_hash=excluded.media_hash,price_seen=excluded.price_seen,currency_seen=excluded.currency_seen,discovery_credit=excluded.discovery_credit,
        discovery_rank=excluded.discovery_rank,repost_cluster_id=excluded.repost_cluster_id,dedupe_decision_id=excluded.dedupe_decision_id,
        dedupe_method=excluded.dedupe_method,dedupe_score=excluded.dedupe_score,property_discovery_credit=excluded.property_discovery_credit,
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
      const sourceRows=this.db.prepare(`SELECT id,source_registry_id,external_id,canonical_url,source_url,group_id,group_name,author_external_id,author_name,author_url,published_at,content_hash,media_hash,raw_payload_json FROM source_items WHERE id=?`);
      const sourceOccurrenceIds=new Map<number,number>();
      const occurrenceOrder=candidates.flatMap((candidate)=>candidate.sourceItemIds.map((sourceItemId)=>({candidate,sourceItemId,...observedTimestamps(this.db,sourceItemId)}))).sort((a,b)=>a.firstSeenAt.localeCompare(b.firstSeenAt)||a.sourceItemId-b.sourceItemId);
      const propertyFirst=new Map<number,number>();const listingFirst=new Map<number,number>();
      for(const entry of occurrenceOrder){
        const propertyIdValue=propertyIdByCandidate.get(entry.candidate.candidateId)!;const listingIdValue=listingIdByCandidate.get(entry.candidate.candidateId)!;
        if(!propertyFirst.has(propertyIdValue))propertyFirst.set(propertyIdValue,entry.sourceItemId);if(!listingFirst.has(listingIdValue))listingFirst.set(listingIdValue,entry.sourceItemId);
      }
      const bestDecisionByCandidate=new Map<number,PersistedDecision>();for(const entry of decisions){for(const id of [entry.a.representativeSourceItemId,entry.b.representativeSourceItemId]){const prior=bestDecisionByCandidate.get(id);if(!prior||entry.propertyScore+entry.listingScore>prior.propertyScore+prior.listingScore)bestDecisionByCandidate.set(id,entry);}}
      const occurrenceKeys=new Set<string>();
      for(const entry of occurrenceOrder){
        const sourceItemId=entry.sourceItemId;const candidate=entry.candidate;const source=sourceRows.get(sourceItemId) as Record<string,unknown>;
        const propertyIdValue=propertyIdByCandidate.get(candidate.candidateId)!;
        let itemFacts=candidate.facts;if(sourceItemId!==candidate.representativeSourceItemId)itemFacts=getFactsForSourceItem(this.db,sourceItemId);
        const rawPrice=sourceItemId===candidate.representativeSourceItemId?candidate.price:num(itemFacts.price);
        const currency=sourceItemId===candidate.representativeSourceItemId?candidate.currency:itemFacts.currency==='USD'||itemFacts.currency==='KHR'?itemFacts.currency:null;
        const price=rawPrice===null?null:sourceItemId===candidate.representativeSourceItemId?Math.round(rawPrice*100):Math.round((currency==='KHR'?rawPrice/4000:rawPrice)*100);
        const best=bestDecisionByCandidate.get(candidate.representativeSourceItemId);let decisionId:number|null=null;let method:string|null=null;let score:number|null=null;
        if(best){const low=Math.min(best.a.representativeSourceItemId,best.b.representativeSourceItemId);const high=Math.max(best.a.representativeSourceItemId,best.b.representativeSourceItemId);const key=`SOURCE_ITEM:${low}:SOURCE_ITEM:${high}`;decisionId=decisionIds.get(key)??null;method=best.decision;score=best.propertyScore;}
        const listingIdValue=listingIdByCandidate.get(candidate.candidateId)!;
        occurrenceInsert.run(sourceItemId,listingIdValue,Number(source.source_registry_id),sqlValue(source.external_id),sqlValue(source.canonical_url??source.source_url),sqlValue(source.group_id),sqlValue(source.group_name),
          sqlValue(source.author_external_id),sqlValue(source.author_name),sqlValue(source.author_url),sqlValue(source.published_at),entry.firstSeenAt,entry.lastSeenAt,sqlValue(source.content_hash),sqlValue(source.media_hash),price,currency,
          listingFirst.get(listingIdValue)===sourceItemId?1:0,listingFirst.get(listingIdValue)===sourceItemId?1:null,candidate.repostClusterId,decisionId,method,score,this.algorithmVersion,
          propertyFirst.get(propertyIdValue)===sourceItemId?1:0);
      const occurrence=this.db.prepare('SELECT id FROM canonical_listing_source_occurrences WHERE source_item_id=? AND source_entity_key=? AND is_current=1').get(sourceItemId,this.algorithmVersion) as {id:number};sourceOccurrenceIds.set(sourceItemId,occurrence.id);
      }
      const staleOccurrences=this.db.prepare('SELECT source_item_id FROM canonical_listing_source_occurrences WHERE source_entity_key=? AND is_current=1 AND source_item_id NOT IN (SELECT id FROM source_items WHERE classification=\'HOUSING_SUPPLY\')').all(this.algorithmVersion) as Array<{source_item_id:number}>;
      const sourceRepo=new SourceIngestionRepository(this.db);
      for(const row of staleOccurrences)sourceRepo.closeCurrentCanonicalBindings(row.source_item_id,this.algorithmVersion,new Date().toISOString());
      const updatePrimary=this.db.prepare(`UPDATE canonical_listings SET primary_source_occurrence_id=(SELECT o.id FROM canonical_listing_source_occurrences o WHERE o.listing_id=canonical_listings.id AND o.source_entity_key=? AND o.is_current=1 ORDER BY o.first_seen_at,o.id LIMIT 1) WHERE algorithm_version=?`);updatePrimary.run(this.algorithmVersion,this.algorithmVersion);
      const upsertMedia=this.db.prepare(`INSERT INTO media_assets(source_item_id,source_occurrence_id,listing_id,property_id,source_url,normalized_url,perceptual_hash,hash_algorithm,hash_version,download_status,first_seen_at,last_seen_at)
        VALUES(?,?,?,?,?,?,?,'dhash',1,?,?,?) ON CONFLICT(normalized_url) WHERE normalized_url IS NOT NULL DO UPDATE SET
        perceptual_hash=COALESCE(media_assets.perceptual_hash,excluded.perceptual_hash),hash_algorithm='dhash',hash_version=1,
        first_seen_at=MIN(media_assets.first_seen_at,excluded.first_seen_at),last_seen_at=MAX(media_assets.last_seen_at,excluded.last_seen_at),
        download_status=CASE WHEN COALESCE(media_assets.perceptual_hash,excluded.perceptual_hash) IS NULL THEN 'pending' ELSE 'downloaded' END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
      const mediaJoin=this.db.prepare(`INSERT INTO media_asset_source_occurrences(media_asset_id,source_item_id,source_occurrence_id,listing_id,property_id)
        VALUES(?,?,?,?,?) ON CONFLICT(media_asset_id,source_item_id) DO UPDATE SET source_occurrence_id=excluded.source_occurrence_id,listing_id=excluded.listing_id,property_id=excluded.property_id`);
      for(const candidate of candidates){for(const photo of candidate.photoAssets){const url=normalizedUrl(photo.sourceUrl);if(!url)continue;
        const occurrenceId=sourceOccurrenceIds.get(photo.sourceItemId)??null;const listingIdValue=listingIdByCandidate.get(candidate.candidateId)!;const propertyIdValue=propertyIdByCandidate.get(candidate.candidateId)!;
        const seen=observedTimestamps(this.db,photo.sourceItemId);const status=photo.perceptualHash?'downloaded':'pending';
        upsertMedia.run(photo.sourceItemId,occurrenceId,listingIdValue,propertyIdValue,photo.sourceUrl,url,photo.perceptualHash,status,seen.firstSeenAt,seen.lastSeenAt);
        const media=this.db.prepare('SELECT id FROM media_assets WHERE normalized_url=?').get(url) as {id:number};mediaJoin.run(media.id,photo.sourceItemId,occurrenceId,listingIdValue,propertyIdValue);
      }}
      const counts={canonicalProperties:this.db.prepare('SELECT COUNT(*) n FROM canonical_properties WHERE algorithm_version=?').get(this.algorithmVersion) as {n:number},canonicalListings:this.db.prepare('SELECT COUNT(*) n FROM canonical_listings WHERE algorithm_version=?').get(this.algorithmVersion) as {n:number},sourceOccurrences:this.db.prepare('SELECT COUNT(*) n FROM canonical_listing_source_occurrences WHERE source_entity_key=? AND is_current=1').get(this.algorithmVersion) as {n:number},mediaAssets:this.db.prepare('SELECT COUNT(*) n FROM media_assets').get() as {n:number}};
      this.db.exec('RELEASE canonical_shadow_build');
      return{canonicalProperties:counts.canonicalProperties.n,canonicalListings:counts.canonicalListings.n,sourceOccurrences:counts.sourceOccurrences.n,mediaAssets:counts.mediaAssets.n};
    }catch(error){this.db.exec('ROLLBACK TO canonical_shadow_build');this.db.exec('RELEASE canonical_shadow_build');throw error;}
  }
}
