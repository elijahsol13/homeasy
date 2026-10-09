import { env } from '../../config/env';

export type ListingReadPath = 'legacy' | 'canonical';

/** Global canonical mode remains available for an explicitly approved full cutover. */
export function listingReadPathForUser(telegramUserId?: number): ListingReadPath {
  if (env.LISTING_READ_PATH === 'canonical') return 'canonical';
  if (telegramUserId !== undefined && env.CANONICAL_READ_CANARY_TELEGRAM_IDS.includes(telegramUserId)) {
    return 'canonical';
  }
  return 'legacy';
}

export function isCanonicalReadCanary(telegramUserId?: number): boolean {
  return env.LISTING_READ_PATH === 'legacy'
    && telegramUserId !== undefined
    && env.CANONICAL_READ_CANARY_TELEGRAM_IDS.includes(telegramUserId);
}
