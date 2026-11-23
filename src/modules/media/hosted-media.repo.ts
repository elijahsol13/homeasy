import type { DatabaseSync } from 'node:sqlite';
import type { StoredPhoto } from './hosted-media-store';

export interface GalleryPhotoInput {
  sourceUrl: string;
  anchorId: string | null;
  full: StoredPhoto;
  thumb: StoredPhoto;
}

export interface HostedGalleryPhoto {
  ordinal: number;
  sourceUrl: string;
  anchorId: string | null;
  fullHash: string;
  thumbHash: string;
}

interface ActiveGalleryRow {
  id: number;
  captured_at: string;
}

export class HostedMediaRepository {
  constructor(private readonly db: DatabaseSync) {}

  getActiveGallery(sourceItemId: number): HostedGalleryPhoto[] {
    return this.db.prepare(`SELECT p.ordinal, p.source_url AS sourceUrl, p.anchor_id AS anchorId,
      p.full_hash AS fullHash, p.thumb_hash AS thumbHash
      FROM hosted_media_galleries g
      JOIN hosted_media_gallery_photos p ON p.gallery_id=g.id
      WHERE g.source_item_id=? AND g.is_active=1 AND g.purged_at IS NULL
      ORDER BY p.ordinal`).all(sourceItemId) as unknown as HostedGalleryPhoto[];
  }

  publishGallery(sourceItemId: number, capturedAt: string, photos: GalleryPhotoInput[]): number {
    if (!Number.isSafeInteger(sourceItemId) || sourceItemId < 1) throw new Error('Invalid source item');
    if (!Number.isFinite(Date.parse(capturedAt))) throw new Error('Invalid capture time');
    if (photos.length < 1 || photos.length > 50) throw new Error('Invalid gallery length');
    const anchors = photos.map((photo) => photo.anchorId).filter((anchor): anchor is string => Boolean(anchor));
    if (new Set(anchors).size !== anchors.length) throw new Error('Duplicate photo anchor');

    const active = this.db.prepare(`SELECT id,captured_at FROM hosted_media_galleries
      WHERE source_item_id=? AND is_active=1 AND purged_at IS NULL`).get(sourceItemId) as ActiveGalleryRow | undefined;
    if (active) {
      if (Date.parse(capturedAt) < Date.parse(active.captured_at)) throw new Error('Stale gallery upload');
      if (capturedAt === active.captured_at) {
        const current = this.getActiveGallery(sourceItemId);
        if (current.length === photos.length && current.every((row, index) =>
          row.ordinal === index && row.sourceUrl === photos[index].sourceUrl
          && row.anchorId === photos[index].anchorId
          && row.fullHash === photos[index].full.hash
          && row.thumbHash === photos[index].thumb.hash)) return active.id;
        throw new Error('Conflicting gallery capture');
      }
    }

    this.db.exec('SAVEPOINT publish_hosted_gallery');
    try {
      const insertFile = this.db.prepare(`INSERT INTO hosted_media_files(hash,relative_path,byte_length)
        VALUES(?,?,?) ON CONFLICT(hash) DO NOTHING`);
      const getFile = this.db.prepare('SELECT relative_path,byte_length FROM hosted_media_files WHERE hash=?');
      for (const photo of photos) {
        for (const file of [photo.full, photo.thumb]) {
          if (!/^[0-9a-f]{64}$/.test(file.hash)
            || file.relativePath !== `${file.hash.slice(0, 2)}/${file.hash}.webp`
            || !Number.isSafeInteger(file.byteLength) || file.byteLength < 1) {
            throw new Error('Invalid stored media');
          }
          insertFile.run(file.hash, file.relativePath, file.byteLength);
          const existing = getFile.get(file.hash) as { relative_path: string; byte_length: number };
          if (existing.relative_path !== file.relativePath || existing.byte_length !== file.byteLength) {
            throw new Error('Conflicting stored media');
          }
        }
      }
      this.db.prepare('UPDATE hosted_media_galleries SET is_active=0 WHERE source_item_id=? AND is_active=1')
        .run(sourceItemId);
      const id = Number(this.db.prepare(`INSERT INTO hosted_media_galleries(source_item_id,captured_at)
        VALUES(?,?)`).run(sourceItemId, capturedAt).lastInsertRowid);
      const insertPhoto = this.db.prepare(`INSERT INTO hosted_media_gallery_photos
        (gallery_id,ordinal,source_url,anchor_id,full_hash,thumb_hash) VALUES(?,?,?,?,?,?)`);
      for (const [ordinal, photo] of photos.entries()) {
        if (!photo.sourceUrl) throw new Error('Missing source photo URL');
        insertPhoto.run(id, ordinal, photo.sourceUrl, photo.anchorId, photo.full.hash, photo.thumb.hash);
      }
      this.db.exec('RELEASE publish_hosted_gallery');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK TO publish_hosted_gallery');
      this.db.exec('RELEASE publish_hosted_gallery');
      throw error;
    }
  }
}
