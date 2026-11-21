const STORAGE_KEY = 'homeasy_web_saved_v1';
const PUBLIC_REF_PATTERN = /^lst_[a-f0-9]{32}$/;

// If browser storage is blocked or full, Saved still works until the page reloads.
let fallbackRefs: string[] = [];
let pendingWrite = false;

function isPublicRef(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_REF_PATTERN.test(value);
}

function normalizeRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const refs: string[] = [];
  const seen = new Set<string>();
  for (const valueRef of value) {
    if (!isPublicRef(valueRef) || seen.has(valueRef)) continue;
    seen.add(valueRef);
    refs.push(valueRef);
  }
  return refs;
}

/** Read references only. App is responsible for re-fetching listings and handling stale ones. */
export function readWebSavedRefs(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (pendingWrite) return [...fallbackRefs];

    let parsed: unknown;
    try {
      parsed = raw === null ? [] : JSON.parse(raw);
    } catch {
      parsed = [];
    }
    fallbackRefs = normalizeRefs(parsed);
    return [...fallbackRefs];
  } catch {
    return [...fallbackRefs];
  }
}

/** Add or remove a canonical publicRef, returning the updated set in insertion order. */
export function setWebSavedRef(ref: string, saved: boolean): string[] {
  const current = readWebSavedRefs();
  if (!isPublicRef(ref)) return current;

  const next = saved
    ? (current.includes(ref) ? current : [...current, ref])
    : current.filter((item) => item !== ref);
  fallbackRefs = next;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    pendingWrite = false;
  } catch {
    pendingWrite = true;
  }
  return [...next];
}

export function isWebSavedRef(ref: string): boolean {
  return isPublicRef(ref) && readWebSavedRefs().includes(ref);
}
