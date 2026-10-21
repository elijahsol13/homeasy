/** Exact source-URL boundary used by the planner, executor and isolated broker. */
export function safeKhmer24Url(raw: string | null): string | null {
  if (!raw) return null;
  // Validate the original bytes before URL(), which can silently normalize
  // backslashes, dot segments, escapes, spaces, and default ports.
  if (!/^https:\/\/(?:www\.)?khmer24\.com\/(?:en\/)?[a-z0-9_-]+-adid-[1-9][0-9]*\/?$/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['khmer24.com', 'www.khmer24.com'].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port || url.href !== raw) return null;
    return raw;
  } catch { return null; }
}
