import { generateImagePHash, computeHammingDistance } from '../src/modules/parser/phash';
import sharp from 'sharp';

describe('Sharp Perceptual Hash (dHash)', () => {
  describe('computeHammingDistance', () => {
    test('identical hashes return distance 0', () => {
      const h1 = '1111000011110000111100001111000011110000111100001111000011110000';
      const h2 = '1111000011110000111100001111000011110000111100001111000011110000';
      expect(computeHammingDistance(h1, h2)).toBe(0);
    });

    test('hashes with 2 bit differences return distance 2', () => {
      const h1 = '1111000011110000111100001111000011110000111100001111000011110000';
      const h2 = '1111000011110000111100001111000011110000111100001111000011110011';
      expect(computeHammingDistance(h1, h2)).toBe(2);
    });

    test('completely inverted 64-bit hashes return distance 64', () => {
      const h1 = '1'.repeat(64);
      const h2 = '0'.repeat(64);
      expect(computeHammingDistance(h1, h2)).toBe(64);
    });

    test('handles null and mismatched lengths gracefully with Infinity', () => {
      expect(computeHammingDistance(null, '1100')).toBe(Infinity);
      expect(computeHammingDistance('1100', null)).toBe(Infinity);
      expect(computeHammingDistance('11', '1100')).toBe(Infinity);
    });
  });

  describe('generateImagePHash', () => {
    test('returns null for non-http URLs', async () => {
      expect(await generateImagePHash('ftp://example.com/test.jpg')).toBeNull();
      expect(await generateImagePHash('')).toBeNull();
      expect(await generateImagePHash('/local/path.jpg')).toBeNull();
    });

    test('processes image buffer with Sharp to produce 64-bit binary string', async () => {
      // Create sample 200x200 PNG image using sharp
      const sampleImageBuffer = await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 3,
          background: { r: 120, g: 150, b: 200 },
        },
      })
        .png()
        .toBuffer();

      // Mock global fetch to return this sample buffer
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => sampleImageBuffer.buffer.slice(
          sampleImageBuffer.byteOffset,
          sampleImageBuffer.byteOffset + sampleImageBuffer.byteLength
        ),
      } as unknown as Response);

      try {
        const hash = await generateImagePHash('https://example.com/sample.png');
        expect(hash).not.toBeNull();
        expect(typeof hash).toBe('string');
        expect(hash?.length).toBe(64);
        expect(/^[01]{64}$/.test(hash!)).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

