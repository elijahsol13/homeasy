/** Inspect a Khmer24 detail document, not merely its HTTP status. */
export function classifyKhmer24DetailLiveness(
  html: string,
  expectedAdId?: string,
): 'alive' | 'dead' | 'unknown' {
  if (!html.trim()) return 'unknown';

  // Khmer24 can serve a 200 tombstone with neither a Product nor a Nuxt post.
  if (/the product you are looking for is sold out\s*\(or deleted\)/i.test(html) ||
      /this (?:ad|listing|post) (?:is|was) (?:no longer available|removed|deleted|expired)/i.test(html) ||
      /(?:ad|listing) has (?:been removed|expired)/i.test(html)) return 'dead';

  if (/just a moment|attention required|cloudflare.*challenge/i.test(html)) return 'unknown';

  const ldScripts = html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, contents] of ldScripts) {
    try {
      const raw: unknown = JSON.parse(contents!);
      const entries = Array.isArray(raw) ? raw : [raw];
      if (entries.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const product = item as Record<string, unknown>;
        if (product['@type'] !== 'Product') return false;
        // A generic Product without an identifiable SKU cannot prove that the
        // requested ad still exists (the SSR post below may still prove it).
        return expectedAdId
          ? product.sku != null && String(product.sku) === expectedAdId
          : typeof product.name === 'string' && product.name.trim().length > 0;
      })) return 'alive';
    } catch { /* malformed structured data cannot confirm a live post */ }
  }

  const nuxt = /<script\b(?=[^>]*\bid\s*=\s*["']__NUXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (nuxt) {
    try {
      const nodes: unknown = JSON.parse(nuxt[1]!);
      if (Array.isArray(nodes)) {
        const resolve = (value: unknown): unknown => typeof value === 'number' &&
          Number.isSafeInteger(value) && value >= 0 && value < nodes.length ? nodes[value] : value;
        for (const node of nodes) {
          if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
          const post = node as Record<string, unknown>;
          const id = resolve(post.id);
          const postedDate = resolve(post.posted_date);
          const status = resolve(post.status);
          const available = resolve(post.available);
          if (id == null || typeof postedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(postedDate)) continue;
          if (expectedAdId && String(id) !== expectedAdId) continue;
          if (status === 'active' && (available === 1 || available === true)) return 'alive';
        }
      }
    } catch { /* malformed Nuxt data is inconclusive */ }
  }

  // A 200 landing page, error shell or removed post lacking a recognizable
  // tombstone is inconclusive. In particular, never mark a shell as alive.
  return 'unknown';
}
