import { logger } from "../lib/log";
import { finishRun, finishSource, heartbeat, startSource } from "../lib/repo/runs";
import { countSubscribed } from "../lib/repo/channels";
import { enrichVideos } from "./google/videos-list";
import { syncSubscriptions } from "./google/subscriptions";
import { pollRssFeeds } from "./rss/fetch";
import { scrapeFeed, TARGETS } from "./scrape/feed";
import { runFilter } from "./filter/run";
import { NamedError, type SourceStatus } from "../lib/types";

const log = logger("ingest");

export type StageName = "subscriptions" | "rss" | "enrich" | "scrape_home" | "scrape_subs" | "filter";
export const ALL_STAGES: StageName[] = ["subscriptions", "rss", "enrich", "scrape_home", "scrape_subs", "filter"];

export type IngestOptions = {
  runId: number | null;
  only?: StageName[];
  dryRun?: boolean;
};

type StageOutcome = { status: SourceStatus; found: number; new: number; error?: string };

/**
 * Each stage runs in its own try/catch and writes its own source row. One stage
 * failing makes the run `partial`, never `failed` — a broken scraper must not
 * take the RSS feed down with it.
 */
export async function runIngest(opts: IngestOptions): Promise<{ status: "done" | "partial" | "failed"; stages: Record<string, StageOutcome> }> {
  const { runId } = opts;
  const stages = new Set(opts.only ?? ALL_STAGES);
  const outcomes: Record<string, StageOutcome> = {};

  const beat = (phase: string, progress?: unknown) => {
    if (runId != null) heartbeat(runId, phase, progress);
  };

  async function stage(name: StageName, fn: () => Promise<{ found: number; new: number }>): Promise<void> {
    if (!stages.has(name)) {
      outcomes[name] = { status: "skipped", found: 0, new: 0 };
      return;
    }
    if (opts.dryRun) {
      log.info(`[dry-run] would run ${name}`);
      outcomes[name] = { status: "skipped", found: 0, new: 0 };
      return;
    }
    beat(name, { message: `running ${name}` });
    if (runId != null) startSource(runId, name);
    try {
      const counts = await fn();
      outcomes[name] = { status: "ok", ...counts };
      if (runId != null) finishSource(runId, name, "ok", counts);
    } catch (err) {
      const e = err as Error;
      const msg = e instanceof NamedError ? `${e.code}: ${e.message}` : e.message;
      log.error(`${name} failed — ${msg}`);
      outcomes[name] = { status: "failed", found: 0, new: 0, error: msg };
      if (runId != null) finishSource(runId, name, "failed", {}, msg);
    }
  }

  // --- Source A: OAuth subscriptions, then zero-quota RSS polling -----------
  await stage("subscriptions", async () => {
    const r = await syncSubscriptions();
    return { found: r.found, new: r.inserted };
  });

  await stage("rss", async () => {
    const r = await pollRssFeeds(runId, (d, t) => beat("rss", { done: d, total: t, message: `polling feeds ${d}/${t}` }));
    return { found: r.found, new: r.inserted };
  });

  await stage("enrich", async () => {
    const r = await enrichVideos(runId);
    return { found: r.requested, new: r.enriched };
  });

  // --- Source B: the logged-in algorithmic feed ------------------------------
  await stage("scrape_home", async () => {
    const r = await scrapeFeed(TARGETS.home, runId);
    return { found: r.found, new: r.inserted };
  });

  await stage("scrape_subs", async () => {
    const r = await scrapeFeed(TARGETS.subs, runId);
    return { found: r.found, new: r.inserted };
  });

  // --- The actual feature ---------------------------------------------------
  await stage("filter", async () => {
    const r = await runFilter(runId, {
      onProgress: (d, t) => beat("filter", { done: d, total: t, message: `judging videos ${d}/${t}` }),
    });
    return { found: r.judged, new: r.pass };
  });

  const ran = Object.entries(outcomes).filter(([, o]) => o.status !== "skipped");
  const failed = ran.filter(([, o]) => o.status === "failed");
  const status = ran.length === 0 ? "done" : failed.length === 0 ? "done" : failed.length === ran.length ? "failed" : "partial";

  if (runId != null) {
    finishRun(
      runId,
      status,
      { stages: outcomes, subscribed: countSubscribed() },
      failed.length ? failed.map(([n, o]) => `${n}: ${o.error}`).join("; ") : null,
    );
  }

  log.info(`run ${runId ?? "(adhoc)"} ${status}`);
  for (const [name, o] of Object.entries(outcomes)) {
    if (o.status === "skipped") continue;
    log.info(`  ${name.padEnd(13)} ${o.status.padEnd(7)} found=${o.found} new=${o.new}${o.error ? ` (${o.error})` : ""}`);
  }
  return { status, stages: outcomes };
}
