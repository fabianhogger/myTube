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
      `SELECT * FROM channels WHERE is_subscribed = 1
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
