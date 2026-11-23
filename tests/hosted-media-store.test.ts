import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { storeEncodedPhoto } from '../src/modules/media/hosted-media-store';
import { HostedMediaRepository } from '../src/modules/media/hosted-media.repo';

describe('hosted media file store', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('stores one immutable file for repeated bytes and leaves no temporary file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'homeasy-media-'));
    roots.push(root);
    const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } })
      .webp().toBuffer();
    const expectedHash = createHash('sha256').update(webp).digest('hex');

    const [first, replay] = await Promise.all([
      storeEncodedPhoto(root, webp),
      storeEncodedPhoto(root, webp),
    ]);

    expect(first).toEqual({ hash: expectedHash, relativePath: `${expectedHash.slice(0, 2)}/${expectedHash}.webp`, byteLength: webp.length });
    expect(replay).toEqual(first);
    expect(readFileSync(path.join(root, first.relativePath))).toEqual(webp);
    expect(readdirSync(path.join(root, expectedHash.slice(0, 2)))).toEqual([`${expectedHash}.webp`]);
  });

  it('rejects a symlinked media root instead of writing outside the configured directory', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'homeasy-media-'));
    roots.push(parent);
    const actual = path.join(parent, 'actual');
    mkdirSync(actual);
    const alias = path.join(parent, 'alias');
    symlinkSync(actual, alias);
    await expect(storeEncodedPhoto(alias, Buffer.from('data'))).rejects.toThrow('Invalid media root');
    expect(readdirSync(actual)).toEqual([]);
  });
});

describe('hosted gallery references', () => {
  it('publishes a complete ordered version while sharing identical file bytes', () => {
    const db = new DatabaseSync(':memory:');
    try {
      runMigrations(db);
      const registryId = Number(db.prepare("INSERT INTO source_registry(source_key,source_type,name) VALUES ('fb:test','FACEBOOK_GROUP','Test')").run().lastInsertRowid);
      const source = (post: string) => Number(db.prepare(
        "INSERT INTO source_items(source_registry_id,source_type,external_id,group_id,classification) VALUES (?,'FACEBOOK_GROUP',?,'123','HOUSING_SUPPLY')",
      ).run(registryId, post).lastInsertRowid);
      const firstSource = source('one');
      const secondSource = source('two');
      const stored = (hash: string) => ({ hash, relativePath: `${hash.slice(0, 2)}/${hash}.webp`, byteLength: 123 });
      const shared = stored('a'.repeat(64));
      const thumb = stored('b'.repeat(64));
      const other = stored('c'.repeat(64));
      const repo = new HostedMediaRepository(db);

      repo.publishGallery(firstSource, '2026-11-23T00:00:00Z', [
        { sourceUrl: 'https://scontent.fbcdn.net/old.jpg', anchorId: 'photo-1', full: shared, thumb },
      ]);
      repo.publishGallery(firstSource, '2026-11-23T01:00:00Z', [
        { sourceUrl: 'https://scontent.fbcdn.net/second.jpg', anchorId: 'photo-2', full: other, thumb },
        { sourceUrl: 'https://scontent.fbcdn.net/new.jpg', anchorId: 'photo-1', full: shared, thumb },
      ]);
      repo.publishGallery(secondSource, '2026-11-23T01:00:00Z', [
        { sourceUrl: 'https://scontent.fbcdn.net/shared.jpg', anchorId: 'photo-1', full: shared, thumb },
      ]);

      expect(repo.getActiveGallery(firstSource).map((photo) => [photo.anchorId, photo.fullHash]))
        .toEqual([['photo-2', other.hash], ['photo-1', shared.hash]]);
      expect(repo.getActiveGallery(secondSource).map((photo) => photo.fullHash)).toEqual([shared.hash]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM hosted_media_files WHERE hash=?').get(shared.hash) as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});
