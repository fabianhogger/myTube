import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { cleanDescription, formatDuration, formatRelativeAge, formatViewCount } from "../../lib/format";
import { logger } from "../../lib/log";
import { FAKE_LLM } from "../../lib/env";
import { claimBatch, completeBatch, failBatch, markBatchRunning, type Verdict } from "../../lib/repo/verdicts";
import type { VideoRow } from "../../lib/types";
import { anthropic, estimateCost, type SystemPlan } from "./client";
import { VERDICT_SCHEMA, type VideoForFilter } from "./schema";

const log = logger("filter:batch");

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = (s: number | undefined) => s === 408 || s === 409 || s === 429 || (s != null && s >= 500);

/** Builds the per-video payload. Field order is fixed so the JSON is byte-stable. */
export function toPayload(rows: VideoRow[], now = new Date()): VideoForFilter[] {
  return rows.map((v, i) => ({
    ref: `v${i + 1}`,
    title: v.title,
    channel: v.channel_title ?? "unknown",
    duration: v.is_live ? "LIVE" : formatDuration(v.duration_seconds) || "unknown",
    age: formatRelativeAge(v.published_at, now) || "unknown",
    views: formatViewCount(v.view_count) || "unknown",
    description: cleanDescription(v.description, 500) || "unknown",
  }));
}

type RawVerdict = { ref: string; decision: "pass" | "block"; confidence: number; reason: string; tags?: string[] };

/**
 * Matches the model's verdicts back onto videos by ref. Never aligns
 * positionally: a short or reordered response would silently mislabel videos.
 */
function matchVerdicts(rows: VideoRow[], raw: RawVerdict[]): { verdicts: Verdict[]; unmatched: string[] } {
  const byRef = new Map(rows.map((v, i) => [`v${i + 1}`, v]));
  const verdicts: Verdict[] = [];
  const claimed = new Set<string>();
  const unmatched: string[] = [];

  for (const r of raw) {
    const row = byRef.get(r.ref);
    if (!row || claimed.has(r.ref)) {
      unmatched.push(r.ref);
      continue;
    }
    claimed.add(r.ref);
    verdicts.push({
      videoId: row.id,
      decision: r.decision === "pass" ? "pass" : "block",
      confidence: Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : null,
      reason: (r.reason ?? "").slice(0, 300),
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 3).map(String) : null,
    });
  }
  return { verdicts, unmatched };
}

/** Local stand-in so the UI can be iterated on without spending money. */
function fakeVerdicts(rows: VideoRow[]): Verdict[] {
  const bad = /reaction|drama|shorts?\b|you won'?t believe|\bvs\b|tier list|exposed/i;
  return rows.map((v) => {
    const block = bad.test(v.title) || v.is_short === 1;
    return {
      videoId: v.id,
      decision: block ? ("block" as const) : ("pass" as const),
      confidence: 0.5,
      reason: block ? "fake filter: title or shorts heuristic" : "fake filter: no heuristic matched",
      tags: null,
    };
  });
}

export type BatchOutcome = {
  videoIds: string[];
  verdicts: Verdict[];
  costUsd: number;
  cacheRead: number;
  attempts: number;
  /** Set when the batch failed outright; its videos stay unjudged for the next run. */
  error?: string;
};

/**
 * Judges one batch. Claim-before-call: the batch row exists before the request,
 * so a crash leaves its videos simply unjudged rather than half-written.
 */
export async function runBatch(
  rows: VideoRow[],
  promptHash: string,
  system: SystemPlan,
  model: string,
  runId: number | null,
): Promise<BatchOutcome> {
  const videoIds = rows.map((v) => v.id);
  const batchId = claimBatch(promptHash, videoIds, runId);

  if (FAKE_LLM()) {
    const verdicts = fakeVerdicts(rows);
    completeBatch(batchId, promptHash, verdicts, { costUsd: 0 });
    return { videoIds, verdicts, costUsd: 0, cacheRead: 0, attempts: 0 };
  }

  const payload = toPayload(rows);
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    markBatchRunning(batchId, attempt);
    try {
      const res = await anthropic().messages.parse({
        model,
        max_tokens: 8000,
        system: system.blocks,
        output_config: {
          effort: "low",
          format: jsonSchemaOutputFormat(VERDICT_SCHEMA),
        },
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      });

      // Safety classifiers can decline on a video title; check before reading content.
      if (res.stop_reason === "refusal") {
        throw new RefusalError(
          `refused (${res.stop_details?.type === "refusal" ? res.stop_details.category ?? "unknown" : "unknown"})`,
        );
      }
      if (res.stop_reason === "max_tokens") {
        throw new Error("response hit max_tokens — batch too large");
      }

      const parsed = res.parsed_output as { verdicts?: RawVerdict[] } | null | undefined;
      if (!parsed?.verdicts) throw new Error("no parsable verdicts in response");

      const { verdicts, unmatched } = matchVerdicts(rows, parsed.verdicts);
      if (unmatched.length) log.warn(`dropped ${unmatched.length} unknown ref(s): ${unmatched.join(", ")}`);
      if (verdicts.length < rows.length) {
        // Write what matched; the rest stay unjudged and get retried next run.
        log.warn(`partial batch: ${verdicts.length}/${rows.length} judged`);
      }

      const usage = res.usage;
      const costUsd = estimateCost(usage);
      completeBatch(batchId, promptHash, verdicts, {
        inputTokens: usage.input_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheWriteTokens: usage.cache_creation_input_tokens,
        outputTokens: usage.output_tokens,
        costUsd,
      });
      return {
        videoIds,
        verdicts,
        costUsd,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        attempts: attempt,
      };
    } catch (err) {
      lastError = (err as Error).message;
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const retryable =
        err instanceof RefusalError ||
        err instanceof Anthropic.APIConnectionError ||
        RETRYABLE_STATUS(status);

      // A 400 is a bad request, not bad luck: retrying sends the same thing again.
      if (!retryable || attempt === MAX_ATTEMPTS) {
        log.error(`batch failed after ${attempt} attempt(s): ${lastError}`);
        failBatch(batchId, lastError, attempt);
        return { videoIds, verdicts: [], costUsd: 0, cacheRead: 0, attempts: attempt, error: lastError };
      }
      const backoff = Math.round(500 * 2 ** (attempt - 1) * (1 + Math.random()));
      log.warn(`attempt ${attempt} failed (${lastError}); retrying in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  failBatch(batchId, lastError, MAX_ATTEMPTS);
  return { videoIds, verdicts: [], costUsd: 0, cacheRead: 0, attempts: MAX_ATTEMPTS, error: lastError };
}

export class RefusalError extends Error {}
