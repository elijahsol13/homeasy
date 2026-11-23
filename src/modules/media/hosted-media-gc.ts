import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inspectRecentBackup } from '../../database/backup-worker';
import { CanonicalListingRepository } from '../../database/repositories/canonical-listing.repo';

const DAY_MS = 86_400_000;
const RETAIN_MS = 90 * DAY_MS;
const HOLD_MS = 14 * DAY_MS;
const BACKUP_NAME = /^homeasy_backup_\d{4}-\d{2}-\d{2}_\d{6}(?:_[\da-f-]+)?\.db$/;
const HASH = /^[0-9a-f]{64}$/;

interface GalleryRow {
  id: number;
  source_item_id: number;
  created_at: string;
  ever_public: number;
  non_public_since: string | null;
  is_active: number;
  purged_at: string | null;
}

interface FileRow {
  hash: string;
  relative_path: string;
  byte_length: number;
  unreferenced_since: string | null;
}

export interface HostedMediaGcOptions {
  db: DatabaseSync;
  mediaRoot: string;
  backupDir: string;
  nowMs?: number;
  dryRun?: boolean;
  limit?: number;
}

export interface HostedMediaGcResult {
  markedGalleries: number;
  purgedGalleries: number;
  deletedFiles: number;
  deletedBytes: number;
  deletedTemporaryFiles: number;
  restoredQuarantineFiles: number;
  deletedUnindexedFiles: number;
  blockedReason?: string;
}

function checkedDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  const info = fs.lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe symlink or path: ${absolute}`);
  }
  // macOS /var points to /private/var; canonicalize ancestors while rejecting
  // a symlink at the configured root or at any hash-prefix directory.
  return fs.realpathSync(absolute);
}

function checkedFile(mediaRoot: string, file: FileRow): string {
  if (!HASH.test(file.hash)
    || file.relative_path !== `${file.hash.slice(0, 2)}/${file.hash}.webp`
    || !Number.isSafeInteger(file.byte_length) || file.byte_length < 1) {
    throw new Error('Invalid hosted media path or metadata');
  }
  const directory = checkedDirectory(path.join(mediaRoot, file.hash.slice(0, 2)));
  const target = path.join(directory, `${file.hash}.webp`);
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== file.byte_length) {
    throw new Error(`Unsafe symlink or inconsistent hosted media file: ${target}`);
  }
  if (createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== file.hash) {
    throw new Error(`Hosted media hash mismatch: ${target}`);
  }
  return target;
}

function sweepFileResidue(
  db: DatabaseSync, mediaRoot: string, nowMs: number, dryRun: boolean,
  limit: number, result: HostedMediaGcResult,
): number {
  let actions = 0;
  const byHash = db.prepare(`SELECT hash,relative_path,byte_length,unreferenced_since
    FROM hosted_media_files WHERE hash=?`);
  for (const entry of fs.readdirSync(mediaRoot, { withFileTypes: true })) {
    if (actions >= limit) break;
    if (!/^[0-9a-f]{2}$/.test(entry.name)) continue;
    const directory = checkedDirectory(path.join(mediaRoot, entry.name));
    for (const candidate of fs.readdirSync(directory)) {
      if (actions >= limit) break;
      const partial = /^\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/.test(candidate);
      const quarantine = /^([0-9a-f]{64})\.webp\.gc-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.exec(candidate);
      const content = /^([0-9a-f]{64})\.webp$/.exec(candidate);
      if (!partial && !quarantine && !content) continue;
      const hash = quarantine?.[1] ?? content?.[1];
      if (hash && hash.slice(0, 2) !== entry.name) throw new Error('Unsafe hosted media residue path');
      const file = path.join(directory, candidate);
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unsafe media residue path: ${file}`);
      const row = hash ? byHash.get(hash) as FileRow | undefined : undefined;
      if (quarantine && row) {
        if (row.relative_path !== `${hash!.slice(0, 2)}/${hash}.webp`
          || row.byte_length !== info.size
          || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) {
          throw new Error(`Inconsistent media quarantine: ${file}`);
        }
        const target = path.join(directory, `${hash}.webp`);
        const targetInfo = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!targetInfo) {
          result.restoredQuarantineFiles++;
          if (!dryRun) fs.renameSync(file, target);
          actions++;
          continue;
        }
        checkedFile(mediaRoot, row);
      }
      const ageMs = nowMs - info.mtimeMs;
      const oldEnough = content ? ageMs >= HOLD_MS : ageMs >= DAY_MS;
      if (!oldEnough) continue;
      if (content && row) continue;
      if (content && createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) {
        throw new Error(`Unindexed media hash mismatch: ${file}`);
      }
      if (content) result.deletedUnindexedFiles++;
      else result.deletedTemporaryFiles++;
      if (!dryRun) fs.unlinkSync(file);
      actions++;
    }
  }
  return actions;
}

function deleteOrphan(db: DatabaseSync, mediaRoot: string, file: FileRow): boolean {
  db.exec('BEGIN IMMEDIATE');
  let quarantine: string | undefined;
  let target: string | undefined;
  let committed = false;
  try {
    // Recheck after acquiring the writer lock: an uploader may have linked
    // this content hash since the gallery transaction committed.
    const current = db.prepare(`SELECT f.hash,f.relative_path,f.byte_length,f.unreferenced_since
      FROM hosted_media_files f WHERE f.hash=? AND f.unreferenced_since=?
      AND NOT EXISTS (SELECT 1 FROM hosted_media_gallery_photos p
        WHERE p.full_hash=f.hash OR p.thumb_hash=f.hash)`)
      .get(file.hash, file.unreferenced_since) as FileRow | undefined;
    if (!current) {
      db.exec('COMMIT');
      return false;
    }
    target = checkedFile(mediaRoot, current);
    quarantine = `${target}.gc-${randomUUID()}`;
    fs.renameSync(target, quarantine);
    db.prepare('DELETE FROM hosted_media_files WHERE hash=?').run(file.hash);
    db.exec('COMMIT');
    committed = true;
  } catch (error) {
    db.exec('ROLLBACK');
    if (quarantine && target && fs.existsSync(quarantine)) fs.renameSync(quarantine, target);
    throw error;
  }
  if (committed) fs.unlinkSync(quarantine!);
  return true;
}

/** The default is an inspection; the backup worker opts into bounded mutation. */
export function runHostedMediaGc(options: HostedMediaGcOptions): HostedMediaGcResult {
  const { db, backupDir } = options;
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun ?? true;
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid GC batch limit');
  if (!Number.isFinite(nowMs)) throw new Error('Invalid GC clock');
  const result: HostedMediaGcResult = { markedGalleries: 0, purgedGalleries: 0, deletedFiles: 0, deletedBytes: 0,
    deletedTemporaryFiles: 0, restoredQuarantineFiles: 0, deletedUnindexedFiles: 0 };
  const rootInfo = fs.lstatSync(options.mediaRoot, { throwIfNoEntry: false });
  if (!rootInfo) {
    const indexed = db.prepare('SELECT EXISTS(SELECT 1 FROM hosted_media_files) AS has_files').get() as { has_files: number };
    const galleries = db.prepare('SELECT EXISTS(SELECT 1 FROM hosted_media_galleries) AS has_galleries').get() as { has_galleries: number };
    if (indexed.has_files || galleries.has_galleries) throw new Error('Indexed hosted media root is missing');
    return result;
  }
  const mediaRoot = checkedDirectory(options.mediaRoot);
  const safeBackupDir = checkedDirectory(backupDir);

  const snapshots = fs.readdirSync(safeBackupDir).filter((name) => BACKUP_NAME.test(name)).map((name) => {
    const info = fs.lstatSync(path.join(safeBackupDir, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.mtimeMs > nowMs + 60_000) {
      throw new Error(`Unsafe or invalid backup snapshot: ${name}`);
    }
    return info.mtimeMs;
  });
  const backup = inspectRecentBackup(safeBackupDir, nowMs);
  if (!backup.healthy || snapshots.length === 0) {
    result.blockedReason = backup.reason ?? 'No ordinary backup snapshots';
    return result;
  }
  const oldestSnapshotMs = Math.min(...snapshots);
  const now = new Date(nowMs).toISOString();
  // Hold the SQLite writer lock while deciding visibility and unlinking bytes;
  // another process cannot publish a link to the same hash mid-cleanup.
  if (!dryRun) db.exec('BEGIN IMMEDIATE');
  let transactionOpen = !dryRun;
  try {
  let actions = sweepFileResidue(db, mediaRoot, nowMs, dryRun, limit, result);
  const publicIds = new CanonicalListingRepository(db).listPublicListingIds();
  const publicSources = new Set((db.prepare(`SELECT DISTINCT source_item_id FROM canonical_listing_source_occurrences
    WHERE is_current=1 AND listing_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(publicIds)) as Array<{ source_item_id: number }>).map((row) => row.source_item_id));
  const publicSourceJson = JSON.stringify([...publicSources]);
  const galleries = db.prepare(`SELECT id,source_item_id,created_at,ever_public,non_public_since,is_active,purged_at
    FROM hosted_media_galleries WHERE purged_at IS NULL AND (
      (source_item_id IN (SELECT value FROM json_each(?)) AND (ever_public=0 OR non_public_since IS NOT NULL))
      OR (source_item_id NOT IN (SELECT value FROM json_each(?)) AND (
        non_public_since IS NULL
        OR (is_active=1 AND non_public_since<=?)
        OR (is_active=0 AND non_public_since<=?)
      ))
    ) ORDER BY id LIMIT ?`).all(publicSourceJson, publicSourceJson,
    new Date(nowMs - RETAIN_MS).toISOString(), new Date(nowMs - RETAIN_MS - HOLD_MS).toISOString(), limit - actions) as unknown as GalleryRow[];
  const filesForGallery = db.prepare(`SELECT DISTINCT f.hash,f.relative_path,f.byte_length,f.unreferenced_since
    FROM hosted_media_files f JOIN hosted_media_gallery_photos p
    ON p.full_hash=f.hash OR p.thumb_hash=f.hash WHERE p.gallery_id=?`);
  const activeReferences = db.prepare(`SELECT COUNT(*) AS n FROM hosted_media_gallery_photos p
    JOIN hosted_media_galleries g ON g.id=p.gallery_id
    WHERE (p.full_hash=? OR p.thumb_hash=?) AND g.is_active=1 AND g.purged_at IS NULL`);
  for (const gallery of galleries) {
    if (actions >= limit) break;
    const files = filesForGallery.all(gallery.id) as unknown as FileRow[];
    const isPublic = publicSources.has(gallery.source_item_id);
    const since = gallery.non_public_since ? Date.parse(gallery.non_public_since) : null;
    if ((since !== null && !Number.isFinite(since)) || !Number.isFinite(Date.parse(gallery.created_at))) {
      throw new Error(`Invalid hosted gallery retention timestamp: ${gallery.id}`);
    }
    const reset = isPublic && (gallery.ever_public === 0 || since !== null);
    const start = !isPublic && since === null;
    const startAt = gallery.ever_public ? nowMs : Date.parse(gallery.created_at);
    const effectiveSince = start ? startAt : since;
    const mark = !isPublic && gallery.is_active === 1 && effectiveSince !== null
      && nowMs - effectiveSince >= RETAIN_MS;
    const purge = !isPublic && gallery.is_active === 0 && effectiveSince !== null
      && nowMs - effectiveSince >= RETAIN_MS + HOLD_MS
      && oldestSnapshotMs > effectiveSince + RETAIN_MS;
    if (!reset && !start && !mark && !purge) continue;
    for (const file of files) checkedFile(mediaRoot, file);
    if (reset) {
      if (!dryRun) {
        db.prepare('UPDATE hosted_media_galleries SET ever_public=1,non_public_since=NULL WHERE id=?').run(gallery.id);
        // A gallery retired at day 90 can serve again until its links are purged.
        const current = db.prepare(`SELECT id FROM hosted_media_galleries
          WHERE source_item_id=? AND is_active=1 AND purged_at IS NULL`).get(gallery.source_item_id);
        if (!current) {
          db.prepare(`UPDATE hosted_media_galleries SET is_active=1 WHERE id=(SELECT MAX(id)
            FROM hosted_media_galleries WHERE source_item_id=? AND purged_at IS NULL)`).run(gallery.source_item_id);
        }
        for (const file of files) db.prepare('UPDATE hosted_media_files SET unreferenced_since=NULL WHERE hash=?').run(file.hash);
      }
    }
    if (start && !dryRun) {
      db.prepare('UPDATE hosted_media_galleries SET non_public_since=? WHERE id=?')
        .run(new Date(startAt).toISOString(), gallery.id);
    }
    if (mark) {
      result.markedGalleries++;
      if (!dryRun) {
        db.prepare('UPDATE hosted_media_galleries SET is_active=0 WHERE id=?').run(gallery.id);
        for (const file of files) {
          const active = activeReferences.get(file.hash, file.hash) as { n: number };
          if (active.n === 0) {
            db.prepare('UPDATE hosted_media_files SET unreferenced_since=COALESCE(unreferenced_since,?) WHERE hash=?')
              .run(now, file.hash);
          }
        }
      }
    }
    if (purge && !dryRun) {
      // All links to this gallery are removed only after the physical hold and rotation.
      // A shared hash stays on disk while any other gallery still references it.
      db.prepare('DELETE FROM hosted_media_gallery_photos WHERE gallery_id=?').run(gallery.id);
      db.prepare('UPDATE hosted_media_galleries SET purged_at=? WHERE id=?').run(now, gallery.id);
      for (const file of files) {
        const links = db.prepare(`SELECT COUNT(*) AS n FROM hosted_media_gallery_photos
          WHERE full_hash=? OR thumb_hash=?`).get(file.hash, file.hash) as { n: number };
        if (links.n === 0) {
          // The pre-GC snapshot from this very worker run still has these
          // links. Start the physical hold only after removing the last link.
          db.prepare('UPDATE hosted_media_files SET unreferenced_since=? WHERE hash=?').run(now, file.hash);
        }
      }
    }
    if (purge) result.purgedGalleries++;
    actions++;
  }
  // A previous run may have removed the last gallery link while an old SQLite
  // snapshot still existed. Revisit orphan bytes after that snapshot rotates.
  const orphans = db.prepare(`SELECT hash,relative_path,byte_length,unreferenced_since
    FROM hosted_media_files f WHERE unreferenced_since IS NOT NULL AND unreferenced_since<=?
    AND NOT EXISTS (SELECT 1 FROM hosted_media_gallery_photos p
      WHERE p.full_hash=f.hash OR p.thumb_hash=f.hash)
    ORDER BY unreferenced_since,hash LIMIT ?`)
    .all(new Date(nowMs - HOLD_MS).toISOString(), limit - actions) as unknown as FileRow[];
  const eligibleOrphans = orphans.filter((file) => {
    const holdStart = Date.parse(file.unreferenced_since!);
    if (!Number.isFinite(holdStart)) throw new Error('Invalid hosted media hold timestamp');
    return nowMs - holdStart >= HOLD_MS && oldestSnapshotMs > holdStart;
  });
  for (const file of eligibleOrphans) checkedFile(mediaRoot, file);
  if (!dryRun) { db.exec('COMMIT'); transactionOpen = false; }
  for (const file of eligibleOrphans) {
    if (dryRun || deleteOrphan(db, mediaRoot, file)) {
      result.deletedFiles++;
      result.deletedBytes += file.byte_length;
    }
  }
  return result;
  } catch (error) {
    if (transactionOpen) db.exec('ROLLBACK');
    throw error;
  }
}
