import { Jimp } from 'jimp';

/**
 * Downloads an image from a URL and computes a 64-bit binary Perceptual Hash (pHash).
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

    const image = await Jimp.read(buffer);

    // Generate 64-bit binary pHash (e.g. "10110010...")
    const hash = image.hash(2);
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

