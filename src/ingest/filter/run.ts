import { getDb } from "../../lib/db";
import { FAKE_LLM } from "../../lib/env";
import { logger } from "../../lib/log";
import { getActivePrompt } from "../../lib/prompt";
import { completeBatch, claimBatch } from "../../lib/repo/verdicts";
import { countNeedingFilter, videosNeedingFilter } from "../../lib/repo/videos";
import type { VideoRow } from "../../lib/types";
import { planSystem } from "./client";
import { runBatch } from "./batch";
import { BATCH_SIZE } from "./schema";

const log = logger("filter");

const CONCURRENCY = 3;

/**
 * Hard ceiling on what one filter run may spend, enforced between batches.
 * Without it, a single careless invocation can judge a multi-thousand-video
 * backlog at full price before anyone notices. Raise it deliberately via
 * MYTUBE_MAX_SPEND_USD when you actually intend to clear a large backlog.
 */
const DEFAULT_MAX_SPEND_USD = 2.0;
const maxSpend = () => {
  const raw = Number(process.env.MYTUBE_MAX_SPEND_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_SPEND_USD;
};

export type FilterResult = {
  judged: number;
  pass: number;
  block: number;
  errored: number;
  batches: number;
  costUsd: number;
  cacheRead: number;
  promptHash: string;
};

/**
 * A batch that keeps failing on its own is poisonous (e.g. a title that trips a
 * classifier). Recording an `error` verdict stops it being re-sent on every
 * future run; `error` is excluded from the feed and visible in the CLI.
 */
function recordErrorVerdicts(rows: VideoRow[], promptHash: string, reason: string) {
  const batchId = claimBatch(promptHash, rows.map((r) => r.id), null);
  completeBatch(
    batchId,
    promptHash,
    rows.map((r) => ({
      videoId: r.id,
      decision: "error" as const,
      confidence: null,
      reason: reason.slice(0, 300),
      tags: null,
    })),
    { costUsd: 0 },
  );
}

export async function runFilter(
  runId: number | null,
  opts: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<FilterResult> {
  const prompt = getActivePrompt();
  const pending = videosNeedingFilter(prompt.hash, opts.limit ?? 1000);

  const result: FilterResult = {
    judged: 0, pass: 0, block: 0, errored: 0,
    batches: 0, costUsd: 0, cacheRead: 0, promptHash: prompt.hash,
  };

  if (pending.length === 0) {
    log.info(`nothing to filter (prompt ${prompt.hash})`);
    return result;
  }

  // FAKE_LLM decides locally, so there is no prefix to plan or token call to make.
  const system = FAKE_LLM()
    ? { blocks: [], cached: false, tokens: 0 }
    : await planSystem(prompt.model, prompt.text);

  const batches: VideoRow[][] = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) batches.push(pending.slice(i, i + BATCH_SIZE));
  log.info(`${pending.length} videos to judge in ${batches.length} batch(es), prompt ${prompt.hash}`);

  let done = 0;

  const limit = maxSpend();
  let stoppedOnBudget = false;

  /** Processes one batch, binary-splitting on failure to isolate the bad item. */
  async function process(rows: VideoRow[]): Promise<void> {
    if (result.costUsd >= limit) {
      if (!stoppedOnBudget) {
        stoppedOnBudget = true;
        log.warn(
          `spend cap reached ($${result.costUsd.toFixed(2)} of $${limit.toFixed(2)}) — ` +
            "stopping. Unjudged videos are picked up on the next run. " +
            "Raise it with MYTUBE_MAX_SPEND_USD=<dollars>.",
        );
      }
      return;
    }
    const outcome = await runBatch(rows, prompt.hash, system, prompt.model, runId);
    result.batches++;
    result.costUsd += outcome.costUsd;
    result.cacheRead += outcome.cacheRead;

    if (!outcome.error) {
      for (const v of outcome.verdicts) {
        result.judged++;
        if (v.decision === "pass") result.pass++;
        else if (v.decision === "block") result.block++;
      }
      done += rows.length;
      opts.onProgress?.(Math.min(done, pending.length), pending.length);
      return;
    }

    if (rows.length === 1) {
      // One video, repeatedly rejected: mark it and move on.
      recordErrorVerdicts(rows, prompt.hash, outcome.error);
      result.errored++;
      done += 1;
      opts.onProgress?.(Math.min(done, pending.length), pending.length);
      log.warn(`${rows[0].id} "${rows[0].title.slice(0, 60)}" could not be judged: ${outcome.error}`);
      return;
    }

    const mid = Math.floor(rows.length / 2);
    log.warn(`splitting failed batch of ${rows.length} to isolate the cause`);
    await process(rows.slice(0, mid));
    await process(rows.slice(mid));
  }

  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
      while (cursor < batches.length) {
        await process(batches[cursor++]);
      }
    }),
  );

  log.info(
    `judged ${result.judged} (${result.pass} pass, ${result.block} block, ${result.errored} error) ` +
      `in ${result.batches} batch(es), $${result.costUsd.toFixed(4)}, cache_read ${result.cacheRead} tokens`,
  );
  if (stoppedOnBudget) {
    const left = countNeedingFilter(prompt.hash);
    log.warn(`${left} video(s) still unjudged because of the spend cap.`);
  }
  return result;
}

/** Used by the UI to warn before a prompt change triggers a full re-filter. */
export function refilterEstimate(promptHash: string): { pending: number; estimatedUsd: number } {
  const pending = getDb()
    .prepare(
      `SELECT COUNT(*) FROM videos v
       LEFT JOIN filter_verdicts fv ON fv.video_id = v.id AND fv.prompt_hash = ?
       WHERE fv.video_id IS NULL AND v.is_upcoming = 0`,
    )
    .pluck()
    .get(promptHash) as number;
  // ~$0.003/video measured at effort "low".
  return { pending, estimatedUsd: Number((pending * 0.003).toFixed(2)) };
}
