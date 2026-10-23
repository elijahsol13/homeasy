const ENGLISH_NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const ENGLISH_ROOM_NUMBER = '(?:\\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?)';

export function parseRoomNumber(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/-/g, ' ');
  if (/^\d{1,2}$/.test(normalized)) {
    const parsed = Number(normalized);
    return parsed <= 30 ? parsed : null;
  }
  const parts = normalized.split(/\s+/);
  if (parts[0] === 'twenty' && parts.length === 2 && ENGLISH_NUMBER_WORDS[parts[1]!] !== undefined) {
    return 20 + ENGLISH_NUMBER_WORDS[parts[1]!]!;
  }
  return parts.length === 1 ? ENGLISH_NUMBER_WORDS[normalized] ?? null : null;
}

/** Extract only explicit room counts from the original advert, not AI copy.
 * Ambiguous/multiple contradictory counts remain unknown for manual source QA.
 */
export function sourceRoomCounts(text: string): {
  bedrooms: number | null; bathrooms: number | null;
  conflictingBedrooms: boolean; conflictingBathrooms: boolean;
} {
  // Khmer numerals are frequently used in original Facebook adverts.
  const normalized = text.replace(/[\u200b-\u200d\ufeff]/g, ' ')
    .replace(/[០-៩]/g, digit => String(digit.charCodeAt(0) - 0x17e0));
  const get = (kind: 'bed' | 'bath'): { value: number | null; conflict: boolean } => {
    // Furniture counts ("2 beds") are not numbers of rooms.
    const noun = kind === 'bed' ? 'bed\\s*rooms?|BR' : 'bath\\s*rooms?|baths?';
    const khmerNoun = kind === 'bed' ? 'បន្ទប់គេង' : 'បន្ទប់ទឹក';
    const count = ENGLISH_ROOM_NUMBER;
    const patterns = [
      // A line break separates fields: "Bedroom 02\nBathroom 03" must not
      // interpret 02 as the bathroom count via the number-before-noun pattern.
      new RegExp(`\\b(${count})[ \\t]*[-–]?[ \\t]*(?:${noun})\\b`, 'gi'),
      new RegExp(`\\b(?:number[ \\t]+of[ \\t]+)?(?:${noun})(?:[ \\t]*[:：=-][ \\t]*|[ \\t]+)(${count})\\b`, 'gi'),
      new RegExp(`${khmerNoun}[ \\t]*[:：=-]?[ \\t]*(\\d{1,2})(?!\\d)`, 'g'),
      new RegExp(`(\\d{1,2})[ \\t]*[-–]?[ \\t]*${khmerNoun}`, 'g'),
    ];
    // "Bedrooms: 4 + 1" and "4+1 bedrooms" describe an unspecified mix of
    // rooms. Do not quietly extract one of the numbers as a verified count.
    const compoundPatterns = [
      new RegExp(`\\b(?:${noun})\\s*[:：=-]\\s*\\d{1,2}\\s*\\+\\s*\\d{1,2}\\b`, 'i'),
      new RegExp(`\\b\\d{1,2}\\s*\\+\\s*\\d{1,2}\\s*(?:${noun})\\b`, 'i'),
      new RegExp(`${khmerNoun}\\s*[:：=-]?\\s*\\d{1,2}\\s*\\+\\s*\\d{1,2}`, 'i'),
      new RegExp(`\\d{1,2}\\s*\\+\\s*\\d{1,2}\\s*${khmerNoun}`, 'i'),
    ];
    const values = new Set<number>();
    const oppositeNoun = kind === 'bed' ? 'bath\\s*rooms?|baths?' : 'bed\\s*rooms?|BR';
    const oppositeKhmerNoun = kind === 'bed' ? 'បន្ទប់ទឹក' : 'បន្ទប់គេង';
    const followsOppositeField = (match: RegExpMatchArray): boolean => {
      const index = match.index ?? 0;
      const valueStart = index + match[0].indexOf(match[1]!);
      const prefix = normalized.slice(0, valueStart);
      const labelBeforeValue = new RegExp(`(?:${oppositeNoun}|${oppositeKhmerNoun})[,;\\s]*$`, 'i').test(prefix);
      const precedingOppositeCount = new RegExp(
        `(?:\\b${count}[ \\t]*[-–]?[ \\t]*(?:${oppositeNoun})\\b[,;]?|\\b(?:${oppositeNoun})[ \\t]*[:：=-]?[ \\t]*${count}\\b|${oppositeKhmerNoun}[ \\t]*[:：=-]?[ \\t]*${count})[ \\t]*$`, 'i',
      ).test(prefix);
      return labelBeforeValue && !precedingOppositeCount;
    };
    const numberBeforeNounMatches = [...normalized.matchAll(patterns[0]!)]
      .filter(match => !followsOppositeField(match));
    for (const [patternIndex, re] of patterns.entries()) for (const match of normalized.matchAll(re)) {
      const index = match.index ?? 0;
      if (kind === 'bath' && componentBathroomMention(normalized, index)) continue;
      // In post-noun text "Bedroom 3 Bathroom 2", the 3 belongs to Bedroom.
      // In "3 bedrooms 2 bathrooms", the 2 belongs to Bathroom because the
      // preceding bedroom field already has its own leading count.
      if (patternIndex === 0 && followsOppositeField(match)) continue;
      if (patternIndex === 1 && numberBeforeNounMatches.some(leading => {
        const leadingStart = leading.index ?? 0;
        const leadingEnd = leadingStart + leading[0].length;
        const valueStart = index + match[0].lastIndexOf(match[1]!);
        // Do not parse the bathroom count in "3 bedrooms 2 bathrooms" as
        // another bedroom count from the overlapping "bedrooms 2" match.
        return leadingStart < index + match[0].length && index < leadingEnd && valueStart >= leadingEnd;
      })) continue;
      const value = parseRoomNumber(match[1]!);
      if (value === null) continue;
      if (value >= 0 && value <= 30) values.add(value);
    }
    if (kind === 'bed') {
      // Khmer24 layouts often abbreviate bedrooms as "3 Bed | 4 Bath".
      // Singular "bed" elsewhere may refer to furniture; accept it only in
      // an explicit floor plan or a paired Bed/Bath count, never per-unit items.
      const layoutBed = new RegExp(`\\b(${count})[ \\t]*[-–]?[ \\t]*bed\\b`, 'gi');
      for (const match of normalized.matchAll(layoutBed)) {
        const index = match.index ?? 0;
        if (componentBathroomMention(normalized, index)) continue;
        const lineStart = normalized.lastIndexOf('\n', Math.max(-1, index - 1)) + 1;
        const lineEnd = normalized.indexOf('\n', index);
        const before = normalized.slice(lineStart, index);
        const after = normalized.slice(index + match[0].length, lineEnd < 0 ? normalized.length : lineEnd);
        const inLayout = /\b(?:layout|floor[ \t]+plan|configuration)[ \t]*[:：=-][^\r\n]*$/i.test(before);
        const pairedBath = /^[ \t]*[|,;/&][ \t]*\d{1,2}[ \t]*[-–]?[ \t]*baths?\b/i.test(after);
        if (!inLayout && !pairedBath) continue;
        if (/^[ \t]*(?:[-–][ \t]*)?(?:frames?|mattresses?|sheets?|linen|covers?|sofas?|sets?|included|provided)\b/i.test(after)) continue;
        const value = parseRoomNumber(match[1]!);
        if (value !== null && value >= 0 && value <= 30) values.add(value);
      }
    }
    const conflict = values.size > 1 || compoundPatterns.some(pattern => pattern.test(normalized));
    if (kind === 'bed' && conflict && !compoundPatterns.some(pattern => pattern.test(normalized))) {
      // A villa compound can give its total and then describe its components:
      // "7 Bedrooms", "Main 3-Bedroom Villa", "4 additional Bedrooms".
      // Ignore component counts ONLY when both explicitly qualified parts
      // independently add up to the single remaining source-stated total.
      const main = /\b(?:main|primary)[ \t]+(\d{1,2})[ \t]*[-–]?[ \t]*bed\s*rooms?\b/gi;
      const extra = /\b(\d{1,2})[ \t]+(?:additional|extra)[ \t]+bed\s*rooms?\b/gi;
      const mainMatches = [...normalized.matchAll(main)];
      const extraMatches = [...normalized.matchAll(extra)];
      if (mainMatches.length === 1 && extraMatches.length === 1) {
        const componentSum = Number(mainMatches[0]![1]) + Number(extraMatches[0]![1]);
        if (componentSum > 0 && componentSum <= 30) {
          let withoutComponents = normalized;
          for (const match of [...mainMatches, ...extraMatches].sort((a, b) => b.index! - a.index!)) {
            withoutComponents = withoutComponents.slice(0, match.index!)
              + ' '.repeat(match[0].length)
              + withoutComponents.slice(match.index! + match[0].length);
          }
          const remaining = new Set<number>();
          for (const re of patterns) for (const match of withoutComponents.matchAll(re)) {
            const count = Number(match[1]);
            if (count >= 0 && count <= 30) remaining.add(count);
          }
          if (remaining.size === 1 && remaining.has(componentSum)) {
            return { value: componentSum, conflict: false };
          }
        }
      }
    }
    return { value: !conflict && values.size === 1 ? [...values][0]! : null, conflict };
  };
  const parsedBedrooms = get('bed');
  const bed = parsedBedrooms.value === null && !parsedBedrooms.conflict && /\bstudio\b|ស្ទូឌីយោ/i.test(normalized)
    ? { value: 0, conflict: false } : parsedBedrooms;
  const bath = get('bath');
  return { bedrooms: bed.value, bathrooms: bath.value,
    conflictingBedrooms: bed.conflict, conflictingBathrooms: bath.conflict };
}

/** A count attached to one item in a compound is not the property's total.
 * Ignore only explicitly itemized component lines; a separate aggregate count
 * elsewhere in the source remains authoritative and is still checked. */
function componentBathroomMention(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', Math.max(-1, index - 1)) + 1;
  const newline = text.indexOf('\n', index);
  const line = text.slice(lineStart, newline < 0 ? text.length : newline);
  return /\b\d+\s*[-–]?\s*(?:wood(?:en)?\s+house|(?:separate\s+)?(?:units?|rooms?|bungalows?|houses?|villas?|suites?))\b|\b(?:each|per\s+(?:unit|room|house|villa|bungalow|suite))\b/i.test(line);
}
