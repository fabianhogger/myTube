import crypto from "node:crypto";
import { getDb, nowIso } from "../db";
import type { Decision } from "../types";

export type Verdict = {
  videoId: string;
  decision: Decision;
  confidence?: number | null;
  reason?: string;
  tags?: string[] | null;
};

/**
 * Claim-before-call: a batch row is written before the API request, so a crash
 * mid-flight leaves its videos simply unjudged and the pending left-join picks
 * them up again. Nothing needs reconciliation.
 */
export function claimBatch(promptHash: string, videoIds: string[], runId: number | null): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO filter_batches (id, run_id, prompt_hash, video_ids, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    )
    .run(id, runId, promptHash, JSON.stringify(videoIds));
  return id;
}

export function markBatchRunning(batchId: string, attempt: number): void {
  getDb()
    .prepare("UPDATE filter_batches SET status = 'running', attempt = ? WHERE id = ?")
    .run(attempt, batchId);
}

export type Usage = {
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
};

/** Verdicts and the batch's completion are written in one transaction. */
export function completeBatch(
  batchId: string,
  promptHash: string,
  verdicts: Verdict[],
  usage: Usage = {},
): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO filter_verdicts (video_id, prompt_hash, decision, confidence, reason, tags, batch_id)
     VALUES (@video_id, @prompt_hash, @decision, @confidence, @reason, @tags, @batch_id)
     ON CONFLICT(video_id, prompt_hash) DO NOTHING`,
  );
  db.transaction(() => {
    for (const v of verdicts) {
      insert.run({
        video_id: v.videoId,
        prompt_hash: promptHash,
        decision: v.decision,
        confidence: v.confidence ?? null,
        reason: v.reason ?? "",
        tags: v.tags && v.tags.length ? JSON.stringify(v.tags) : null,
        batch_id: batchId,
      });
    }
    db.prepare(
      `UPDATE filter_batches SET status = 'done', finished_at = @now,
         input_tokens = @input, cache_read_tokens = @cache_read,
         cache_write_tokens = @cache_write, output_tokens = @output, cost_usd = @cost
       WHERE id = @id`,
    ).run({
      id: batchId,
      now: nowIso(),
      input: usage.inputTokens ?? null,
      cache_read: usage.cacheReadTokens ?? null,
      cache_write: usage.cacheWriteTokens ?? null,
      output: usage.outputTokens ?? null,
      cost: usage.costUsd ?? null,
    });
  })();
}

export function failBatch(batchId: string, error: string, attempt: number): void {
  getDb()
    .prepare(
      `UPDATE filter_batches SET status = 'failed', attempt = ?, error = ?, finished_at = ?
       WHERE id = ?`,
    )
    .run(attempt, error.slice(0, 2000), nowIso(), batchId);
}

export function getVerdict(videoId: string, promptHash: string) {
  return getDb()
    .prepare("SELECT * FROM filter_verdicts WHERE video_id = ? AND prompt_hash = ?")
    .get(videoId, promptHash) as
    | { decision: Decision; confidence: number | null; reason: string; tags: string | null }
    | undefined;
}

export function verdictsByDecision(promptHash: string, decision: Decision, limit = 50) {
  return getDb()
    .prepare(
      `SELECT fv.decision, fv.confidence, fv.reason, v.title, v.channel_title, v.id
       FROM filter_verdicts fv JOIN videos v ON v.id = fv.video_id
       WHERE fv.prompt_hash = ? AND fv.decision = ?
       ORDER BY fv.created_at DESC LIMIT ?`,
    )
    .all(promptHash, decision, limit) as {
    decision: Decision; confidence: number | null; reason: string;
    title: string; channel_title: string | null; id: string;
  }[];
}

/**
 * Verdicts decided before their video was enriched were judged on incomplete
 * metadata — typically "duration: unknown", which is exactly what separates a
 * Short from a lecture. Verdicts are keyed on the prompt, not the metadata, so
 * these do not expire on their own and have to be dropped deliberately.
 */
export function countStaleVerdicts(promptHash: string): number {
  return getDb()
    .prepare(
      `SELECT COUNT(*) FROM filter_verdicts fv
       JOIN videos v ON v.id = fv.video_id
       WHERE fv.prompt_hash = ?
         AND v.enriched_at IS NOT NULL
         AND fv.created_at < v.enriched_at`,
    )
    .pluck()
    .get(promptHash) as number;
}

export function dropStaleVerdicts(promptHash: string): number {
  const info = getDb()
    .prepare(
      `DELETE FROM filter_verdicts
       WHERE prompt_hash = ?
         AND video_id IN (
           SELECT v.id FROM videos v
           JOIN filter_verdicts f2 ON f2.video_id = v.id AND f2.prompt_hash = ?
           WHERE v.enriched_at IS NOT NULL AND f2.created_at < v.enriched_at
         )`,
    )
    .run(promptHash, promptHash);
  return info.changes;
}

export function batchStats(promptHash: string) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS batches,
              SUM(COALESCE(input_tokens,0))       AS input_tokens,
              SUM(COALESCE(cache_read_tokens,0))  AS cache_read_tokens,
              SUM(COALESCE(output_tokens,0))      AS output_tokens,
              SUM(COALESCE(cost_usd,0))           AS cost_usd,
              SUM(status = 'failed')              AS failed
       FROM filter_batches WHERE prompt_hash = ?`,
    )
    .get(promptHash) as Record<string, number>;
  return row;
}
