import sharp from 'sharp';

// Disable libvips caching and restrict concurrency for low-RAM micro instances
sharp.cache(false);
sharp.concurrency(1);

/**
 * Downloads an image from a URL and computes a 64-bit binary Difference Hash (dHash).
 * Uses Sharp to resize to 9x8 grayscale, comparing adjacent pixels across 8 rows.
 * Returns null if the download or image parsing fails.
 */
export async function generateImagePHash(imageUrl: string, timeoutMs = 6000): Promise<string | null> {
  if (!imageUrl || (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://'))) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HomEasyBot/1.0; +https://t.me/homeasy)',
        Accept: 'image/*,*/*',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 100) {
      return null;
    }

    // Resize to 9x8 grayscale raw pixel buffer (72 bytes total)
    const rawBuffer = await sharp(buffer)
      .resize(9, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    if (rawBuffer.length < 72) {
      return null;
    }

    // Compare adjacent horizontal pixels (9 pixels per row -> 8 comparisons * 8 rows = 64 bits)
    let hash = '';
    for (let row = 0; row < 8; row++) {
      const rowOffset = row * 9;
      for (let col = 0; col < 8; col++) {
        const left = rawBuffer[rowOffset + col];
        const right = rawBuffer[rowOffset + col + 1];
        hash += left > right ? '1' : '0';
      }
    }

    return hash;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pHash] Failed to compute hash for ${imageUrl}: ${msg}`);
    return null;
  }
}

/**
 * Computes the Hamming distance (number of differing bits) between two 64-bit binary hashes.
 * Distance <= 5 indicates the two images are visually near-identical / duplicate.
 */
export function computeHammingDistance(hash1: string | null, hash2: string | null): number {
  if (!hash1 || !hash2) return Infinity;
  if (hash1.length !== hash2.length) return Infinity;

  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) {
      distance++;
    }
  }

  return distance;
}

