import type Database from "better-sqlite3";

/**
 * Numbered DDL applied via PRAGMA user_version. Append-only: never edit a
 * migration that has shipped, add the next one.
 */
const MIGRATIONS: string[] = [
  // --- 001 ----------------------------------------------------------------
  `
  CREATE TABLE channels (
    id                  TEXT PRIMARY KEY,
    title               TEXT NOT NULL,
    handle              TEXT,
    thumbnail_url       TEXT,
    uploads_playlist_id TEXT,
    is_subscribed       INTEGER NOT NULL DEFAULT 0,
    rss_etag            TEXT,
    rss_last_modified   TEXT,
    rss_fetched_at      TEXT,
    rss_fail_count      INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX idx_channels_subscribed ON channels(is_subscribed, rss_fetched_at);

  CREATE TABLE videos (
    id               TEXT PRIMARY KEY,
    channel_id       TEXT REFERENCES channels(id) ON DELETE SET NULL,
    channel_title    TEXT,
    title            TEXT NOT NULL,
    description      TEXT,
    duration_seconds INTEGER,
    published_at     TEXT,
    published_approx INTEGER NOT NULL DEFAULT 0,
    view_count       INTEGER,
    thumbnail_url    TEXT,
    is_short         INTEGER NOT NULL DEFAULT 0,
    is_live          INTEGER NOT NULL DEFAULT 0,
    is_upcoming      INTEGER NOT NULL DEFAULT 0,
    sources          TEXT NOT NULL DEFAULT '[]',
    first_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    last_seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    enriched_at      TEXT,
    raw_json         TEXT,
    CHECK (json_valid(sources))
  );
  CREATE INDEX idx_videos_published  ON videos(published_at DESC);
  CREATE INDEX idx_videos_channel    ON videos(channel_id, published_at DESC);
  CREATE INDEX idx_videos_unenriched ON videos(enriched_at) WHERE enriched_at IS NULL;
  CREATE INDEX idx_videos_first_seen ON videos(first_seen_at DESC);

  CREATE TABLE ingest_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    status       TEXT NOT NULL CHECK (status IN ('running','done','partial','failed','stale')),
    trigger      TEXT NOT NULL CHECK (trigger IN ('ui','cli','startup')),
    pid          INTEGER,
    phase        TEXT,
    progress     TEXT,
    stats        TEXT,
    error        TEXT,
    started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    heartbeat_at TEXT,
    finished_at  TEXT
  );
  CREATE INDEX idx_runs_started ON ingest_runs(started_at DESC);

  CREATE TABLE ingest_source_runs (
    run_id      INTEGER NOT NULL REFERENCES ingest_runs(id) ON DELETE CASCADE,
    source      TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
    items_found INTEGER NOT NULL DEFAULT 0,
    items_new   INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    finished_at TEXT,
    PRIMARY KEY (run_id, source)
  ) WITHOUT ROWID;

  CREATE TABLE video_sightings (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    source   TEXT NOT NULL,
    run_id   INTEGER REFERENCES ingest_runs(id) ON DELETE SET NULL,
    position INTEGER,
    seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX idx_sightings_video ON video_sightings(video_id, seen_at DESC);
  CREATE UNIQUE INDEX idx_sightings_run_uniq ON video_sightings(run_id, source, video_id);

  CREATE TABLE filter_prompts (
    hash             TEXT PRIMARY KEY,
    prompt_text      TEXT NOT NULL,
    model            TEXT NOT NULL,
    pipeline_version INTEGER NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE filter_batches (
    id                TEXT PRIMARY KEY,
    run_id            INTEGER REFERENCES ingest_runs(id) ON DELETE SET NULL,
    prompt_hash       TEXT NOT NULL REFERENCES filter_prompts(hash),
    video_ids         TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
    attempt           INTEGER NOT NULL DEFAULT 0,
    input_tokens      INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    output_tokens     INTEGER,
    cost_usd          REAL,
    error             TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    finished_at       TEXT,
    CHECK (json_valid(video_ids))
  );
  CREATE INDEX idx_batches_status ON filter_batches(status, created_at);

  CREATE TABLE filter_verdicts (
    video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    prompt_hash TEXT NOT NULL REFERENCES filter_prompts(hash) ON DELETE CASCADE,
    decision    TEXT NOT NULL CHECK (decision IN ('pass','block','error')),
    confidence  REAL,
    reason      TEXT NOT NULL DEFAULT '',
    tags        TEXT,
    batch_id    TEXT REFERENCES filter_batches(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (video_id, prompt_hash)
  ) WITHOUT ROWID;
  CREATE INDEX idx_verdicts_prompt_decision ON filter_verdicts(prompt_hash, decision);

  CREATE TABLE oauth_tokens (
    provider      TEXT PRIMARY KEY,
    access_token  TEXT,
    refresh_token TEXT NOT NULL,
    expires_at    TEXT,
    scope         TEXT NOT NULL,
    token_type    TEXT NOT NULL DEFAULT 'Bearer',
    obtained_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  `,
];

export function migrate(db: Database.Database): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= MIGRATIONS.length) return current;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      // user_version does not accept a bound parameter.
      db.pragma(`user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${v + 1} failed: ${(err as Error).message}`);
    }
  }
  return MIGRATIONS.length;
}

export const SCHEMA_VERSION = MIGRATIONS.length;
