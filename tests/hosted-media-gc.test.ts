import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/database/migrate';
import { HostedMediaRepository } from '../src/modules/media/hosted-media.repo';
import { runHostedMediaGc } from '../src/modules/media/hosted-media-gc';

const DAY = 86_400_000;

describe('hosted media retention', () => {
  let root: string;
  let mediaRoot: string;
  let backupDir: string;
  let db: DatabaseSync;
  let nowMs: number;
  let nextId: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeasy-gc-'));
    mediaRoot = path.join(root, 'media');
    backupDir = path.join(root, 'backups');
    fs.mkdirSync(mediaRoot);
    fs.mkdirSync(backupDir);
    db = new DatabaseSync(path.join(root, 'fixture.db'));
    const logs = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try { runMigrations(db); } finally { logs.mockRestore(); }
    nowMs = Date.now();
    nextId = 1;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function snapshot(ageDays: number, name = 'homeasy_backup_2026-11-23_120000.db'): void {
    const file = path.join(backupDir, name);
    fs.writeFileSync(file, 'published SQLite snapshot');
    const at = new Date(nowMs - ageDays * DAY);
    fs.utimesSync(file, at, at);
  }

  function upload(publicStatus: 'approved' | 'pending' | 'none' = 'approved', bytes = 'unique-photo') {
    const id = nextId++;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const relativePath = `${hash.slice(0, 2)}/${hash}.webp`;
    fs.mkdirSync(path.join(mediaRoot, hash.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, relativePath), bytes);
    db.prepare(`INSERT INTO source_registry(id,source_key,source_type,name)
      VALUES(?,'fb:'||?,'FACEBOOK_GROUP','Test')`).run(id, id);
    db.prepare(`INSERT INTO source_items(id,source_registry_id,source_type,external_id,group_id,classification,raw_text,raw_payload_json)
      VALUES(?,?,'FACEBOOK_GROUP',?,'123','HOUSING_SUPPLY','For rent','{}')`).run(id, id, String(id));
    if (publicStatus !== 'none') {
      const occurrence = id + 1000;
      db.prepare(`INSERT INTO canonical_listings(id,public_ref,status,availability_status,title,description,primary_source_occurrence_id,listing_facts_json,first_seen_at,last_seen_at)
        VALUES(?,'lst_'||lower(hex(randomblob(16))),'active','available','For rent','For rent',?,'{"offer_type":"rent"}',?,?)`)
        .run(id, occurrence, new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
      db.prepare(`INSERT INTO canonical_listing_source_occurrences
        (id,source_item_id,listing_id,source_registry_id,first_seen_at,last_seen_at,posted_at,is_current)
        VALUES(?,?,?,?,?,?,?,1)`)
        .run(occurrence, id, id, id, new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
      db.prepare('INSERT INTO canonical_listing_moderation(listing_id,review_status) VALUES(?,?)').run(id, publicStatus);
    }
    const stored = { hash, relativePath, byteLength: Buffer.byteLength(bytes) };
    const galleryId = new HostedMediaRepository(db).publishGallery(id, new Date(nowMs).toISOString(), [
      { sourceUrl: `https://example.test/${id}.jpg`, anchorId: String(id), full: stored, thumb: stored },
    ]);
    return { id, galleryId, hash, file: path.join(mediaRoot, relativePath) };
  }

  function run(dryRun = false, limit = 25) {
    return runHostedMediaGc({ db, mediaRoot, backupDir, nowMs, dryRun, limit });
  }

  it('no-ops before the first upload when the media directory does not exist', () => {
    fs.rmdirSync(mediaRoot);
    snapshot(0);
    expect(run().deletedFiles).toBe(0);
    expect(fs.existsSync(mediaRoot)).toBe(false);
  });

  it('fails closed if the media directory disappears after files were indexed', () => {
    upload();
    fs.rmSync(mediaRoot, { recursive: true });
    snapshot(0);
    expect(() => run()).toThrow();
  });

  it('tracks first nonpublic scan, marks only after 90 full days, and holds bytes for 14 more days', () => {
    const item = upload();
    snapshot(0);
    run();
    db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(item.id);
    run();
    const first = (db.prepare('SELECT non_public_since FROM hosted_media_galleries WHERE id=?').get(item.galleryId) as { non_public_since: string }).non_public_since;
    expect(first).toBe(new Date(nowMs).toISOString());

    nowMs += 89 * DAY;
    snapshot(0);
    expect(run().markedGalleries).toBe(0);
    expect(fs.existsSync(item.file)).toBe(true);

    nowMs += DAY;
    snapshot(0);
    expect(run().markedGalleries).toBe(1);
    expect(db.prepare('SELECT is_active FROM hosted_media_galleries WHERE id=?').get(item.galleryId)).toEqual({ is_active: 0 });
    expect(fs.existsSync(item.file)).toBe(true);

    nowMs += 14 * DAY;
    snapshot(0);
    snapshot(0, 'homeasy_backup_2026-11-23_130000.db');
    expect(run().deletedFiles).toBe(0);
    expect(fs.existsSync(item.file)).toBe(true);
    nowMs += 14 * DAY;
    snapshot(0);
    expect(run().deletedFiles).toBe(0);
    fs.unlinkSync(path.join(backupDir, 'homeasy_backup_2026-11-23_130000.db'));
    expect(run().deletedFiles).toBe(1);
    expect(fs.existsSync(item.file)).toBe(false);
    expect(db.prepare('SELECT id FROM source_items WHERE id=?').get(item.id)).toEqual({ id: item.id });
  });

  it('resets the clock and restores the active gallery when the listing returns before deletion', () => {
    const item = upload();
    snapshot(0);
    db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(item.id);
    run();
    nowMs += 90 * DAY;
    snapshot(0);
    run();
    db.prepare("UPDATE canonical_listing_moderation SET review_status='approved' WHERE listing_id=?").run(item.id);
    nowMs += DAY;
    snapshot(0);
    run();
    expect(db.prepare('SELECT is_active,non_public_since FROM hosted_media_galleries WHERE id=?').get(item.galleryId))
      .toEqual({ is_active: 1, non_public_since: null });
    nowMs += 30 * DAY;
    snapshot(0);
    expect(run().deletedFiles).toBe(0);
    expect(fs.existsSync(item.file)).toBe(true);
  });

  it('keeps a shared hash while another public listing still uses it', () => {
    const first = upload('approved', 'shared-photo');
    const second = upload('approved', 'shared-photo');
    snapshot(0);
    db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(first.id);
    run();
    nowMs += 104 * DAY;
    snapshot(0);
    expect(run().deletedFiles).toBe(0);
    expect(fs.existsSync(first.file)).toBe(true);
    expect(new HostedMediaRepository(db).getActiveGallery(second.id)).toHaveLength(1);
  });

  it('starts never-public and Pending galleries at upload, without extending the clock on scans', () => {
    const pending = upload('pending');
    const unlinked = upload('none');
    const old = new Date(nowMs - 90 * DAY).toISOString();
    db.prepare('UPDATE hosted_media_galleries SET created_at=?').run(old);
    snapshot(0);
    expect(run().markedGalleries).toBe(2);
    expect(db.prepare('SELECT ever_public,non_public_since FROM hosted_media_galleries WHERE id=?').get(pending.galleryId))
      .toEqual({ ever_public: 0, non_public_since: old });
    expect(fs.existsSync(unlinked.file)).toBe(true);
    expect(fs.existsSync(pending.file)).toBe(true);
  });

  it('requires healthy backups and rotation past the unlink mark before physical deletion', () => {
    const item = upload('pending');
    db.prepare('UPDATE hosted_media_galleries SET created_at=? WHERE id=?').run(new Date(nowMs - 104 * DAY).toISOString(), item.galleryId);
    expect(run().deletedFiles).toBe(0);
    expect(fs.existsSync(item.file)).toBe(true);
    snapshot(0);
    expect(run().markedGalleries).toBe(1);
    const mark = (db.prepare('SELECT unreferenced_since FROM hosted_media_files WHERE hash=?').get(item.hash) as { unreferenced_since: string }).unreferenced_since;
    expect(mark).toBe(new Date(nowMs).toISOString());
    nowMs += 14 * DAY;
    snapshot(0);
    snapshot(14, 'homeasy_backup_2026-11-09_120000.db');
    expect(run().deletedFiles).toBe(0);
    expect(fs.existsSync(item.file)).toBe(true);
    fs.unlinkSync(path.join(backupDir, 'homeasy_backup_2026-11-09_120000.db'));
    expect(run().deletedFiles).toBe(0);
    nowMs += 14 * DAY;
    snapshot(0);
    expect(run().deletedFiles).toBe(1);
    expect(mark).toBeTruthy();
  });

  it('defaults to dry-run and refuses symlinked media paths', () => {
    const item = upload('pending');
    db.prepare('UPDATE hosted_media_galleries SET created_at=? WHERE id=?').run(new Date(nowMs - 90 * DAY).toISOString(), item.galleryId);
    snapshot(0);
    expect(runHostedMediaGc({ db, mediaRoot, backupDir, nowMs }).markedGalleries).toBe(1);
    expect(db.prepare('SELECT is_active FROM hosted_media_galleries WHERE id=?').get(item.galleryId)).toEqual({ is_active: 1 });
    const outside = path.join(root, 'outside.webp');
    fs.writeFileSync(outside, 'outside');
    fs.unlinkSync(item.file);
    fs.symlinkSync(outside, item.file);
    expect(() => run()).toThrow(/symlink|path/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  });

  it('uses canonical freshness and moderation to decide whether a gallery is public', () => {
    const item = upload();
    snapshot(0);
    run();
    expect(db.prepare('SELECT ever_public FROM hosted_media_galleries WHERE id=?').get(item.galleryId)).toEqual({ ever_public: 1 });
    db.prepare('UPDATE canonical_listing_source_occurrences SET posted_at=? WHERE listing_id=?')
      .run(new Date(Date.now() - 31 * DAY).toISOString(), item.id);
    run();
    expect(db.prepare('SELECT non_public_since FROM hosted_media_galleries WHERE id=?').get(item.galleryId))
      .toEqual({ non_public_since: new Date(nowMs).toISOString() });
  });

  it('eventually removes a superseded gallery file once the public source disappears', () => {
    const old = upload();
    snapshot(0);
    run();
    const replacementBytes = 'replacement-photo';
    const replacementHash = createHash('sha256').update(replacementBytes).digest('hex');
    const replacement = { hash: replacementHash, relativePath: `${replacementHash.slice(0, 2)}/${replacementHash}.webp`, byteLength: replacementBytes.length };
    fs.mkdirSync(path.join(mediaRoot, replacementHash.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, replacement.relativePath), replacementBytes);
    new HostedMediaRepository(db).publishGallery(old.id, new Date(nowMs + 1000).toISOString(), [
      { sourceUrl: 'https://example.test/new.jpg', anchorId: 'new', full: replacement, thumb: replacement },
    ]);
    db.prepare("UPDATE canonical_listing_moderation SET review_status='pending' WHERE listing_id=?").run(old.id);
    run();
    nowMs += 104 * DAY;
    snapshot(0);
    run();
    expect(fs.existsSync(old.file)).toBe(true);
    nowMs += 14 * DAY;
    snapshot(0);
    run();
    expect(fs.existsSync(old.file)).toBe(false);
    expect(db.prepare('SELECT id FROM source_items WHERE id=?').get(old.id)).toEqual({ id: old.id });
  });

  it('removes only old partial and quarantine files in a bounded batch inside the media root', () => {
    snapshot(0);
    const prefix = path.join(mediaRoot, 'aa');
    fs.mkdirSync(prefix);
    const old = path.join(prefix, '.11111111-1111-1111-1111-111111111111.tmp');
    const fresh = path.join(prefix, '.22222222-2222-2222-2222-222222222222.tmp');
    fs.writeFileSync(old, 'partial');
    fs.writeFileSync(fresh, 'partial');
    const quarantine = path.join(prefix, `${'a'.repeat(64)}.webp.gc-44444444-4444-4444-4444-444444444444`);
    fs.writeFileSync(quarantine, 'quarantined');
    fs.utimesSync(old, new Date(nowMs - DAY - 1), new Date(nowMs - DAY - 1));
    fs.utimesSync(quarantine, new Date(nowMs - DAY - 1), new Date(nowMs - DAY - 1));
    expect(run(false, 1).deletedTemporaryFiles).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(run(false, 1).deletedTemporaryFiles).toBe(1);
    expect(fs.existsSync(quarantine)).toBe(false);
  });

  it('rolls back prior gallery marks if another path in the batch is unsafe', () => {
    const first = upload('pending', 'first');
    const second = upload('pending', 'second');
    db.prepare('UPDATE hosted_media_galleries SET created_at=?').run(new Date(nowMs - 90 * DAY).toISOString());
    snapshot(0);
    fs.unlinkSync(second.file);
    fs.symlinkSync(path.join(root, 'missing-outside'), second.file);
    expect(() => run()).toThrow(/symlink|path/i);
    expect(db.prepare('SELECT is_active,non_public_since FROM hosted_media_galleries WHERE id=?').get(first.galleryId))
      .toEqual({ is_active: 1, non_public_since: null });
  });

  it('does not unlink an orphan if another path fails validation later in the batch', () => {
    const item = upload('pending');
    db.prepare('UPDATE hosted_media_galleries SET created_at=? WHERE id=?')
      .run(new Date(nowMs - 104 * DAY).toISOString(), item.galleryId);
    snapshot(0);
    run();
    nowMs += 14 * DAY;
    snapshot(0);
    const unsafe = path.join(mediaRoot, item.hash.slice(0, 2), '.33333333-3333-3333-3333-333333333333.tmp');
    fs.symlinkSync(path.join(root, 'outside'), unsafe);
    expect(() => run()).toThrow(/media residue path/i);
    expect(fs.existsSync(item.file)).toBe(true);
    expect(db.prepare('SELECT purged_at FROM hosted_media_galleries WHERE id=?').get(item.galleryId))
      .toEqual({ purged_at: null });
  });

  it('keeps database and bytes consistent when a later physical deletion fails', () => {
    const a = upload('pending', 'photo-a');
    const b = upload('pending', 'photo-b');
    db.prepare('UPDATE hosted_media_galleries SET created_at=?').run(new Date(nowMs - 104 * DAY).toISOString());
    snapshot(0);
    run();
    nowMs += 14 * DAY;
    snapshot(0);
    run();
    nowMs += 14 * DAY;
    snapshot(0);
    const [first, second] = [a, b].sort((left, right) => left.hash.localeCompare(right.hash));
    const rename = fs.renameSync.bind(fs);
    const failure = jest.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (source === fs.realpathSync(second.file)) throw new Error('simulated rename failure');
      return rename(source, target);
    });
    try { expect(() => run()).toThrow('simulated rename failure'); } finally { failure.mockRestore(); }
    expect(fs.existsSync(first.file)).toBe(false);
    expect(db.prepare('SELECT hash FROM hosted_media_files WHERE hash=?').get(first.hash)).toBeUndefined();
    expect(fs.existsSync(second.file)).toBe(true);
    expect(db.prepare('SELECT hash FROM hosted_media_files WHERE hash=?').get(second.hash)).toEqual({ hash: second.hash });
  });

  it('restores a quarantined file when a crash rolls back its database deletion', () => {
    const item = upload();
    snapshot(0);
    const quarantine = `${item.file}.gc-55555555-5555-5555-5555-555555555555`;
    fs.renameSync(item.file, quarantine);
    expect(run().restoredQuarantineFiles).toBe(1);
    expect(fs.existsSync(item.file)).toBe(true);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(db.prepare('SELECT hash FROM hosted_media_files WHERE hash=?').get(item.hash)).toEqual({ hash: item.hash });
  });

  it('deletes aged complete content files that were never indexed after a rejected upload', () => {
    snapshot(0);
    const bytes = 'rejected-upload-content';
    const hash = createHash('sha256').update(bytes).digest('hex');
    const directory = path.join(mediaRoot, hash.slice(0, 2));
    fs.mkdirSync(directory);
    const file = path.join(directory, `${hash}.webp`);
    fs.writeFileSync(file, bytes);
    fs.utimesSync(file, new Date(nowMs - 14 * DAY - 1), new Date(nowMs - 14 * DAY - 1));
    expect(run().deletedUnindexedFiles).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});
