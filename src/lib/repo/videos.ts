import { getDb, nowIso } from "../db";
import type { Source, VideoInput, VideoRow } from "../types";

/**
 * Field-level precedence: api > rss > scrape. A weaker source must never
 * overwrite a stronger value, and a video first seen by the scraper (with only
 * a relative "3 days ago") must be upgraded when RSS later supplies the exact
 * timestamp — that published_approx CASE is the only real logic here.
 */
const UPSERT_VIDEO = `
INSERT INTO videos (
  id, channel_id, channel_title, title, description, duration_seconds,
  published_at, published_approx, view_count, thumbnail_url,
  is_short, is_live, is_upcoming, sources, raw_json, first_seen_at, last_seen_at
) VALUES (
  @id, @channel_id, @channel_title, @title, @description, @duration_seconds,
  @published_at, @published_approx, @view_count, @thumbnail_url,
  @is_short, @is_live, @is_upcoming, json_array(@source), @raw_json, @now, @now
)
ON CONFLICT(id) DO UPDATE SET
  title            = COALESCE(NULLIF(excluded.title, ''), videos.title),
  description      = CASE WHEN length(COALESCE(excluded.description, '')) >
                               length(COALESCE(videos.description, ''))
                          THEN excluded.description ELSE videos.description END,
  duration_seconds = COALESCE(videos.duration_seconds, excluded.duration_seconds),
  view_count       = COALESCE(excluded.view_count, videos.view_count),
  channel_id       = COALESCE(videos.channel_id, excluded.channel_id),
  channel_title    = COALESCE(NULLIF(videos.channel_title, ''), excluded.channel_title),
  published_at     = CASE
                       WHEN videos.published_approx = 1 AND excluded.published_approx = 0
                         THEN excluded.published_at
                       ELSE COALESCE(videos.published_at, excluded.published_at)
                     END,
  published_approx = CASE
                       WHEN excluded.published_approx = 0 AND excluded.published_at IS NOT NULL
                         THEN 0
                       ELSE videos.published_approx
                     END,
  thumbnail_url    = COALESCE(NULLIF(excluded.thumbnail_url, ''), videos.thumbnail_url),
  is_short         = MAX(videos.is_short, excluded.is_short),
  is_live          = excluded.is_live,
  is_upcoming      = excluded.is_upcoming,
  sources          = CASE
                       WHEN EXISTS (SELECT 1 FROM json_each(videos.sources) WHERE value = @source)
                         THEN videos.sources
                       ELSE json_insert(videos.sources, '$[#]', @source)
                     END,
  last_seen_at     = @now,
  raw_json         = COALESCE(excluded.raw_json, videos.raw_json)
`;

/**
 * Videos routinely arrive referencing a channel we have never recorded (a
 * scraped recommendation from a channel you do not subscribe to). The FK would
 * reject those, so a stub channel row is created first. is_subscribed stays 0,
 * and upsertChannels later fills in the real title without clobbering it.
 */
const ENSURE_CHANNEL = `
INSERT INTO channels (id, title, is_subscribed, uploads_playlist_id)
VALUES (@id, @title, 0, @uploads)
ON CONFLICT(id) DO NOTHING
`;

const INSERT_SIGHTING = `
INSERT INTO video_sightings (video_id, source, run_id, position, seen_at)
VALUES (@video_id, @source, @run_id, @position, @now)
ON CONFLICT(run_id, source, video_id) DO NOTHING
`;

export type UpsertResult = { found: number; inserted: number };

/**
 * Writes a batch of videos from one source inside a single transaction.
 * better-sqlite3 is synchronous, so loose upserts mean one fsync each.
 */
export function upsertVideos(
  inputs: VideoInput[],
  source: Source,
  runId: number | null,
  opts: { positions?: boolean } = {},
): UpsertResult {
  const db = getDb();
  const upsert = db.prepare(UPSERT_VIDEO);
  const sighting = db.prepare(INSERT_SIGHTING);
  const ensureChannel = db.prepare(ENSURE_CHANNEL);
  const exists = db.prepare("SELECT 1 FROM videos WHERE id = ?").pluck();

  const run = db.transaction((rows: VideoInput[]) => {
    const now = nowIso();
    let inserted = 0;
    rows.forEach((v, i) => {
      if (!exists.get(v.id)) inserted++;
      if (v.channelId) {
        ensureChannel.run({
          id: v.channelId,
          title: v.channelTitle ?? v.channelId,
          uploads: v.channelId.startsWith("UC") ? `UU${v.channelId.slice(2)}` : v.channelId,
        });
      }
      upsert.run({
        id: v.id,
        channel_id: v.channelId ?? null,
        channel_title: v.channelTitle ?? null,
        title: v.title,
        description: v.description ?? null,
        duration_seconds: v.durationSeconds ?? null,
        published_at: v.publishedAt ?? null,
        published_approx: v.publishedApprox ? 1 : 0,
        view_count: v.viewCount ?? null,
        thumbnail_url: v.thumbnailUrl ?? null,
        is_short: v.isShort ? 1 : 0,
        is_live: v.isLive ? 1 : 0,
        is_upcoming: v.isUpcoming ? 1 : 0,
        source,
        raw_json: v.raw === undefined ? null : JSON.stringify(v.raw),
        now,
      });
      sighting.run({
        video_id: v.id,
        source,
        run_id: runId,
        position: opts.positions ? i : null,
        now,
      });
    });
    return inserted;
  });

  const inserted = run(inputs);
  return { found: inputs.length, inserted };
}

/** Marks enrichment applied; duration/views already came through upsertVideos. */
export function markEnriched(ids: string[]): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE videos SET enriched_at = ? WHERE id = ?");
  const now = nowIso();
  db.transaction((xs: string[]) => xs.forEach((id) => stmt.run(now, id)))(ids);
}

export function videosNeedingEnrichment(limit = 200): string[] {
  return getDb()
    .prepare("SELECT id FROM videos WHERE enriched_at IS NULL ORDER BY first_seen_at DESC LIMIT ?")
    .pluck()
    .all(limit) as string[];
}

/**
 * Videos with no verdict under the *current* prompt hash. A prompt edit needs no
 * invalidation pass: this left-join simply starts returning rows again.
 */
export function videosNeedingFilter(promptHash: string, limit = 1000): VideoRow[] {
  return getDb()
    .prepare(
      `SELECT v.* FROM videos v
       LEFT JOIN filter_verdicts fv ON fv.video_id = v.id AND fv.prompt_hash = ?
       WHERE fv.video_id IS NULL AND v.is_upcoming = 0
       ORDER BY v.first_seen_at DESC LIMIT ?`,
    )
    .all(promptHash, limit) as VideoRow[];
}

export function countNeedingFilter(promptHash: string): number {
  return getDb()
    .prepare(
      `SELECT COUNT(*) FROM videos v
       LEFT JOIN filter_verdicts fv ON fv.video_id = v.id AND fv.prompt_hash = ?
       WHERE fv.video_id IS NULL AND v.is_upcoming = 0`,
    )
    .pluck()
    .get(promptHash) as number;
}

/**
 * The feed. Score is computed at query time because it decays with wall-clock
 * time; storing it would mean a rank that is wrong the moment it is written.
 * The trailing `v.id` tiebreak matters — without a total order, equal scores
 * swap between requests and the grid duplicates cards.
 */
export function feed(promptHash: string, opts: { includeShorts?: boolean; limit?: number } = {}): VideoRow[] {
  return getDb()
    .prepare(
      `SELECT v.* FROM videos v
       JOIN filter_verdicts fv ON fv.video_id = v.id AND fv.prompt_hash = @hash
       LEFT JOIN (
         SELECT video_id, MIN(position) AS best_pos
         FROM video_sightings WHERE source LIKE 'scrape%' AND position IS NOT NULL
         GROUP BY video_id
       ) s ON s.video_id = v.id
       WHERE fv.decision = 'pass'
         AND v.is_upcoming = 0
         AND (@include_shorts = 1 OR v.is_short = 0)
       ORDER BY (
           1.0 / (1.0 + (julianday('now') - julianday(COALESCE(v.published_at, v.first_seen_at))) / 3.0)
         + CASE WHEN s.best_pos IS NULL THEN 0.0
                ELSE 0.5 * (1.0 / (1.0 + s.best_pos / 6.0)) END
         + CASE WHEN json_array_length(v.sources) > 1 THEN 0.15 ELSE 0.0 END
         + CASE WHEN EXISTS (SELECT 1 FROM channels c
                             WHERE c.id = v.channel_id AND c.is_subscribed = 1) THEN 0.10 ELSE 0.0 END
         ) DESC,
         v.first_seen_at DESC,
         v.id
       LIMIT @limit`,
    )
    .all({
      hash: promptHash,
      include_shorts: opts.includeShorts ? 1 : 0,
      limit: opts.limit ?? 60,
    }) as VideoRow[];
}

export function getVideo(id: string): VideoRow | undefined {
  return getDb().prepare("SELECT * FROM videos WHERE id = ?").get(id) as VideoRow | undefined;
}

export function videoStats(promptHash: string) {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) FROM videos").pluck().get() as number;
  const byDecision = db
    .prepare(
      `SELECT decision, COUNT(*) AS n FROM filter_verdicts
       WHERE prompt_hash = ? GROUP BY decision`,
    )
    .all(promptHash) as { decision: string; n: number }[];
  const counts = Object.fromEntries(byDecision.map((r) => [r.decision, r.n]));
  return {
    total,
    pass: counts.pass ?? 0,
    block: counts.block ?? 0,
    error: counts.error ?? 0,
    unjudged: countNeedingFilter(promptHash),
  };
}
