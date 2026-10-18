import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, OFFLINE } from "../../lib/env";
import { cleanDescription, parseIso8601Duration } from "../../lib/format";
import { logger } from "../../lib/log";
import { markEnriched, upsertVideos, videosNeedingEnrichment } from "../../lib/repo/videos";
import type { VideoInput } from "../../lib/types";
import { authorizedClient, youtubeClient } from "./oauth";

const log = logger("enrich");
/** videos.list accepts at most 50 ids per call. One call per video would burn the daily quota. */
const IDS_PER_CALL = 50;
/** A Short is <= 3 minutes; YouTube exposes no reliable flag on this endpoint. */
const SHORT_MAX_SECONDS = 180;

type RawVideo = {
  id?: string | null;
  snippet?: {
    title?: string | null;
    description?: string | null;
    channelId?: string | null;
    channelTitle?: string | null;
    publishedAt?: string | null;
    thumbnails?: Record<string, { url?: string | null } | undefined> | null;
    liveBroadcastContent?: string | null;
  } | null;
  contentDetails?: { duration?: string | null } | null;
  statistics?: { viewCount?: string | null } | null;
};

function bestThumb(thumbs: RawVideo["snippet"] extends infer _ ? any : never): string | null {
  for (const key of ["maxres", "standard", "high", "medium", "default"]) {
    const url = thumbs?.[key]?.url;
    if (url) return url;
  }
  return null;
}

function toVideoInput(v: RawVideo): VideoInput | null {
  const id = v.id;
  const title = v.snippet?.title;
  if (!id || !title) return null;
  const duration = parseIso8601Duration(v.contentDetails?.duration ?? null);
  const live = v.snippet?.liveBroadcastContent;
  return {
    id,
    channelId: v.snippet?.channelId ?? null,
    channelTitle: v.snippet?.channelTitle ?? null,
    title,
    description: cleanDescription(v.snippet?.description ?? null, 5000),
    durationSeconds: duration,
    publishedAt: v.snippet?.publishedAt ?? null,
    publishedApprox: false,
    viewCount: v.statistics?.viewCount != null ? Number(v.statistics.viewCount) : null,
    thumbnailUrl: bestThumb(v.snippet?.thumbnails),
    isShort: duration != null && duration <= SHORT_MAX_SECONDS,
    isLive: live === "live",
    isUpcoming: live === "upcoming",
  };
}

export type EnrichResult = { requested: number; enriched: number; calls: number };

/**
 * Fills in duration, view count and the exact publish timestamp. This is the
 * only stage that spends YouTube API quota beyond the subscription list.
 */
export async function enrichVideos(runId: number | null, limit = 200): Promise<EnrichResult> {
  const ids = videosNeedingEnrichment(limit);
  if (ids.length === 0) {
    log.info("nothing to enrich");
    return { requested: 0, enriched: 0, calls: 0 };
  }

  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_CALL) batches.push(ids.slice(i, i + IDS_PER_CALL));

  let raw: RawVideo[] = [];
  if (OFFLINE()) {
    const file = path.join(FIXTURES_DIR, "videos-list.json");
    log.info(`offline: reading ${file}`);
    const fixture = JSON.parse(fs.readFileSync(file, "utf8")) as { items?: RawVideo[] };
    const wanted = new Set(ids);
    raw = (fixture.items ?? []).filter((v) => v.id && wanted.has(v.id));
  } else {
    const yt = youtubeClient(await authorizedClient());
    for (const batch of batches) {
      const res = await yt.videos.list({
        part: ["snippet", "contentDetails", "statistics"],
        id: batch,
        maxResults: IDS_PER_CALL,
      });
      raw = raw.concat((res.data.items ?? []) as RawVideo[]);
    }
  }

  const inputs = raw.map(toVideoInput).filter((v): v is VideoInput => v !== null);
  if (inputs.length > 0) upsertVideos(inputs, "api", runId);

  // Mark every requested id enriched, not just the ones that came back: a video
  // that is deleted or private returns nothing and would otherwise be retried forever.
  markEnriched(ids);

  log.info(`${ids.length} requested, ${inputs.length} enriched in ${batches.length} call(s)`);
  return { requested: ids.length, enriched: inputs.length, calls: OFFLINE() ? 0 : batches.length };
}
