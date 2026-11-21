import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'homeasy_web_saved_v1';
const REF_A = `lst_${'a'.repeat(32)}`;
const REF_B = `lst_${'b'.repeat(32)}`;
const REF_C = `lst_${'c'.repeat(32)}`;

type SavedStore = typeof import('./saved-store');
let store: SavedStore;

describe('browser Saved references', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
    store = await import('./saved-store');
  });

  it('starts empty when no saved state exists', () => {
    expect(store.readWebSavedRefs()).toEqual([]);
    expect(store.isWebSavedRef(REF_A)).toBe(false);
  });

  it('persists canonical publicRefs across module reloads', async () => {
    expect(store.setWebSavedRef(REF_A, true)).toEqual([REF_A]);
    expect(store.setWebSavedRef(REF_B, true)).toEqual([REF_A, REF_B]);
    expect(store.isWebSavedRef(REF_A)).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([REF_A, REF_B]);

    vi.resetModules();
    store = await import('./saved-store');
    expect(store.readWebSavedRefs()).toEqual([REF_A, REF_B]);
  });

  it('deduplicates saves and supports idempotent removal', () => {
    store.setWebSavedRef(REF_A, true);
    expect(store.setWebSavedRef(REF_A, true)).toEqual([REF_A]);
    expect(store.setWebSavedRef(REF_A, false)).toEqual([]);
    expect(store.setWebSavedRef(REF_A, false)).toEqual([]);
    expect(store.isWebSavedRef(REF_A)).toBe(false);
  });

  it('sanitizes stored arrays, keeps first occurrence order and persists the cleaned refs on update', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      REF_B, null, REF_A, REF_B, 123, {}, 'lst_123', REF_C,
      REF_A.toUpperCase(), ` ${REF_A}`, '42', '__proto__',
    ]));

    expect(store.readWebSavedRefs()).toEqual([REF_B, REF_A, REF_C]);
    expect(store.setWebSavedRef(REF_B, false)).toEqual([REF_A, REF_C]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([REF_A, REF_C]);
  });

  it.each(['{broken', 'null', '{}', '"hello"', '42'])('recovers from corrupt or incompatible stored value %s', (value) => {
    localStorage.setItem(STORAGE_KEY, value);
    expect(store.readWebSavedRefs()).toEqual([]);
    expect(store.setWebSavedRef(REF_A, true)).toEqual([REF_A]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([REF_A]);
  });

  it('rejects invalid publicRefs without mutating storage', () => {
    store.setWebSavedRef(REF_A, true);
    const before = localStorage.getItem(STORAGE_KEY);
    for (const invalid of ['', '123', 'lst_123', REF_A.toUpperCase(), ` ${REF_A}`, `${REF_A}x`, '../favorites', null, 1]) {
      expect(store.setWebSavedRef(invalid as string, true)).toEqual([REF_A]);
      expect(store.isWebSavedRef(invalid as string)).toBe(false);
    }
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
  });

  it('rereads the stored list to observe changes from another tab', () => {
    store.setWebSavedRef(REF_A, true);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([REF_C]));
    expect(store.isWebSavedRef(REF_A)).toBe(false);
    expect(store.readWebSavedRefs()).toEqual([REF_C]);
    expect(store.setWebSavedRef(REF_B, true)).toEqual([REF_C, REF_B]);
  });

  it('still keeps valid stale refs until App decides whether the listing is available', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([REF_A, REF_C]));
    expect(store.readWebSavedRefs()).toEqual([REF_A, REF_C]);
  });

  it('uses in-memory Saved when storage reads and writes are blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    expect(store.readWebSavedRefs()).toEqual([]);
    expect(store.setWebSavedRef(REF_A, true)).toEqual([REF_A]);
    expect(store.isWebSavedRef(REF_A)).toBe(true);
    expect(store.setWebSavedRef(REF_A, false)).toEqual([]);
  });

  it('preserves in-memory changes if reading works but writes fail (quota or privacy mode)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([REF_A]));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    expect(store.setWebSavedRef(REF_B, true)).toEqual([REF_A, REF_B]);
    expect(store.readWebSavedRefs()).toEqual([REF_A, REF_B]);
    expect(store.isWebSavedRef(REF_B)).toBe(true);
  });

  it('survives unavailable localStorage access altogether (SSR or restricted browser)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => { throw new DOMException('Denied', 'SecurityError'); },
    });
    try {
      expect(store.setWebSavedRef(REF_C, true)).toEqual([REF_C]);
      expect(store.readWebSavedRefs()).toEqual([REF_C]);
      expect(store.isWebSavedRef(REF_C)).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    }
  });
});
