import { sourceRoomCounts } from './source-room-counts';

/** A property reference must include an actual numbered identifier; label words are never identifiers. */
export function extractFacebookPropertyCode(text: string): string | null {
  const patterns = [
    /\b(?:original\s*id(?:\s*number)?|property\s*(?:code|id)|listing\s*(?:code|id)|code)\s*(?:[:：=#]|[-–—])?\s*([a-z]{1,8}\s*[-–—]?\s*\d{2,}[a-z0-9-]*|\d{3,}[a-z]{0,6})\b/i,
    /\b(sr\s*[-–—]\s*\d{3,}[a-z]*)\b/i,
  ];
  for (const pattern of patterns) {
    const candidate = pattern.exec(text)?.[1];
    if (candidate) return candidate.toLowerCase().replace(/[\s\-–—]/g, '');
  }
  return null;
}

/** Only copy an AI extraction when the source's independently stated facts match. */
export function facebookRepostFactSignature(text: string): string {
  const rooms = sourceRoomCounts(text);
  const money = /\$\s*([\d,]+(?:\.\d+)?)\b|\b([\d,]+(?:\.\d+)?)\s*(?:usd|dollars?)\b/i.exec(text);
  const price = money ? String(Number((money[1] ?? money[2]).replace(/,/g, ''))) : '?';
  return `beds:${rooms.conflictingBedrooms ? 'conflict' : rooms.bedrooms ?? '?'}|baths:${rooms.conflictingBathrooms ? 'conflict' : rooms.bathrooms ?? '?'}|usd:${price}`;
}

export function facebookRepostCodeKey(text: string): string | null {
  const code = extractFacebookPropertyCode(text);
  return code ? `code|${code}|${facebookRepostFactSignature(text)}` : null;
}
