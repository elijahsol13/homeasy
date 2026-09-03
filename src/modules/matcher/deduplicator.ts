/**
 * High-Accuracy Scoring-Based Deduplication Engine
 *
 * Replaces naive hard-coded phone+location rules with a robust 2-phase deduplication strategy:
 *
 * Phase 1: Multi-Image Perceptual Hash (pHash) Verification
 *  - Computes 64-bit pHash for up to the first 3 images of a listing.
 *  - Trigger 1: If ANY 2 hashes from the new listing match (Hamming distance <= 5)
 *    ANY hashes of an existing listing in the DB, it is a guaranteed duplicate.
 *
 * Phase 2: Weighted Multi-Factor Similarity Scoring
 *  - Compares candidates within the same city and location (Sangkat).
 *  - Points Matrix (Max 90 pts):
 *      • Exact or near price (±5%):         +30 pts
 *      • Exact bedrooms & bathrooms match:   +25 pts
 *      • Same agent phone number:            +20 pts
 *      • Property category match:            +15 pts
 *  - Trigger 2: If total similarity score >= 75 points, it is considered a duplicate.
 */

import type { CleanProperty } from '../parser/schemas';
import type { Property } from '../../database/repositories/properties.repo';
import { computeHammingDistance, generateImagePHash } from '../parser/phash';
import { normalizePhoneNumber } from '../parser/normalizer';
import { PHASH_HAMMING_THRESHOLD } from '../../config/settings';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SimilarityScoreBreakdown {
  price: number;
  bedsBaths: number;
  phone: number;
  category: number;
}

export interface SimilarityScoreResult {
  score: number;
  breakdown: SimilarityScoreBreakdown;
  isDuplicate: boolean;
}

export interface MultiImagePhashResult {
  isMatch: boolean;
  matchCount: number;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  duplicateOfId?: number;
  trigger?: 'multi_phash' | 'similarity_score';
  reason?: string;
  score?: number;
  breakdown?: SimilarityScoreBreakdown;
}

// ─── Phase 1: Multi-Image pHash Computation & Matching ────────────────────────

/**
 * Computes perceptual hashes for up to `maxPhotos` images of a listing.
 */
export async function computeListingPhashes(
  photos: string[],
  maxPhotos = 3,
): Promise<string[]> {
  if (!photos || photos.length === 0) return [];

  const targetPhotos = photos.slice(0, maxPhotos);
  const hashPromises = targetPhotos.map(async (url) => {
    try {
      return await generateImagePHash(url);
    } catch {
      return null;
    }
  });

  const results = await Promise.all(hashPromises);
  return results.filter((h): h is string => typeof h === 'string' && h.length === 64);
}

/**
 * Checks if hashes between two listings match based on Hamming distance.
 * Trigger 1: If 2 or more hashes match (Hamming distance <= threshold), returns true.
 * Also triggers if both listings only have 1 hash and they match.
 */
export function isMultiImagePhashMatch(
  newHashes: string[],
  existingHashes: string[],
  threshold = PHASH_HAMMING_THRESHOLD,
): MultiImagePhashResult {
  if (newHashes.length === 0 || existingHashes.length === 0) {
    return { isMatch: false, matchCount: 0 };
  }

  let matchCount = 0;

  for (const newHash of newHashes) {
    for (const existingHash of existingHashes) {
      const distance = computeHammingDistance(newHash, existingHash);
      if (distance <= threshold) {
        matchCount++;
        break; // matched this new hash with at least one existing hash
      }
    }
  }

  // Guaranteed duplicate if >= 2 images match, or if both only have 1 image and it matches
  const isMatch =
    matchCount >= 2 || (matchCount >= 1 && newHashes.length === 1 && existingHashes.length === 1);

  return { isMatch, matchCount };
}

// ─── Phase 2: Weighted Similarity Scoring ─────────────────────────────────────

/**
 * Calculates a weighted similarity score (0 to 90) between a new listing and an existing property.
 *
 * Scoring Matrix:
 *  - Price ±5%:                         +30
 *  - Exact bedrooms & bathrooms match:  +25
 *  - Same agent phone number:           +20
 *  - Same category (house/apt/room):    +15
 *
 * Threshold for duplicate: >= 75 points.
 */
export function calculateSimilarityScore(
  newProp: CleanProperty,
  existingProp: Property,
): SimilarityScoreResult {
  const breakdown: SimilarityScoreBreakdown = {
    price: 0,
    bedsBaths: 0,
    phone: 0,
    category: 0,
  };

  // 1. Price match (±5%): +30 points
  if (newProp.price > 0 && existingProp.price > 0) {
    const priceDiff = Math.abs(newProp.price - existingProp.price);
    const relativeDiff = priceDiff / existingProp.price;
    if (relativeDiff <= 0.05) {
      breakdown.price = 30;
    }
  }

  // 2. Exact Bedrooms & Bathrooms match: +25 points
  const hasBedsMatch =
    newProp.bedrooms !== null &&
    existingProp.bedrooms !== null &&
    newProp.bedrooms === existingProp.bedrooms;

  const noBathsConflict =
    newProp.bathrooms === null ||
    existingProp.bathrooms === null ||
    newProp.bathrooms === existingProp.bathrooms;

  if (hasBedsMatch && noBathsConflict) {
    breakdown.bedsBaths = 25;
  }

  // 3. Same agent phone number: +20 points
  const newPhone = normalizePhoneNumber(newProp.direct_contact.phone);
  const existingPhone = normalizePhoneNumber(existingProp.direct_contact.phone);

  if (newPhone && existingPhone && newPhone === existingPhone) {
    breakdown.phone = 20;
  }

  // 4. Property category match (apartment/house/room): +15 points
  if (
    newProp.category &&
    existingProp.category &&
    newProp.category === existingProp.category
  ) {
    breakdown.category = 15;
  }

  const score = breakdown.price + breakdown.bedsBaths + breakdown.phone + breakdown.category;
  const isDuplicate = score >= 75;

  return { score, breakdown, isDuplicate };
}

// ─── Master Deduplication Check ───────────────────────────────────────────────

/**
 * Evaluates an incoming listing against existing candidate properties in the same area.
 * Executes Phase 1 (Multi-Image pHash) then Phase 2 (Weighted Similarity Scoring).
 */
export function checkDuplicate(
  newProp: CleanProperty,
  candidates: Property[],
): DuplicateCheckResult {
  const newHashes = newProp.image_phashes.length > 0
    ? newProp.image_phashes
    : newProp.image_phash
      ? [newProp.image_phash]
      : [];

  for (const candidate of candidates) {
    const existingHashes = candidate.image_phashes && candidate.image_phashes.length > 0
      ? candidate.image_phashes
      : candidate.image_phash
        ? [candidate.image_phash]
        : [];

    // ── Check 1: Multi-Image pHash Verification ───────────────────────────────
    if (newHashes.length > 0 && existingHashes.length > 0) {
      const phashResult = isMultiImagePhashMatch(newHashes, existingHashes);
      if (phashResult.isMatch) {
        return {
          isDuplicate: true,
          duplicateOfId: candidate.id,
          trigger: 'multi_phash',
          reason: `Multi-image pHash match (${phashResult.matchCount} photo(s) matched) with listing #${candidate.id}`,
        };
      }
    }

    // ── Check 2: Weighted Similarity Scoring ──────────────────────────────────
    // Candidates are already filtered by city and location (Sangkat)
    const { score, breakdown, isDuplicate } = calculateSimilarityScore(newProp, candidate);
    if (isDuplicate) {
      return {
        isDuplicate: true,
        duplicateOfId: candidate.id,
        trigger: 'similarity_score',
        score,
        breakdown,
        reason: `High similarity score (${score}/90 >= 75) with listing #${candidate.id} [Price:${breakdown.price}, Beds/Baths:${breakdown.bedsBaths}, Phone:${breakdown.phone}, Cat:${breakdown.category}]`,
      };
    }
  }

  return { isDuplicate: false };
}
