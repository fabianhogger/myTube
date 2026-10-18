/** Every place a video can come from. Stored in videos.sources and video_sightings.source. */
export type Source = "rss" | "api" | "scrape_home" | "scrape_subs";

export const SCRAPE_SOURCES: Source[] = ["scrape_home", "scrape_subs"];

/** The normalized shape every ingest source produces. Written only via upsertVideo. */
export type VideoInput = {
  id: string;
  channelId?: string | null;
  channelTitle?: string | null;
  title: string;
  description?: string | null;
  durationSeconds?: number | null;
  publishedAt?: string | null;
  /** 1 when publishedAt was derived from a relative string like "3 days ago". */
  publishedApprox?: boolean;
  viewCount?: number | null;
  thumbnailUrl?: string | null;
  isShort?: boolean;
  isLive?: boolean;
  isUpcoming?: boolean;
  raw?: unknown;
};

export type ChannelInput = {
  id: string;
  title: string;
  handle?: string | null;
  thumbnailUrl?: string | null;
  uploadsPlaylistId?: string | null;
  isSubscribed?: boolean;
};

export type VideoRow = {
  id: string;
  channel_id: string | null;
  channel_title: string | null;
  title: string;
  description: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  published_approx: number;
  view_count: number | null;
  thumbnail_url: string | null;
  is_short: number;
  is_live: number;
  is_upcoming: number;
  sources: string;
  first_seen_at: string;
  last_seen_at: string;
  enriched_at: string | null;
};

export type Decision = "pass" | "block" | "error";

export type RunStatus = "running" | "done" | "partial" | "failed" | "stale";
export type SourceStatus = "running" | "ok" | "failed" | "skipped";

export type IngestRunRow = {
  id: number;
  status: RunStatus;
  trigger: "ui" | "cli" | "startup";
  pid: number | null;
  phase: string | null;
  progress: string | null;
  stats: string | null;
  error: string | null;
  started_at: string;
  heartbeat_at: string | null;
  finished_at: string | null;
};

export type SourceRunRow = {
  run_id: number;
  source: string;
  status: SourceStatus;
  items_found: number;
  items_new: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

/** Named failure modes the UI renders as instructions rather than stack traces. */
export class NamedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "NamedError";
  }
}
