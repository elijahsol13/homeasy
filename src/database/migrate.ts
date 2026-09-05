import type { DatabaseSync } from 'node:sqlite';

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
];

export function runMigrations(db: DatabaseSync): void {

  // Bootstrap migration tracker
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
                   DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);

  const appliedVersions = (
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as unknown as {
      version: number;
    }[]
  ).map((r) => r.version);

  const pendingCount = MIGRATIONS.filter((_, i) => !appliedVersions.includes(i + 1)).length;

  if (pendingCount === 0) {
    console.log('✅ Database schema is up to date');
    return;
  }

  console.log(`🔄 Applying ${pendingCount} database migration(s)...`);

  // node:sqlite uses SQL transactions directly
  db.exec('BEGIN');
  try {
    const insertMigration = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (!appliedVersions.includes(version)) {
        db.exec(sql);
        insertMigration.run(version);
        console.log(`  ✅ Applied migration v${version}`);
      }
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log('✅ All migrations applied');
}
