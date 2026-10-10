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

  // ── v23: preserve lossless canonical listing facts ──────────────────────────
  `
ALTER TABLE properties ADD COLUMN listing_facts_json TEXT;
`,

  // ── v24: tracking gateway links (domain.com/r/<slug> attribution) ───────────
  `
CREATE TABLE IF NOT EXISTS tracked_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'miniapp'
                CHECK(kind IN ('miniapp','url')),
  payload       TEXT,
  source        TEXT,
  campaign      TEXT,
  group_id      TEXT,
  post_id       TEXT,
  request_id    TEXT,
  listing_id    INTEGER,
  agent_id      INTEGER,
  metadata      TEXT NOT NULL DEFAULT '{}',
  clicks_count  INTEGER NOT NULL DEFAULT 0,
  last_clicked_at TEXT,
  created_at    TEXT NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tracked_links_slug ON tracked_links(slug);
CREATE INDEX IF NOT EXISTS idx_tracked_links_request ON tracked_links(request_id);
`,

  // ── v25: source registry ────────────────────────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS source_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK(source_type IN ('FACEBOOK_GROUP','KHMER24','AGENT','LANDLORD','REAL_ESTATE_PORTAL','MANUAL')),
  external_source_id TEXT,
  name TEXT NOT NULL,
  url TEXT,
  visibility TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(visibility IN ('PUBLIC','PRIVATE','UNKNOWN')),
  preferred_ingestion_method TEXT CHECK(preferred_ingestion_method IN ('BRIGHTDATA','CAMOUFOX','KHMER24_SCRAPER','DIRECT_SUBMISSION','MANUAL')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 0,
  city TEXT CHECK(city IN ('siem_reap','phnom_penh')),
  last_success_at TEXT, last_failure_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_cursor TEXT, last_scraped_at TEXT,
  posts_seen INTEGER NOT NULL DEFAULT 0,
  housing_supply_seen INTEGER NOT NULL DEFAULT 0,
  housing_demand_seen INTEGER NOT NULL DEFAULT 0,
  unique_supply_seen INTEGER NOT NULL DEFAULT 0,
  unique_demand_seen INTEGER NOT NULL DEFAULT 0,
  duplicate_supply_seen INTEGER NOT NULL DEFAULT 0,
  duplicate_demand_seen INTEGER NOT NULL DEFAULT 0,
  supply_score REAL, demand_score REAL, freshness_score REAL,
  uniqueness_score REAL, acquisition_score REAL,
  scrape_interval_minutes INTEGER,
  freshness_strategy TEXT DEFAULT 'DEFAULT',
  freshness_cost_class TEXT DEFAULT 'MEDIUM' CHECK(freshness_cost_class IN ('FREE','CHEAP','MEDIUM','EXPENSIVE')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_source_registry_type_enabled ON source_registry(source_type, enabled);
`,

  // ── v26: processing runs and run sources ────────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS processing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL CHECK(run_type IN ('DISCOVERY','REPLAY','REPARSE','FRESHNESS_CHECK','MANUAL_IMPORT')),
  source_registry_id INTEGER REFERENCES source_registry(id),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at TEXT,
  items_input INTEGER NOT NULL DEFAULT 0,
  items_processed INTEGER NOT NULL DEFAULT 0,
  items_success INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
  error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS processing_run_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  processing_run_id INTEGER NOT NULL REFERENCES processing_runs(id),
  source_registry_id INTEGER NOT NULL REFERENCES source_registry(id),
  ingestion_method TEXT NOT NULL CHECK(ingestion_method IN ('BRIGHTDATA','CAMOUFOX','KHMER24_SCRAPER','DIRECT_SUBMISSION','MANUAL','REPLAY')),
  records_input INTEGER NOT NULL DEFAULT 0,
  records_success INTEGER NOT NULL DEFAULT 0,
  records_failed INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_processing_run_sources_run ON processing_run_sources(processing_run_id);
CREATE INDEX IF NOT EXISTS idx_processing_run_sources_source ON processing_run_sources(source_registry_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_run_sources_unique ON processing_run_sources(processing_run_id, source_registry_id, ingestion_method);
CREATE INDEX IF NOT EXISTS idx_processing_runs_started ON processing_runs(started_at DESC);
`,

  // ── v27: immutable-ish source items ──────────────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS source_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_registry_id INTEGER NOT NULL REFERENCES source_registry(id),
  source_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  canonical_url TEXT, source_url TEXT,
  group_id TEXT, group_name TEXT,
  author_external_id TEXT, author_name TEXT, author_url TEXT,
  raw_text TEXT,
  raw_payload_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT, media_hash TEXT, published_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_checked_at TEXT,
  source_alive INTEGER CHECK(source_alive IN (0,1)),
  fetch_status TEXT DEFAULT 'fetched' CHECK(fetch_status IN ('fetched','failed','skipped','timeout')),
  classification TEXT CHECK(classification IN ('HOUSING_SUPPLY','HOUSING_DEMAND','HOUSING_ADJACENT','IRRELEVANT','UNCLASSIFIED')),
  parser_version TEXT,
  processing_run_id INTEGER REFERENCES processing_runs(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_items_unique ON source_items(source_registry_id, external_id);
CREATE INDEX IF NOT EXISTS idx_source_items_classification ON source_items(classification, source_registry_id);
CREATE INDEX IF NOT EXISTS idx_source_items_content_hash ON source_items(content_hash);
CREATE INDEX IF NOT EXISTS idx_source_items_run ON source_items(processing_run_id);
`,

  // ── v28: source item snapshots ──────────────────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS source_item_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_item_id INTEGER NOT NULL REFERENCES source_items(id),
  content_hash TEXT, raw_text TEXT,
  raw_payload_json TEXT NOT NULL DEFAULT '{}', media_hash TEXT,
  observed_at TEXT NOT NULL,
  parser_version TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_source_item_versions_item ON source_item_versions(source_item_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_item_versions_hash ON source_item_versions(content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_item_versions_unique ON source_item_versions(source_item_id, content_hash);
`,

  // ── v29: deterministic source item identifiers ──────────────────────────────
  `
CREATE TABLE IF NOT EXISTS source_item_identifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_item_id INTEGER NOT NULL REFERENCES source_items(id),
  type TEXT NOT NULL CHECK(type IN ('PHONE','TELEGRAM','WHATSAPP','EMAIL','PROPERTY_CODE','AGENCY_CODE','MAPS_URL','MAPS_PLACE_ID')),
  raw_value TEXT,
  normalized_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identifiers_unique ON source_item_identifiers(source_item_id, type, normalized_value);
CREATE INDEX IF NOT EXISTS idx_identifiers_value ON source_item_identifiers(type, normalized_value);
CREATE INDEX IF NOT EXISTS idx_identifiers_source_item ON source_item_identifiers(source_item_id);
`,

  // ── v30: canonical properties ───────────────────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS canonical_properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT CHECK(city IN ('siem_reap','phnom_penh')),
  sangkat TEXT, canonical_address TEXT, explicit_location TEXT,
  latitude REAL, longitude REAL, property_type TEXT,
  bedrooms INTEGER, bathrooms INTEGER, building_name TEXT, unit_identifier TEXT,
  property_fingerprint TEXT, last_observed_at TEXT, freshness_score REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_canonical_properties_fingerprint ON canonical_properties(property_fingerprint);
CREATE INDEX IF NOT EXISTS idx_canonical_properties_location ON canonical_properties(city, sangkat);
`,

  // ── v31: canonical listings ─────────────────────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS canonical_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER REFERENCES canonical_properties(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','archived')),
  availability_status TEXT DEFAULT 'unknown' CHECK(availability_status IN ('available','rented','removed','unknown')),
  price INTEGER, currency TEXT CHECK(currency IN ('USD','KHR')),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  property_type TEXT, category TEXT CHECK(category IN ('apartment','house','room','hotel')),
  bedrooms INTEGER, bathrooms INTEGER,
  min_lease_months INTEGER, lease_term_text TEXT,
  deposit_amount INTEGER, deposit_months INTEGER,
  pet_friendly INTEGER CHECK(pet_friendly IN (0,1)),
  amenities TEXT NOT NULL DEFAULT '[]', restrictions TEXT NOT NULL DEFAULT '[]',
  electricity_type TEXT, electricity_rate INTEGER, water_type TEXT, water_rate INTEGER,
  city TEXT CHECK(city IN ('siem_reap','phnom_penh')), sangkat TEXT, explicit_location TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  last_checked_at TEXT, availability_last_confirmed_at TEXT,
  availability_confirmed_by TEXT, availability_confidence REAL,
  freshness_score REAL, stale_at TEXT, expires_at TEXT,
  primary_source_occurrence_id INTEGER,
  dedupe_confidence REAL, listing_facts_json TEXT, content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_canonical_listings_property_id ON canonical_listings(property_id);
CREATE INDEX IF NOT EXISTS idx_canonical_listings_status ON canonical_listings(status, availability_status);
CREATE INDEX IF NOT EXISTS idx_canonical_listings_city ON canonical_listings(city, sangkat, category);
CREATE INDEX IF NOT EXISTS idx_canonical_listings_last_seen ON canonical_listings(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_listings_stale_at ON canonical_listings(stale_at);
CREATE INDEX IF NOT EXISTS idx_canonical_listings_content_hash ON canonical_listings(content_hash);
`,

  // ── v32: listing source occurrences ─────────────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS canonical_listing_source_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_item_id INTEGER NOT NULL REFERENCES source_items(id),
  listing_id INTEGER REFERENCES canonical_listings(id),
  source_registry_id INTEGER NOT NULL REFERENCES source_registry(id),
  external_id TEXT, source_url TEXT, group_id TEXT, group_name TEXT,
  author_external_id TEXT, author_name TEXT, author_url TEXT, posted_at TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  last_checked_at TEXT, next_check_at TEXT,
  source_alive INTEGER CHECK(source_alive IN (0,1)),
  consecutive_check_failures INTEGER NOT NULL DEFAULT 0,
  last_check_result TEXT, content_hash TEXT, content_changed_at TEXT,
  price_seen INTEGER, currency_seen TEXT, availability_signal TEXT, availability_signal_at TEXT,
  discovery_credit INTEGER NOT NULL DEFAULT 0 CHECK(discovery_credit IN (0,1)),
  discovery_rank INTEGER, repost_cluster_id TEXT, dedupe_decision_id INTEGER,
  dedupe_method TEXT, dedupe_score REAL,
  source_entity_key TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_canonical_listing_occ_listing_id ON canonical_listing_source_occurrences(listing_id);
CREATE INDEX IF NOT EXISTS idx_canonical_listing_occ_source_item ON canonical_listing_source_occurrences(source_item_id);
CREATE INDEX IF NOT EXISTS idx_canonical_listing_occ_next_check ON canonical_listing_source_occurrences(next_check_at);
CREATE INDEX IF NOT EXISTS idx_canonical_listing_occ_source_registry ON canonical_listing_source_occurrences(source_registry_id, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_listing_occ_unique ON canonical_listing_source_occurrences(source_item_id, source_entity_key);
`,

  // ── v33: dedupe clusters and decisions ──────────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS dedupe_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('SUPPLY_REPOST','DEMAND_REPOST','PROPERTY','LISTING')),
  algorithm_version TEXT NOT NULL, cluster_key TEXT, confidence REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dedupe_clusters_type_key ON dedupe_clusters(entity_type, cluster_key);
CREATE TABLE IF NOT EXISTS dedupe_cluster_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id INTEGER NOT NULL REFERENCES dedupe_clusters(id),
  source_item_id INTEGER REFERENCES source_items(id),
  occurrence_id INTEGER, occurrence_type TEXT, score REAL, reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dedupe_members_cluster ON dedupe_cluster_members(cluster_id);
CREATE INDEX IF NOT EXISTS idx_dedupe_members_source_item ON dedupe_cluster_members(source_item_id);
CREATE TABLE IF NOT EXISTS dedupe_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_a_type TEXT NOT NULL, candidate_a_id INTEGER NOT NULL,
  candidate_b_type TEXT NOT NULL, candidate_b_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('SAME_LISTING','SAME_PROPERTY_DIFFERENT_LISTING','POSSIBLE_SAME_PROPERTY','DIFFERENT_PROPERTY')),
  property_score REAL, listing_score REAL,
  reasons_json TEXT NOT NULL DEFAULT '[]', algorithm_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dedupe_decisions_a ON dedupe_decisions(candidate_a_type, candidate_a_id);
CREATE INDEX IF NOT EXISTS idx_dedupe_decisions_b ON dedupe_decisions(candidate_b_type, candidate_b_id);
`,

  // ── v34: demand candidates and occurrences ──────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS demand_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewing','outreach_sent','converted','ignored','expired')),
  priority INTEGER NOT NULL DEFAULT 0, canonical_text TEXT NOT NULL, language TEXT,
  city TEXT CHECK(city IN ('siem_reap','phnom_penh')),
  budget_min INTEGER, budget_max INTEGER, budget_target INTEGER,
  budget_is_approximate INTEGER CHECK(budget_is_approximate IN (0,1)), currency TEXT CHECK(currency IN ('USD','KHR')),
  move_in_date TEXT, move_in_text TEXT, duration_min_months INTEGER, duration_max_months INTEGER, duration_text TEXT,
  bedrooms_min INTEGER, bedrooms_max INTEGER,
  property_types TEXT NOT NULL DEFAULT '[]', areas TEXT NOT NULL DEFAULT '[]', exclude_areas TEXT NOT NULL DEFAULT '[]',
  must_haves TEXT NOT NULL DEFAULT '[]', nice_to_haves TEXT NOT NULL DEFAULT '[]', exclude_features TEXT NOT NULL DEFAULT '[]',
  has_pets INTEGER CHECK(has_pets IN (0,1)), pet_types TEXT NOT NULL DEFAULT '[]', people_count INTEGER,
  author_identity_key TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  repost_cluster_id TEXT, dedupe_decision_id INTEGER,
  outreach_status TEXT DEFAULT 'none' CHECK(outreach_status IN ('none','queued','sent','replied','converted','failed')),
  outreach_sent_at TEXT, outreach_channel TEXT,
  tracking_link_id INTEGER REFERENCES tracked_links(id), converted_request_id INTEGER,
  converted_user_id INTEGER REFERENCES users(id), converted_at TEXT,
  ignored_reason TEXT, parser_version TEXT, extractor_version TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_demand_candidates_status ON demand_candidates(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_demand_candidates_author ON demand_candidates(author_identity_key);
CREATE INDEX IF NOT EXISTS idx_demand_candidates_outreach ON demand_candidates(outreach_status, outreach_sent_at);
CREATE TABLE IF NOT EXISTS demand_source_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_item_id INTEGER NOT NULL REFERENCES source_items(id),
  demand_candidate_id INTEGER REFERENCES demand_candidates(id),
  source_registry_id INTEGER NOT NULL REFERENCES source_registry(id),
  external_id TEXT, source_url TEXT, group_id TEXT, group_name TEXT,
  author_external_id TEXT, author_name TEXT, author_url TEXT, posted_at TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_checked_at TEXT,
  source_alive INTEGER CHECK(source_alive IN (0,1)), content_hash TEXT,
  discovery_credit INTEGER NOT NULL DEFAULT 0 CHECK(discovery_credit IN (0,1)),
  repost_cluster_id TEXT, dedupe_decision_id INTEGER, dedupe_method TEXT, dedupe_score REAL,
  source_entity_key TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_demand_occ_candidate ON demand_source_occurrences(demand_candidate_id);
CREATE INDEX IF NOT EXISTS idx_demand_occ_source_item ON demand_source_occurrences(source_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_demand_occ_unique ON demand_source_occurrences(source_item_id, source_entity_key);
`,

  // ── v35: media assets ───────────────────────────────────────────────────────
  `
CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_item_id INTEGER REFERENCES source_items(id),
  source_occurrence_id INTEGER REFERENCES canonical_listing_source_occurrences(id),
  listing_id INTEGER REFERENCES canonical_listings(id),
  property_id INTEGER REFERENCES canonical_properties(id),
  source_url TEXT NOT NULL, normalized_url TEXT, mime_type TEXT,
  width INTEGER, height INTEGER, content_hash TEXT,
  perceptual_hash TEXT, hash_algorithm TEXT DEFAULT 'dhash', hash_version INTEGER DEFAULT 1,
  download_status TEXT DEFAULT 'pending' CHECK(download_status IN ('pending','downloaded','failed','skipped')),
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_media_assets_hash ON media_assets(perceptual_hash);
CREATE INDEX IF NOT EXISTS idx_media_assets_listing ON media_assets(listing_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_source_item ON media_assets(source_item_id);
`,

  // ── v36: availability checks and freshness jobs ─────────────────────────────
  `
CREATE TABLE IF NOT EXISTS availability_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER REFERENCES canonical_listings(id),
  source_occurrence_id INTEGER REFERENCES canonical_listing_source_occurrences(id),
  check_type TEXT NOT NULL CHECK(check_type IN ('SOURCE_RECHECK','AGENT_CONFIRMATION','RENTER_FEEDBACK','MANUAL_ADMIN','CONTENT_CHANGE')),
  provider TEXT, previous_status TEXT, new_status TEXT,
  result TEXT NOT NULL CHECK(result IN ('ALIVE','REMOVED','UNAVAILABLE','CHANGED','UNKNOWN','ERROR')),
  checked_at TEXT NOT NULL, raw_response TEXT, estimated_cost REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_availability_checks_listing ON availability_checks(listing_id, checked_at DESC);
CREATE TABLE IF NOT EXISTS freshness_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER REFERENCES canonical_listings(id),
  source_occurrence_id INTEGER REFERENCES canonical_listing_source_occurrences(id),
  check_type TEXT NOT NULL, provider TEXT, priority INTEGER NOT NULL DEFAULT 0, reason TEXT,
  scheduled_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','DONE','FAILED','CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  estimated_cost REAL, actual_cost REAL, result TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_freshness_jobs_schedule ON freshness_jobs(status, priority DESC, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_freshness_jobs_unique ON freshness_jobs(listing_id, check_type, COALESCE(source_occurrence_id, 0)) WHERE status IN ('QUEUED','RUNNING');
`,

  // ── v37: external provider usage and AI provenance ──────────────────────────
  `
CREATE TABLE IF NOT EXISTS external_provider_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL, operation TEXT NOT NULL,
  requested_items INTEGER NOT NULL DEFAULT 0,
  returned_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL, actual_cost REAL,
  processing_run_id INTEGER REFERENCES processing_runs(id),
  freshness_job_id INTEGER REFERENCES freshness_jobs(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_provider_usage_provider ON external_provider_usage(provider, created_at DESC);
CREATE TABLE IF NOT EXISTS ai_processing_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  processing_run_id INTEGER NOT NULL REFERENCES processing_runs(id),
  source_item_id INTEGER NOT NULL REFERENCES source_items(id),
  stage TEXT NOT NULL CHECK(stage IN ('CLASSIFICATION','SUPPLY_EXTRACTION','DEMAND_EXTRACTION')),
  provider TEXT, model TEXT, fallback_depth INTEGER, prompt_version TEXT,
  success INTEGER NOT NULL DEFAULT 1 CHECK(success IN (0,1)),
  error_code TEXT, latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_results_item ON ai_processing_results(source_item_id, stage);
CREATE INDEX IF NOT EXISTS idx_ai_results_run ON ai_processing_results(processing_run_id, stage);
`,

  // ── v38: stable, explainable repost cluster persistence ──────────────────────
  `
ALTER TABLE dedupe_clusters ADD COLUMN representative_source_item_id INTEGER REFERENCES source_items(id);
ALTER TABLE dedupe_cluster_members ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS idx_dedupe_clusters_version_key
  ON dedupe_clusters(entity_type, algorithm_version, cluster_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dedupe_members_cluster_item
  ON dedupe_cluster_members(cluster_id, source_item_id);
CREATE INDEX IF NOT EXISTS idx_source_items_author ON source_items(author_external_id);
`,

  // ── v39: idempotent shadow canonicalization and full decision evidence ──────
  `
ALTER TABLE dedupe_decisions ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE canonical_properties ADD COLUMN canonical_key TEXT;
ALTER TABLE canonical_properties ADD COLUMN algorithm_version TEXT;
ALTER TABLE canonical_properties ADD COLUMN first_observed_at TEXT;
ALTER TABLE canonical_listings ADD COLUMN canonical_key TEXT;
ALTER TABLE canonical_listings ADD COLUMN algorithm_version TEXT;
ALTER TABLE canonical_listing_source_occurrences ADD COLUMN property_discovery_credit INTEGER NOT NULL DEFAULT 0 CHECK(property_discovery_credit IN (0,1));
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_properties_key ON canonical_properties(algorithm_version, canonical_key) WHERE canonical_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_listings_key ON canonical_listings(algorithm_version, canonical_key) WHERE canonical_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dedupe_decisions_pair_version
  ON dedupe_decisions(algorithm_version, candidate_a_type, candidate_a_id, candidate_b_type, candidate_b_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_normalized_url ON media_assets(normalized_url) WHERE normalized_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_source_items_type_classification ON source_items(source_type, classification);
CREATE TABLE IF NOT EXISTS media_asset_source_occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_asset_id INTEGER NOT NULL REFERENCES media_assets(id),
  source_item_id INTEGER NOT NULL REFERENCES source_items(id),
  source_occurrence_id INTEGER REFERENCES canonical_listing_source_occurrences(id),
  listing_id INTEGER REFERENCES canonical_listings(id),
  property_id INTEGER REFERENCES canonical_properties(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(media_asset_id, source_item_id)
);
CREATE INDEX IF NOT EXISTS idx_media_asset_occurrence_source ON media_asset_source_occurrences(source_occurrence_id);
CREATE INDEX IF NOT EXISTS idx_media_asset_occurrence_listing ON media_asset_source_occurrences(listing_id);
`,

  // ── v40: preserve source item versions when attached media changes ───────────
  `
DROP INDEX IF EXISTS idx_source_item_versions_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_item_versions_unique
  ON source_item_versions(source_item_id, COALESCE(content_hash, ''), COALESCE(media_hash, ''));
`,

  // ── v41: freshness budget reservations are measured in provider records ─────
  `
ALTER TABLE freshness_jobs ADD COLUMN estimated_records INTEGER NOT NULL DEFAULT 0;
`,

  // ── v42: preserve historical canonical bindings when a source post is repurposed ──
  `
ALTER TABLE canonical_listing_source_occurrences ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1));
ALTER TABLE canonical_listing_source_occurrences ADD COLUMN ended_at TEXT;
DROP INDEX IF EXISTS idx_canonical_listing_occ_unique;
CREATE UNIQUE INDEX idx_canonical_listing_occ_unique_current
  ON canonical_listing_source_occurrences(source_item_id, source_entity_key) WHERE is_current=1;
CREATE INDEX idx_canonical_listing_occ_current_listing ON canonical_listing_source_occurrences(listing_id,is_current);
`,

  // ── v43: persist media version on canonical bindings for retry-safe reconciliation ──
  `
ALTER TABLE canonical_listing_source_occurrences ADD COLUMN media_hash TEXT;
UPDATE canonical_listing_source_occurrences SET media_hash=(SELECT s.media_hash FROM source_items s WHERE s.id=canonical_listing_source_occurrences.source_item_id);
`,

  // ── v44: persist each AI provider attempt, including fallbacks ───────────────
  `
ALTER TABLE ai_processing_results ADD COLUMN call_id TEXT;
ALTER TABLE ai_processing_results ADD COLUMN attempt_index INTEGER;
CREATE INDEX idx_ai_results_call ON ai_processing_results(call_id, attempt_index);
`,

  // ── v45: namespace-aware listing aliases and moderation state ────────────────
  `
CREATE TABLE IF NOT EXISTS canonical_listing_aliases (
  namespace TEXT NOT NULL CHECK(namespace IN ('legacy_property_id','canonical_listing_id','public_listing_ref','legacy_url')),
  alias TEXT NOT NULL,
  listing_id INTEGER NOT NULL REFERENCES canonical_listings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY(namespace, alias)
);
CREATE INDEX IF NOT EXISTS idx_listing_alias_listing ON canonical_listing_aliases(listing_id);
INSERT OR IGNORE INTO canonical_listing_aliases(namespace,alias,listing_id)
  SELECT 'canonical_listing_id',CAST(id AS TEXT),id FROM canonical_listings;
INSERT OR IGNORE INTO canonical_listing_aliases(namespace,alias,listing_id)
  SELECT 'public_listing_ref','lst_'||CAST(id AS TEXT),id FROM canonical_listings;
INSERT OR IGNORE INTO canonical_listing_aliases(namespace,alias,listing_id)
  SELECT 'legacy_property_id',CAST(p.id AS TEXT),l.id
  FROM canonical_listings l JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id
  JOIN source_items s ON s.id=o.source_item_id JOIN properties p ON p.original_url=s.canonical_url OR p.source_url=s.source_url;
CREATE TABLE IF NOT EXISTS canonical_listing_moderation (
  listing_id INTEGER PRIMARY KEY REFERENCES canonical_listings(id) ON DELETE CASCADE,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
  review_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS canonical_user_favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES canonical_listings(id) ON DELETE CASCADE,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY(user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_canonical_favorites_user ON canonical_user_favorites(user_id, saved_at DESC);
INSERT OR IGNORE INTO canonical_listing_moderation(listing_id,review_status,review_reason)
  SELECT l.id,COALESCE(p.review_status,'pending'),p.review_reason
  FROM canonical_listings l
  LEFT JOIN canonical_listing_source_occurrences o ON o.id=l.primary_source_occurrence_id
  LEFT JOIN source_items s ON s.id=o.source_item_id
  LEFT JOIN properties p ON p.original_url=s.canonical_url OR p.source_url=s.source_url;
`,

  // ── v46: immutable opaque public identity, independent of integer PK ────────
  `
ALTER TABLE canonical_listings ADD COLUMN public_ref TEXT NOT NULL DEFAULT '';
UPDATE canonical_listings SET public_ref='lst_'||lower(hex(randomblob(16))) WHERE public_ref='';
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_listings_public_ref ON canonical_listings(public_ref);
CREATE TRIGGER IF NOT EXISTS canonical_listing_public_ref_required
BEFORE INSERT ON canonical_listings WHEN NEW.public_ref IS NULL OR length(NEW.public_ref)<12
BEGIN SELECT RAISE(ABORT,'canonical listing public_ref is required'); END;
CREATE TRIGGER IF NOT EXISTS canonical_listing_public_ref_immutable
BEFORE UPDATE OF public_ref ON canonical_listings WHEN OLD.public_ref IS NOT NULL AND (NEW.public_ref IS NULL OR NEW.public_ref<>OLD.public_ref)
BEGIN SELECT RAISE(ABORT,'canonical listing public_ref is immutable'); END;
DELETE FROM canonical_listing_aliases WHERE namespace='public_listing_ref';
INSERT INTO canonical_listing_aliases(namespace,alias,listing_id)
  SELECT 'public_listing_ref',public_ref,id FROM canonical_listings;
DELETE FROM canonical_listing_aliases WHERE namespace='canonical_listing_id';
INSERT INTO canonical_listing_aliases(namespace,alias,listing_id)
  SELECT 'canonical_listing_id',CAST(id AS TEXT),id FROM canonical_listings;
DELETE FROM canonical_listing_aliases WHERE namespace='legacy_property_id';
INSERT OR IGNORE INTO canonical_listing_aliases(namespace,alias,listing_id)
  SELECT 'legacy_property_id',legacy_id,listing_id FROM (
    SELECT CAST(p.id AS TEXT) legacy_id,MIN(l.id) listing_id,COUNT(DISTINCT l.id) matches
    FROM canonical_listings l JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id AND o.is_current=1
    JOIN source_items s ON s.id=o.source_item_id JOIN properties p ON p.original_url=s.canonical_url OR p.source_url=s.source_url
    GROUP BY p.id HAVING COUNT(DISTINCT l.id)=1);
DELETE FROM canonical_listing_moderation;
INSERT INTO canonical_listing_moderation(listing_id,review_status,review_reason)
  SELECT l.id,
    CASE WHEN MAX(p.review_status='rejected') THEN 'rejected'
         WHEN MAX(p.review_status='pending') THEN 'pending'
         WHEN COUNT(p.id)>0 THEN 'approved' ELSE 'pending' END,
    CASE WHEN COUNT(DISTINCT COALESCE(p.review_status,'<null>'))>1 THEN 'Conflicting legacy moderation states; conservative policy applied'
         ELSE MAX(p.review_reason) END
  FROM canonical_listings l
  LEFT JOIN canonical_listing_source_occurrences o ON o.listing_id=l.id AND o.is_current=1
  LEFT JOIN source_items s ON s.id=o.source_item_id
  LEFT JOIN properties p ON p.original_url=s.canonical_url OR p.source_url=s.source_url
  GROUP BY l.id;
`,

  // ── v47: tracked links can retain stable canonical listing identity ──────────
  `
ALTER TABLE tracked_links ADD COLUMN listing_public_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_tracked_links_public_listing_ref ON tracked_links(listing_public_ref);
`,

  // ── v48: explain moderation decision provenance ──────────────────────────────
  `
ALTER TABLE canonical_listing_moderation ADD COLUMN decision_origin TEXT NOT NULL DEFAULT 'DEFAULT_PENDING'
  CHECK(decision_origin IN ('MIGRATED_LEGACY','EXPLICIT_CANONICAL','DEFAULT_PENDING'));
UPDATE canonical_listing_moderation SET decision_origin=CASE
  WHEN EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=canonical_listing_moderation.listing_id AND a.namespace='legacy_property_id')
  THEN 'MIGRATED_LEGACY' ELSE 'DEFAULT_PENDING' END;
`,

  // ── v49: canonical-only listings cannot inherit approval without an alias ────
  `
UPDATE canonical_listing_moderation SET
  review_status=CASE WHEN EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=canonical_listing_moderation.listing_id AND a.namespace='legacy_property_id')
    THEN COALESCE((SELECT CASE WHEN MAX(p.review_status='rejected') THEN 'rejected'
      WHEN MAX(p.review_status='pending') THEN 'pending' WHEN COUNT(p.id)>0 THEN 'approved' ELSE 'pending' END
      FROM canonical_listing_source_occurrences o JOIN source_items s ON s.id=o.source_item_id
      JOIN properties p ON p.original_url=s.canonical_url OR p.source_url=s.source_url
      WHERE o.listing_id=canonical_listing_moderation.listing_id AND o.is_current=1),'pending')
    ELSE 'pending' END,
  decision_origin=CASE WHEN EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=canonical_listing_moderation.listing_id AND a.namespace='legacy_property_id')
    THEN 'MIGRATED_LEGACY' ELSE 'DEFAULT_PENDING' END,
  review_reason=CASE WHEN EXISTS(SELECT 1 FROM canonical_listing_aliases a WHERE a.listing_id=canonical_listing_moderation.listing_id AND a.namespace='legacy_property_id')
    THEN review_reason ELSE 'Canonical-only listing requires explicit moderation' END;
`,

  // ── v50: moderation policy decisions retain prior state and evidence ─────────
  `
ALTER TABLE canonical_listing_moderation RENAME TO canonical_listing_moderation_v49;
CREATE TABLE canonical_listing_moderation (
  listing_id INTEGER PRIMARY KEY REFERENCES canonical_listings(id) ON DELETE CASCADE,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
  review_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  decision_origin TEXT NOT NULL DEFAULT 'DEFAULT_PENDING'
    CHECK(decision_origin IN ('MIGRATED_LEGACY','EXPLICIT_CANONICAL','DEFAULT_PENDING','INGESTION_VALIDATED_V1')),
  policy_version TEXT,
  decision_evidence_json TEXT,
  previous_review_status TEXT CHECK(previous_review_status IS NULL OR previous_review_status IN ('pending','approved','rejected')),
  decided_at TEXT,
  decision_actor TEXT NOT NULL DEFAULT 'SYSTEM' CHECK(decision_actor IN ('SYSTEM','HUMAN','AUTO_POLICY'))
);
INSERT INTO canonical_listing_moderation
  (listing_id,review_status,review_reason,updated_at,decision_origin)
SELECT listing_id,review_status,review_reason,updated_at,decision_origin FROM canonical_listing_moderation_v49;
DROP TABLE canonical_listing_moderation_v49;
CREATE INDEX IF NOT EXISTS idx_canonical_moderation_status ON canonical_listing_moderation(review_status,listing_id);
`,

  // ── v51: first-party interest, offer, and contact-grant funnel ───────────────
  `
CREATE TABLE IF NOT EXISTS listing_interests (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES canonical_listings(id) ON DELETE CASCADE,
  search_context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_listing_interests_user_created ON listing_interests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listing_interests_listing_created ON listing_interests(listing_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interest_requests (
  id TEXT PRIMARY KEY,
  interest_id TEXT NOT NULL UNIQUE REFERENCES listing_interests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES canonical_listings(id) ON DELETE CASCADE,
  request_kind TEXT NOT NULL DEFAULT 'LIGHTWEIGHT_LISTING_INTEREST'
    CHECK(request_kind IN ('LIGHTWEIGHT_LISTING_INTEREST')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_interest_requests_user_created ON interest_requests(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS listing_offers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES interest_requests(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES canonical_listings(id) ON DELETE CASCADE,
  offer_kind TEXT NOT NULL DEFAULT 'LISTING_MATCH'
    CHECK(offer_kind IN ('LISTING_MATCH')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(request_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_listing_offers_listing_created ON listing_offers(listing_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_grants (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES canonical_listings(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL UNIQUE REFERENCES listing_offers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'granted' CHECK(status IN ('granted','revoked')),
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_grants_user_granted ON contact_grants(user_id, granted_at DESC);
`,

  // ── v52: canonical Khmer24 terminal-observation state ───────────────────────
  // A source page that looks terminal is evidence, not an immediate listing
  // removal. These fields retain the confirmation state per source occurrence.
  `
ALTER TABLE canonical_listing_source_occurrences
  ADD COLUMN consecutive_terminal_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE canonical_listing_source_occurrences
  ADD COLUMN terminal_check_last_seen_at TEXT;
ALTER TABLE canonical_listing_source_occurrences
  ADD COLUMN terminal_check_confirm_after_at TEXT;
CREATE INDEX IF NOT EXISTS idx_canonical_occ_terminal_confirmation
  ON canonical_listing_source_occurrences(terminal_check_confirm_after_at);
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

/**
 * v52 bridge for observations recorded before terminal confirmation state
 * existed. It deliberately creates only a first REMOVED observation. The
 * migration never closes an occurrence or changes listing availability.
 */
export function backfillKhmer24TerminalConfirmations(db: DatabaseSync): number {
  const result = db.prepare(`
    UPDATE canonical_listing_source_occurrences AS o
    SET consecutive_terminal_checks=1,
      terminal_check_last_seen_at=o.last_seen_at,
      terminal_check_confirm_after_at=(
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ', julianday(ac.checked_at) + 0.25)
        FROM availability_checks ac WHERE ac.source_occurrence_id=o.id
        ORDER BY ac.id DESC LIMIT 1
      ),
      next_check_at=(
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ', julianday(ac.checked_at) + 0.25)
        FROM availability_checks ac WHERE ac.source_occurrence_id=o.id
        ORDER BY ac.id DESC LIMIT 1
      )
    WHERE o.is_current=1
      AND o.last_seen_at < (
        SELECT ac.checked_at FROM availability_checks ac
        WHERE ac.source_occurrence_id=o.id ORDER BY ac.id DESC LIMIT 1
      )
      AND 'REMOVED'=(
        SELECT ac.result FROM availability_checks ac
        WHERE ac.source_occurrence_id=o.id ORDER BY ac.id DESC LIMIT 1
      )
      AND 'SOURCE_RECHECK'=(
        SELECT ac.check_type FROM availability_checks ac
        WHERE ac.source_occurrence_id=o.id ORDER BY ac.id DESC LIMIT 1
      )
      AND 'KHMER24'=(
        SELECT ac.provider FROM availability_checks ac
        WHERE ac.source_occurrence_id=o.id ORDER BY ac.id DESC LIMIT 1
      )
  `).run();
  return Number(result.changes);
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

        if (version === 52) {
          const pending = backfillKhmer24TerminalConfirmations(db);
          console.log(`  🕒 Initialized ${pending} Khmer24 terminal confirmation(s)`);
        }

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
