import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, OFFLINE } from "../../lib/env";
import { logger } from "../../lib/log";
import { channelsToPoll, recordRssResult } from "../../lib/repo/channels";
import { upsertVideos } from "../../lib/repo/videos";
import type { VideoInput } from "../../lib/types";
import { parseChannelFeed } from "./parse";

const log = logger("rss");
const CONCURRENCY = 6;
/** A channel that has failed this many times in a row is skipped (deleted/private). */
const MAX_FAILS = 8;

export const feedUrl = (channelId: string) =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

type FetchOutcome =
  | { kind: "videos"; videos: VideoInput[]; etag: string | null; lastModified: string | null }
  | { kind: "not_modified" }
  | { kind: "error"; message: string };

async function fetchOne(ch: { id: string; rss_etag: string | null; rss_last_modified: string | null }): Promise<FetchOutcome> {
  if (OFFLINE()) {
    // Per-channel fixture if present, otherwise the shared one.
    const specific = path.join(FIXTURES_DIR, `channel-rss.${ch.id}.xml`);
    const file = fs.existsSync(specific) ? specific : path.join(FIXTURES_DIR, "channel-rss.xml");
    if (!fs.existsSync(file)) return { kind: "error", message: `no fixture at ${file}` };
    try {
      const { videos } = parseChannelFeed(fs.readFileSync(file, "utf8"));
      return { kind: "videos", videos, etag: null, lastModified: null };
    } catch (err) {
      return { kind: "error", message: `fixture parse failed: ${(err as Error).message}` };
    }
  }

  const headers: Record<string, string> = {
    // Conditional GET keeps unchanged feeds to a 304 with no body.
    "user-agent": "mytube/0.1 (local personal feed filter)",
  };
  if (ch.rss_etag) headers["if-none-match"] = ch.rss_etag;
  if (ch.rss_last_modified) headers["if-modified-since"] = ch.rss_last_modified;

  try {
    const res = await fetch(feedUrl(ch.id), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 304) return { kind: "not_modified" };
    if (!res.ok) return { kind: "error", message: `HTTP ${res.status}` };
    const xml = await res.text();
    const { videos } = parseChannelFeed(xml);
    return {
      kind: "videos",
      videos,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}

export type RssResult = {
  found: number;
  inserted: number;
  channels: number;
  notModified: number;
  errors: number;
};

/** Polls every subscribed channel's public RSS feed. Zero API quota. */
export async function pollRssFeeds(
  runId: number | null,
  onProgress?: (done: number, total: number) => void,
): Promise<RssResult> {
  const channels = channelsToPoll().filter((c) => c.rss_fail_count < MAX_FAILS);
  if (channels.length === 0) {
    throw new Error("no subscribed channels to poll — run the subscriptions step first");
  }

  const result: RssResult = { found: 0, inserted: 0, channels: channels.length, notModified: 0, errors: 0 };
  let done = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < channels.length) {
      const ch = channels[cursor++];
      const outcome = await fetchOne(ch);
      if (outcome.kind === "videos") {
        if (outcome.videos.length > 0) {
          const r = upsertVideos(outcome.videos, "rss", runId);
          result.found += r.found;
          result.inserted += r.inserted;
        }
        recordRssResult(ch.id, { etag: outcome.etag, lastModified: outcome.lastModified, ok: true });
      } else if (outcome.kind === "not_modified") {
        result.notModified++;
        recordRssResult(ch.id, { ok: true });
      } else {
        result.errors++;
        log.warn(`${ch.id} (${ch.title}): ${outcome.message}`);
        recordRssResult(ch.id, { ok: false });
      }
      onProgress?.(++done, channels.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, channels.length) }, worker));

  log.info(
    `${result.channels} channels: ${result.found} entries, ${result.inserted} new, ` +
      `${result.notModified} unchanged, ${result.errors} errors`,
  );
  // Individual feed failures are normal (deleted channels); a total wipeout is not.
  if (result.errors === result.channels) {
    throw new Error(`all ${result.channels} RSS feeds failed — network down or YouTube blocking`);
  }
  return result;
}
