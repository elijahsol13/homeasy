import { env } from '../src/config/env';
import { isCanonicalReadCanary, listingReadPathForUser } from '../src/modules/api/listing-read-path';

describe('per-user canonical read canary', () => {
  const priorPath = env.LISTING_READ_PATH;
  const priorIds = env.CANONICAL_READ_CANARY_TELEGRAM_IDS;

  afterEach(() => {
    env.LISTING_READ_PATH = priorPath;
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = priorIds;
  });

  it('serves only allowlisted users from canonical while global path stays legacy', () => {
    env.LISTING_READ_PATH = 'legacy';
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [1122334455];

    expect(listingReadPathForUser(1122334455)).toBe('canonical');
    expect(isCanonicalReadCanary(1122334455)).toBe(true);
    expect(listingReadPathForUser(9988776655)).toBe('legacy');
    expect(listingReadPathForUser(undefined)).toBe('legacy');
  });

  it('removing the user from allowlist rolls reads back without database changes', () => {
    env.LISTING_READ_PATH = 'legacy';
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [1122334455];
    expect(listingReadPathForUser(1122334455)).toBe('canonical');

    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
    expect(listingReadPathForUser(1122334455)).toBe('legacy');
    expect(isCanonicalReadCanary(1122334455)).toBe(false);
  });

  it('respects global canonical mode independently from canary membership', () => {
    env.LISTING_READ_PATH = 'canonical';
    env.CANONICAL_READ_CANARY_TELEGRAM_IDS = [];
    expect(listingReadPathForUser(9988776655)).toBe('canonical');
    expect(isCanonicalReadCanary(9988776655)).toBe(false);
  });
});
