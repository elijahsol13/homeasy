import { normalizePhoneNumber } from './normalizer';
import type { SourceIdentifierInput } from '../../database/repositories/source-ingestion.repo';

function normalizeMapsUrl(raw: string): string | null {
  try {
    const url = new URL(raw.replace(/[),.;]+$/g, ''));
    if (!/(^|\.)google\.[^/]+$|^maps\.app\.goo\.gl$|^goo\.gl$/i.test(url.hostname)) return null;
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function addUnique(target: Map<string, SourceIdentifierInput>, identifier: SourceIdentifierInput): void {
  if (!identifier.normalizedValue) return;
  const key = `${identifier.type}:${identifier.normalizedValue}`;
  if (!target.has(key)) target.set(key, identifier);
}

export function extractDeterministicMetadata(text: string, hints?: {
  phoneNumbers?: string[];
  mapsUrls?: string[];
  telegramLinks?: string[];
}): SourceIdentifierInput[] {
  const found = new Map<string, SourceIdentifierInput>();
  const source = text ?? '';

  for (const match of source.matchAll(/(?:\+?855|0)[1-9]\d{1,2}(?:[\s().-]*\d){6,8}/g)) {
    const raw = match[0].trim();
    const normalized = normalizePhoneNumber(raw);
    if (normalized && normalized.length >= 10 && normalized.length <= 12) {
      addUnique(found, { type: 'PHONE', rawValue: raw, normalizedValue: `+${normalized}` });
    }
  }
  for (const raw of hints?.phoneNumbers ?? []) {
    const normalized = normalizePhoneNumber(raw);
    if (normalized && normalized.length >= 10 && normalized.length <= 12) {
      addUnique(found, { type: 'PHONE', rawValue: raw, normalizedValue: `+${normalized}` });
    }
  }

  const telegramHandles = new Set<string>();
  for (const match of source.matchAll(/(?:https?:\/\/)?(?:www\.)?t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,31})/gi)) {
    telegramHandles.add(match[1]!.toLowerCase());
  }
  for (const match of source.matchAll(/(?:telegram|\btg\b)[^\n]{0,48}?@([a-zA-Z][a-zA-Z0-9_]{4,31})/gi)) {
    telegramHandles.add(match[1]!.toLowerCase());
  }
  for (const handle of telegramHandles) {
    addUnique(found, { type: 'TELEGRAM', rawValue: `@${handle}`, normalizedValue: `@${handle}` });
  }
  for (const link of hints?.telegramLinks ?? []) {
    const match = /(?:https?:\/\/)?(?:www\.)?t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,31})/i.exec(link);
    if (match?.[1]) {
      const handle = match[1].toLowerCase();
      addUnique(found, { type: 'TELEGRAM', rawValue: link, normalizedValue: `@${handle}` });
    }
  }

  for (const match of source.matchAll(/(?:https?:\/\/)?(?:www\.)?wa\.me\/(\+?\d{8,15})/gi)) {
    const normalized = normalizePhoneNumber(match[1]);
    if (normalized) addUnique(found, { type: 'WHATSAPP', rawValue: match[1]!, normalizedValue: `+${normalized}` });
  }
  for (const match of source.matchAll(/(?:whatsapp|whats\s*app|wa)\s*(?:[:：]|[-])\s*((?:\+?855|0)[1-9]\d{1,2}(?:[\s().-]*\d){6,8})/gi)) {
    const normalized = normalizePhoneNumber(match[1]);
    if (normalized) addUnique(found, { type: 'WHATSAPP', rawValue: match[1]!.trim(), normalizedValue: `+${normalized}` });
  }

  for (const match of source.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    addUnique(found, { type: 'EMAIL', rawValue: match[0], normalizedValue: match[0].toLowerCase() });
  }

  const codePatterns: Array<{ type: 'PROPERTY_CODE' | 'AGENCY_CODE'; pattern: RegExp }> = [
    { type: 'PROPERTY_CODE', pattern: /\b(?:property|listing|house|room|unit)\s*(?:code|id|ref(?:erence)?|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,23})\b/gi },
    { type: 'AGENCY_CODE', pattern: /\b(?:agency|agent|company)\s*(?:code|id|ref(?:erence)?|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,23})\b/gi },
  ];
  for (const { type, pattern } of codePatterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1]!;
      addUnique(found, { type, rawValue: raw, normalizedValue: raw.toUpperCase() });
    }
  }

  const mapsUrls = new Set<string>();
  for (const match of source.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const normalized = normalizeMapsUrl(match[0]);
    if (normalized) mapsUrls.add(normalized);
  }
  for (const raw of hints?.mapsUrls ?? []) {
    const normalized = normalizeMapsUrl(raw);
    if (normalized) mapsUrls.add(normalized);
  }
  for (const url of mapsUrls) {
    addUnique(found, { type: 'MAPS_URL', rawValue: url, normalizedValue: url });
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    const explicitPlaceId = parsed.searchParams.get('query_place_id') ?? parsed.searchParams.get('place_id');
    const pathPlaceId = /!1s(ChIJ[A-Za-z0-9_-]{10,})/.exec(decodeURIComponent(parsed.pathname))?.[1];
    const placeId = explicitPlaceId ?? pathPlaceId;
    if (placeId) addUnique(found, { type: 'MAPS_PLACE_ID', rawValue: placeId, normalizedValue: placeId });
  }

  return [...found.values()].sort((a, b) => a.type.localeCompare(b.type) || a.normalizedValue.localeCompare(b.normalizedValue));
}
