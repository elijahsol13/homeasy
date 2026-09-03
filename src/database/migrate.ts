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
  ALTER TABLE properties ADD COLUMN category TEXT CHECK(category IN ('apartment', 'house', 'room'));
  ALTER TABLE properties ADD COLUMN has_pool INTEGER NOT NULL DEFAULT 0 CHECK(has_pool IN (0, 1));
  ALTER TABLE properties ADD COLUMN image_phash TEXT;

  -- 2. Create indices for pHash and location lookups
  CREATE INDEX IF NOT EXISTS idx_properties_phash
    ON properties(image_phash);
  CREATE INDEX IF NOT EXISTS idx_properties_city_location
    ON properties(city, location);

  -- 3. Alter search_filters table
  ALTER TABLE search_filters ADD COLUMN category TEXT CHECK(category IN ('apartment', 'house', 'room'));
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
