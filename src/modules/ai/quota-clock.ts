const pacificDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Gemini RPD is per project and resets at midnight Pacific, including DST changes. */
export function pacificDay(at: number): string { return pacificDate.format(new Date(at)); }

export function nextPacificMidnight(now: number): number {
  const today = pacificDay(now);
  let low = now;
  let high = now + 27 * 60 * 60_000; // A Pacific calendar day can be 25 hours.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (pacificDay(middle) === today) low = middle;
    else high = middle;
  }
  return high;
}

export function utcDay(at: number): string { return new Date(at).toISOString().slice(0, 10); }

export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
