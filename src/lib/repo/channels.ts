import { getDb, nowIso } from "../db";
import type { ChannelInput } from "../types";

export type ChannelRow = {
  id: string;
  title: string;
  handle: string | null;
  thumbnail_url: string | null;
  uploads_playlist_id: string | null;
  is_subscribed: number;
  rss_etag: string | null;
  rss_last_modified: string | null;
  rss_fetched_at: string | null;
  rss_fail_count: number;
  is_banned: number;
  banned_at: string | null;
  banned_reason: string | null;
  country: string | null;
  subscriber_count: number | null;
};

/** UCxxxx -> UUxxxx: the uploads playlist id is the channel id with the 2nd char swapped. */
export function uploadsPlaylistId(channelId: string): string {
  return channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : channelId;
}

const UPSERT = `
INSERT INTO channels (id, title, handle, thumbnail_url, uploads_playlist_id, is_subscribed, updated_at)
VALUES (@id, @title, @handle, @thumbnail_url, @uploads_playlist_id, @is_subscribed, @now)
ON CONFLICT(id) DO UPDATE SET
  title               = COALESCE(NULLIF(excluded.title, ''), channels.title),
  handle              = COALESCE(excluded.handle, channels.handle),
  thumbnail_url       = COALESCE(excluded.thumbnail_url, channels.thumbnail_url),
  uploads_playlist_id = COALESCE(excluded.uploads_playlist_id, channels.uploads_playlist_id),
  -- subscription status is sticky: a scrape sighting must not unset it
  is_subscribed       = MAX(channels.is_subscribed, excluded.is_subscribed),
  updated_at          = @now
`;

export function upsertChannels(inputs: ChannelInput[]): { found: number; inserted: number } {
  const db = getDb();
  const stmt = db.prepare(UPSERT);
  const exists = db.prepare("SELECT 1 FROM channels WHERE id = ?").pluck();
  const run = db.transaction((rows: ChannelInput[]) => {
    const now = nowIso();
    let inserted = 0;
    for (const c of rows) {
      if (!exists.get(c.id)) inserted++;
      stmt.run({
        id: c.id,
        title: c.title,
        handle: c.handle ?? null,
        thumbnail_url: c.thumbnailUrl ?? null,
        uploads_playlist_id: c.uploadsPlaylistId ?? uploadsPlaylistId(c.id),
        is_subscribed: c.isSubscribed ? 1 : 0,
        now,
      });
    }
    return inserted;
  });
  return { found: inputs.length, inserted: run(inputs) };
}

/** Subscribed channels, least-recently-polled first so a partial run still makes progress. */
export function channelsToPoll(limit = 500): ChannelRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM channels WHERE is_subscribed = 1 AND is_banned = 0
       ORDER BY rss_fetched_at IS NOT NULL, rss_fetched_at ASC LIMIT ?`,
    )
    .all(limit) as ChannelRow[];
}

export function recordRssResult(
  channelId: string,
  result: { etag?: string | null; lastModified?: string | null; ok: boolean },
): void {
  getDb()
    .prepare(
      `UPDATE channels SET
         rss_etag          = COALESCE(?, rss_etag),
         rss_last_modified = COALESCE(?, rss_last_modified),
         rss_fetched_at    = ?,
         rss_fail_count    = CASE WHEN ? THEN 0 ELSE rss_fail_count + 1 END
       WHERE id = ?`,
    )
    .run(result.etag ?? null, result.lastModified ?? null, nowIso(), result.ok ? 1 : 0, channelId);
}

export function countSubscribed(): number {
  return getDb().prepare("SELECT COUNT(*) FROM channels WHERE is_subscribed = 1").pluck().get() as number;
}

export function getChannel(id: string): ChannelRow | undefined {
  return getDb().prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
}


// --- bans -----------------------------------------------------------------

/**
 * Resolving a human query to channels. Exact id wins, then exact title, then a
 * case-insensitive substring. Returning every match (rather than guessing) lets
 * the caller confirm before banning the wrong thing.
 */
export function findChannels(query: string): ChannelRow[] {
  const db = getDb();
  const byId = db.prepare("SELECT * FROM channels WHERE id = ?").all(query) as ChannelRow[];
  if (byId.length) return byId;
  const exact = db.prepare("SELECT * FROM channels WHERE title = ? COLLATE NOCASE").all(query) as ChannelRow[];
  if (exact.length) return exact;
  const handle = query.startsWith("@") ? query.slice(1) : query;
  return db
    .prepare(
      `SELECT * FROM channels
       WHERE title LIKE '%' || ? || '%' COLLATE NOCASE
          OR handle LIKE '%' || ? || '%' COLLATE NOCASE
       ORDER BY is_subscribed DESC, title`,
    )
    .all(handle, handle) as ChannelRow[];
}

export function setBanned(ids: string[], banned: boolean, reason?: string): number {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE channels SET is_banned = ?, banned_at = ?, banned_reason = ? WHERE id = ?`,
  );
  const now = nowIso();
  return db.transaction((xs: string[]) => {
    let n = 0;
    for (const id of xs) n += stmt.run(banned ? 1 : 0, banned ? now : null, banned ? (reason ?? null) : null, id).changes;
    return n;
  })(ids);
}

export function bannedChannels(): ChannelRow[] {
  return getDb()
    .prepare("SELECT * FROM channels WHERE is_banned = 1 ORDER BY title")
    .all() as ChannelRow[];
}

export function channelsByCountry(country: string): ChannelRow[] {
  return getDb()
    .prepare("SELECT * FROM channels WHERE country = ? COLLATE NOCASE ORDER BY title")
    .all(country) as ChannelRow[];
}

/** Channel listing with video and verdict counts, for the CLI. */
export function channelOverview(promptHash: string) {
  return getDb()
    .prepare(
      `SELECT c.id, c.title, c.country, c.is_banned, c.is_subscribed, c.banned_reason,
              COUNT(v.id) AS videos,
              SUM(CASE WHEN fv.decision = 'pass' THEN 1 ELSE 0 END) AS passed
       FROM channels c
       LEFT JOIN videos v ON v.channel_id = c.id
       LEFT JOIN filter_verdicts fv ON fv.video_id = v.id AND fv.prompt_hash = ?
       GROUP BY c.id
       ORDER BY videos DESC, c.title`,
    )
    .all(promptHash) as {
    id: string; title: string; country: string | null; is_banned: number;
    is_subscribed: number; banned_reason: string | null; videos: number; passed: number;
  }[];
}

export function setChannelMeta(rows: { id: string; country?: string | null; subscriberCount?: number | null }[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE channels SET country = COALESCE(?, country), subscriber_count = COALESCE(?, subscriber_count) WHERE id = ?`,
  );
  db.transaction((xs: typeof rows) => {
    for (const r of xs) stmt.run(r.country ?? null, r.subscriberCount ?? null, r.id);
  })(rows);
}
