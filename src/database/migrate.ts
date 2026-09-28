import type { DatabaseSync } from 'node:sqlite';
import { canonicalizeLocation, extractCoordinatesFromMapsUrl } from '../config/locations';
import type { CityKey } from '../config/settings';

/**
 * Each entry is a SQL block that runs exactly once.
 * Add new entries to evolve the schema — never edit existing ones.
 */
const MIGRATIONS: string[] = [
  // ── v1: users ────────────────────────────────────────────────────────────────
  `
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL UNIQUE,
    username    TEXT,
    role        TEXT NOT NULL DEFAULT 'user'
                  CHECK(role IN ('user', 'admin')),
    is_active   INTEGER NOT NULL DEFAULT 1
                  CHECK(is_active IN (0, 1)),
    created_at  TEXT NOT NULL
                  DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_telegram_id
    ON users(telegram_id);
  `,

  // ── v2: search_filters ───────────────────────────────────────────────────────
  `
  CREATE TABLE IF NOT EXISTS search_filters (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL
                  REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK(type IN ('rent', 'sale')),
    min_price   INTEGER,
    max_price   INTEGER,
    bedrooms    INTEGER,
    locations   TEXT NOT NULL DEFAULT '[]',
    city        TEXT NOT NULL
                  CHECK(city IN ('siem_reap', 'phnom_penh')),
    is_active   INTEGER NOT NULL DEFAULT 1
                  CHECK(is_active IN (0, 1)),
    created_at  TEXT NOT NULL
                  DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_filters_user_id
    ON search_filters(user_id);
  CREATE INDEX IF NOT EXISTS idx_filters_active
    ON search_filters(is_active);
  `,

  // ── v3: properties ───────────────────────────────────────────────────────────
  `
  CREATE TABLE IF NOT EXISTS properties (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    hash           TEXT NOT NULL,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    price          INTEGER NOT NULL,
    currency       TEXT NOT NULL DEFAULT 'USD'
                     CHECK(currency IN ('USD', 'KHR')),
    type           TEXT NOT NULL CHECK(type IN ('rent', 'sale')),
    bedrooms       INTEGER,
    bathrooms      INTEGER,
    location       TEXT NOT NULL,
    city           TEXT NOT NULL
                     CHECK(city IN ('siem_reap', 'phnom_penh')),
    photos         TEXT NOT NULL DEFAULT '[]',
    direct_contact TEXT NOT NULL DEFAULT '{}',
    original_url   TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL
                     DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_properties_hash
    ON properties(hash);
  CREATE INDEX IF NOT EXISTS idx_properties_city_type
    ON properties(city, type);
  CREATE INDEX IF NOT EXISTS idx_properties_created
    ON properties(created_at DESC);
  `,

  // ── v4: user_favorites ───────────────────────────────────────────────────────
  `
  CREATE TABLE IF NOT EXISTS user_favorites (
    user_id     INTEGER NOT NULL
                  REFERENCES users(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL
                  REFERENCES properties(id) ON DELETE CASCADE,
    saved_at    TEXT NOT NULL
                  DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (user_id, property_id)
  );
  CREATE INDEX IF NOT EXISTS idx_favorites_user_id
    ON user_favorites(user_id);
  `,

  // ── v5: pHash dedup, deposit, min_lease, category, pool, maps, source_url ─────
  `
  -- 1. Alter properties table
  ALTER TABLE properties ADD COLUMN deposit INTEGER;
  ALTER TABLE properties ADD COLUMN min_lease INTEGER;
  ALTER TABLE properties ADD COLUMN maps_url TEXT;
  ALTER TABLE properties ADD COLUMN source_url TEXT;
  ALTER TABLE properties ADD COLUMN parsed_at TEXT;
  ALTER TABLE properties ADD COLUMN category TEXT CHECK(category IN ('apartment', 'house', 'room', 'hotel'));
  ALTER TABLE properties ADD COLUMN has_pool INTEGER NOT NULL DEFAULT 0 CHECK(has_pool IN (0, 1));
  ALTER TABLE properties ADD COLUMN image_phash TEXT;

  -- 2. Create indices for pHash and location lookups
  CREATE INDEX IF NOT EXISTS idx_properties_phash
    ON properties(image_phash);
  CREATE INDEX IF NOT EXISTS idx_properties_city_location
    ON properties(city, location);

  -- 3. Alter search_filters table
  ALTER TABLE search_filters ADD COLUMN category TEXT CHECK(category IN ('apartment', 'house', 'room', 'hotel'));
  ALTER TABLE search_filters ADD COLUMN requires_pool INTEGER NOT NULL DEFAULT 0 CHECK(requires_pool IN (0, 1));
  ALTER TABLE search_filters ADD COLUMN min_lease_preferred INTEGER;
  `,

  // ── v6: Multi-image pHash deduplication ───────────────────────────────────────
  `
  ALTER TABLE properties ADD COLUMN image_phashes TEXT;
  `,

  // ── v7: alerts_paused, reports_count, property is_active ───────────────────
  `
  ALTER TABLE users ADD COLUMN alerts_paused INTEGER NOT NULL DEFAULT 0 CHECK(alerts_paused IN (0, 1));
  ALTER TABLE properties ADD COLUMN reports_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE properties ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1));
  CREATE INDEX IF NOT EXISTS idx_properties_is_active ON properties(is_active);
  `,

  // ── v8: posted_at (platform date) & updated_at (activity/bump date) ─────────
  `
  ALTER TABLE properties ADD COLUMN posted_at TEXT;
  ALTER TABLE properties ADD COLUMN updated_at TEXT;
  UPDATE properties SET updated_at = created_at WHERE updated_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_properties_updated_at ON properties(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_properties_posted_at ON properties(posted_at DESC);
  `,

  // ── v9: Support 'hotel' category in properties and search_filters ─────────────
  `
  PRAGMA foreign_keys=OFF;

  CREATE TABLE properties_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    hash            TEXT    NOT NULL,
    title           TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    price           INTEGER NOT NULL,
    currency        TEXT    NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD', 'KHR')),
    type            TEXT    NOT NULL CHECK(type IN ('rent', 'sale')),
    bedrooms        INTEGER,
    bathrooms       INTEGER,
    location        TEXT    NOT NULL DEFAULT '',
    city            TEXT    NOT NULL CHECK(city IN ('siem_reap', 'phnom_penh')),
    photos          TEXT    NOT NULL DEFAULT '[]',
    direct_contact  TEXT    NOT NULL DEFAULT '{}',
    original_url    TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    deposit         INTEGER,
    min_lease       INTEGER,
    maps_url        TEXT,
    source_url      TEXT,
    parsed_at       TEXT,
    category        TEXT CHECK(category IN ('apartment', 'house', 'room', 'hotel')),
    has_pool        INTEGER NOT NULL DEFAULT 0 CHECK(has_pool IN (0, 1)),
    image_phash     TEXT,
    image_phashes   TEXT,
    reports_count   INTEGER NOT NULL DEFAULT 0,
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    posted_at       TEXT,
    updated_at      TEXT
  );

  INSERT INTO properties_new (
    id, hash, title, description, price, currency, type, bedrooms, bathrooms, location, city,
    photos, direct_contact, original_url, created_at, deposit, min_lease, maps_url, source_url,
    parsed_at, category, has_pool, image_phash, image_phashes, reports_count, is_active, posted_at, updated_at
  )
  SELECT
    id, hash, title, description, price, currency, type, bedrooms, bathrooms, location, city,
    photos, direct_contact, original_url, created_at, deposit, min_lease, maps_url, source_url,
    parsed_at, category, has_pool, image_phash, image_phashes, reports_count, is_active, posted_at, updated_at
  FROM properties;

  DROP TABLE properties;
  ALTER TABLE properties_new RENAME TO properties;

  CREATE INDEX IF NOT EXISTS idx_properties_hash ON properties(hash);
  CREATE INDEX IF NOT EXISTS idx_properties_city_type ON properties(city, type);
  CREATE INDEX IF NOT EXISTS idx_properties_created ON properties(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_properties_phash ON properties(image_phash);
  CREATE INDEX IF NOT EXISTS idx_properties_city_location ON properties(city, location);
  CREATE INDEX IF NOT EXISTS idx_properties_is_active ON properties(is_active);
  CREATE INDEX IF NOT EXISTS idx_properties_updated_at ON properties(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_properties_posted_at ON properties(posted_at DESC);

  CREATE TABLE search_filters_new (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                 TEXT    NOT NULL CHECK(type IN ('rent', 'sale')),
    min_price            INTEGER,
    max_price            INTEGER,
    bedrooms             INTEGER,
    locations            TEXT    NOT NULL DEFAULT '[]',
    city                 TEXT    NOT NULL CHECK(city IN ('siem_reap', 'phnom_penh')),
    is_active            INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
    created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    category             TEXT CHECK(category IN ('apartment', 'house', 'room', 'hotel')),
    requires_pool        INTEGER NOT NULL DEFAULT 0 CHECK(requires_pool IN (0, 1)),
    min_lease_preferred  INTEGER
  );

  INSERT INTO search_filters_new (
    id, user_id, type, min_price, max_price, bedrooms, locations, city, is_active, created_at,
    category, requires_pool, min_lease_preferred
  )
  SELECT
    id, user_id, type, min_price, max_price, bedrooms, locations, city, is_active, created_at,
    category, requires_pool, min_lease_preferred
  FROM search_filters;

  DROP TABLE search_filters;
  ALTER TABLE search_filters_new RENAME TO search_filters;

  CREATE INDEX IF NOT EXISTS idx_filters_user_id ON search_filters(user_id);
  CREATE INDEX IF NOT EXISTS idx_filters_active ON search_filters(is_active);

  PRAGMA foreign_keys=ON;
  `,

  // ── v10: scraper_metrics & usage_events ─────────────────────────────────────
  `
  CREATE TABLE IF NOT EXISTS scraper_metrics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    service       TEXT NOT NULL CHECK(service IN ('khmer24', 'facebook')),
    total_scraped INTEGER NOT NULL DEFAULT 0,
    inserted      INTEGER NOT NULL DEFAULT 0,
    duplicates    INTEGER NOT NULL DEFAULT 0,
    errors        INTEGER NOT NULL DEFAULT 0,
    proxy_used    TEXT,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scraper_metrics_service_created
    ON scraper_metrics(service, created_at DESC);

  CREATE TABLE IF NOT EXISTS usage_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    telegram_id INTEGER,
    event_type  TEXT NOT NULL,
    metadata    TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_usage_events_type_created
    ON usage_events(event_type, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
    ON usage_events(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_events_telegram_created
    ON usage_events(telegram_id, created_at DESC);
  `,

  // ── v11: Utilities, restrictions, landmarks, and pet-friendly columns ─────────
  `
  ALTER TABLE properties ADD COLUMN electricity TEXT;
  ALTER TABLE properties ADD COLUMN water TEXT;
  ALTER TABLE properties ADD COLUMN cleaning TEXT;
  ALTER TABLE properties ADD COLUMN restrictions TEXT;
  ALTER TABLE properties ADD COLUMN pet_friendly INTEGER NOT NULL DEFAULT 0 CHECK(pet_friendly IN (0, 1));
  ALTER TABLE properties ADD COLUMN primary_landmark TEXT;
  ALTER TABLE properties ADD COLUMN landmarks TEXT;

  CREATE INDEX IF NOT EXISTS idx_properties_pet_friendly
    ON properties(pet_friendly);
  CREATE INDEX IF NOT EXISTS idx_properties_primary_landmark
    ON properties(primary_landmark);

  ALTER TABLE search_filters ADD COLUMN pet_friendly INTEGER DEFAULT 0 CHECK(pet_friendly IN (0, 1));
  `,

  // ── v12: Latitude, Longitude, and coordinates index for Bounding Box queries ───
  `
  ALTER TABLE properties ADD COLUMN latitude REAL;
  ALTER TABLE properties ADD COLUMN longitude REAL;

  CREATE INDEX IF NOT EXISTS idx_properties_coords
    ON properties(latitude, longitude)
    WHERE is_active = 1;
  `,

  // ── v13: Coordinates backfill with Sangkat centroids and micro-jitter ────────
  `
  -- Backfill coordinates for all properties without GPS
  SELECT 1;
  `,

  // ── v14: Strict GPS truthfulness (reset synthetic coords to NULL, keep only authentic pins) ──
  `
  -- Strict GPS truthfulness
  SELECT 1;
  `,

  // ── v15: property_type and amenities ───────────────────────────────────────────
  `
ALTER TABLE properties ADD COLUMN property_type TEXT;
ALTER TABLE properties ADD COLUMN amenities TEXT;

CREATE INDEX IF NOT EXISTS idx_properties_property_type
  ON properties(property_type);
`,

  // ── v16: marketing_landmarks (promotional "5 min to X" claims, kept separate
  //         from physical `landmarks` so they never influence location/matching) ──
  `
ALTER TABLE properties ADD COLUMN marketing_landmarks TEXT;
`,

  // ── v17: raw_text (original un-normalized post body for re-parsing/debugging)
  //         + parse_warnings (machine-readable extraction issue codes) ──────────
  `
ALTER TABLE properties ADD COLUMN raw_text TEXT;
ALTER TABLE properties ADD COLUMN parse_warnings TEXT;
`,

  // ── v18: last_verified_at — drives the smart re-verification queue cadence ──
  `
ALTER TABLE properties ADD COLUMN last_verified_at TEXT;
`,

  // ── v19: canonical location identity and coordinate provenance ──────────────
  `
ALTER TABLE properties ADD COLUMN location_key TEXT;
ALTER TABLE properties ADD COLUMN raw_location TEXT;
ALTER TABLE properties ADD COLUMN coordinate_precision TEXT NOT NULL DEFAULT 'district';

CREATE INDEX IF NOT EXISTS idx_properties_location_key
  ON properties(city, location_key);
`,

  // ── v20: refresh canonical locations after catalog expansion ────────────────
  `
SELECT 1;
`,

  // ── v21: manual review queue for uncertain admission decisions ─────────────
  `
ALTER TABLE properties ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE properties ADD COLUMN review_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_properties_review_status ON properties(review_status, is_active);
`,

  // ── v22: allow has_pool and pet_friendly to be null so "unknown" is preserved ───
  `
PRAGMA foreign_keys=OFF;

DROP INDEX IF EXISTS idx_properties_pet_friendly;

ALTER TABLE properties ADD COLUMN has_pool_new INTEGER CHECK(has_pool_new IN (0,1));
UPDATE properties SET has_pool_new = has_pool;
ALTER TABLE properties DROP COLUMN has_pool;
ALTER TABLE properties RENAME COLUMN has_pool_new TO has_pool;

ALTER TABLE properties ADD COLUMN pet_friendly_new INTEGER CHECK(pet_friendly_new IN (0,1));
UPDATE properties SET pet_friendly_new = pet_friendly;
ALTER TABLE properties DROP COLUMN pet_friendly;
ALTER TABLE properties RENAME COLUMN pet_friendly_new TO pet_friendly;

CREATE INDEX IF NOT EXISTS idx_properties_pet_friendly ON properties(pet_friendly);

PRAGMA foreign_keys=ON;
`,
];

/**
 * Blocks (with SQLite's own file-level locking) until this connection can acquire
 * the write lock, retrying on SQLITE_BUSY. This is critical because `bot`, `scraper`,
 * and `api` are three separate OS processes that all call runMigrations() on their
 * own startup against the SAME database file (bind-mounted). Without this guard,
 * a fresh deploy that restarts all three containers at once causes them to race to
 * apply the same pending migration concurrently — including heavy DDL migrations
 * that rebuild the `properties` table (CREATE + copy + DROP + RENAME). Concurrent
 * DDL from multiple processes against one SQLite file is a well-known trigger for
 * "database disk image is malformed", especially combined with the experimental
 * node:sqlite driver.
 */
function beginExclusiveWithRetry(db: DatabaseSync, maxWaitMs = 60_000): void {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < maxWaitMs) {
    try {
      db.exec('BEGIN IMMEDIATE');
      return;
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/SQLITE_BUSY|database is locked/i.test(msg)) {
        throw err;
      }
      // Another process is applying migrations right now — wait briefly and retry.
      const waitUntil = Date.now() + 200 + Math.random() * 300;
      while (Date.now() < waitUntil) {
        /* short synchronous backoff before retrying the lock */
      }
    }
  }
  throw new Error(
    `Could not acquire exclusive migration lock after ${maxWaitMs}ms: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

export function runMigrations(db: DatabaseSync): void {

  // Bootstrap migration tracker (idempotent, safe to run before the lock)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
                   DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);

  // Acquire the cross-process write lock BEFORE checking which versions are applied,
  // so a concurrent process can't apply the same migration between our check and our write.
  beginExclusiveWithRetry(db);
  try {
    const appliedVersions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as unknown as {
        version: number;
      }[]
    ).map((r) => r.version);

    const pendingCount = MIGRATIONS.filter((_, i) => !appliedVersions.includes(i + 1)).length;

    if (pendingCount === 0) {
      db.exec('COMMIT');
      console.log('✅ Database schema is up to date');
      return;
    }

    const insertMigration = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
    MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (!appliedVersions.includes(version)) {
        db.exec(sql);
        insertMigration.run(version);
        console.log(`  ✅ Applied migration v${version}`);

        if (version === 14) {
          try {
            db.exec('UPDATE properties SET latitude = NULL, longitude = NULL');
            const rows = db
              .prepare('SELECT id, maps_url FROM properties WHERE maps_url IS NOT NULL')
              .all() as unknown as Array<{ id: number; maps_url: string }>;
            const updateStmt = db.prepare('UPDATE properties SET latitude = ?, longitude = ? WHERE id = ?');
            let verifiedCount = 0;
            for (const r of rows) {
              const coords = extractCoordinatesFromMapsUrl(r.maps_url);
              if (coords) {
                updateStmt.run(coords.latitude, coords.longitude, r.id);
                verifiedCount++;
              }
            }
            console.log(`  📍 Populated ${verifiedCount} authentic GPS pins; all other listings kept as NULL`);
          } catch (e) {
            console.warn('  ⚠️ Coordinate reset notice:', e);
          }
        } else if (version === 19 || version === 20) {
          const rows = db
            .prepare('SELECT id, location, raw_location, city, latitude, longitude FROM properties')
            .all() as unknown as Array<{
              id: number;
              location: string;
              raw_location: string | null;
              city: CityKey;
              latitude: number | null;
              longitude: number | null;
            }>;
          const updateStmt = db.prepare(
            'UPDATE properties SET location_key = ?, raw_location = ?, location = ?, city = ?, coordinate_precision = ? WHERE id = ?',
          );
          let canonicalizedCount = 0;
          for (const row of rows) {
            const canonical = canonicalizeLocation(row.location, row.city);
            const rawLocation = row.raw_location ?? (canonical.name !== row.location ? row.location : null);
            const precision = row.latitude !== null && row.longitude !== null
              ? 'exact'
              : canonical.key ? 'district' : 'city';
            updateStmt.run(
              canonical.key,
              rawLocation,
              canonical.name,
              canonical.city,
              precision,
              row.id,
            );
            if (canonical.key) canonicalizedCount++;
          }
          console.log(`  📍 Canonicalized ${canonicalizedCount}/${rows.length} property locations`);
        }
      }
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log('✅ All migrations applied');
}
