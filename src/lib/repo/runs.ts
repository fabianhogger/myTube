import { getDb, nowIso } from "../db";
import type { IngestRunRow, RunStatus, SourceRunRow, SourceStatus } from "../types";

/** A run whose heartbeat is older than this is presumed dead. */
const HEARTBEAT_TIMEOUT_MS = 60_000;

function isAlive(row: IngestRunRow): boolean {
  if (row.heartbeat_at) {
    const age = Date.now() - Date.parse(row.heartbeat_at);
    if (Number.isFinite(age) && age > HEARTBEAT_TIMEOUT_MS) return false;
  } else if (Date.now() - Date.parse(row.started_at) > HEARTBEAT_TIMEOUT_MS) {
    // Started a while ago and never heartbeat at all.
    return false;
  }
  if (row.pid != null) {
    try {
      process.kill(row.pid, 0);
    } catch {
      return false;
    }
  }
  return true;
}

export type LockResult =
  | { ok: true; runId: number }
  | { ok: false; reason: "already_running"; runId: number };

/**
 * Single-flight: in one transaction, reject if a live run exists, otherwise
 * reap any stale rows and claim a new run id. A `kill -9`'d ingest leaves a
 * `running` row behind; that is what the stale reaping is for.
 */
export function acquireRun(trigger: "ui" | "cli" | "startup"): LockResult {
  const db = getDb();
  const tx = db.transaction((): LockResult => {
    const live = db
      .prepare("SELECT * FROM ingest_runs WHERE status = 'running' ORDER BY id DESC")
      .all() as IngestRunRow[];
    for (const row of live) {
      if (isAlive(row)) return { ok: false, reason: "already_running", runId: row.id };
      db.prepare(
        `UPDATE ingest_runs SET status = 'stale', finished_at = ?,
           error = COALESCE(error, 'run disappeared (no heartbeat)') WHERE id = ?`,
      ).run(nowIso(), row.id);
    }
    const info = db
      .prepare(
        `INSERT INTO ingest_runs (status, trigger, phase, heartbeat_at)
         VALUES ('running', ?, 'queued', ?)`,
      )
      .run(trigger, nowIso());
    return { ok: true, runId: Number(info.lastInsertRowid) };
  });
  return tx();
}

export function attachPid(runId: number, pid: number): void {
  getDb().prepare("UPDATE ingest_runs SET pid = ? WHERE id = ?").run(pid, runId);
}

export function heartbeat(runId: number, phase?: string, progress?: unknown): void {
  getDb()
    .prepare(
      `UPDATE ingest_runs SET heartbeat_at = ?,
         phase    = COALESCE(?, phase),
         progress = COALESCE(?, progress)
       WHERE id = ?`,
    )
    .run(nowIso(), phase ?? null, progress === undefined ? null : JSON.stringify(progress), runId);
}

export function finishRun(runId: number, status: RunStatus, stats?: unknown, error?: string | null): void {
  getDb()
    .prepare(
      `UPDATE ingest_runs SET status = ?, phase = 'done', finished_at = ?, stats = ?, error = ?
       WHERE id = ?`,
    )
    .run(status, nowIso(), stats === undefined ? null : JSON.stringify(stats), error ?? null, runId);
}

export function startSource(runId: number, source: string): void {
  getDb()
    .prepare(
      `INSERT INTO ingest_source_runs (run_id, source, status, started_at)
       VALUES (?, ?, 'running', ?)
       ON CONFLICT(run_id, source) DO UPDATE SET
         status = 'running', started_at = excluded.started_at,
         error = NULL, finished_at = NULL, items_found = 0, items_new = 0`,
    )
    .run(runId, source, nowIso());
}

export function finishSource(
  runId: number,
  source: string,
  status: SourceStatus,
  counts: { found?: number; new?: number } = {},
  error?: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE ingest_source_runs
       SET status = ?, items_found = ?, items_new = ?, error = ?, finished_at = ?
       WHERE run_id = ? AND source = ?`,
    )
    .run(status, counts.found ?? 0, counts.new ?? 0, error ?? null, nowIso(), runId, source);
}

export function getRun(runId: number): IngestRunRow | undefined {
  return getDb().prepare("SELECT * FROM ingest_runs WHERE id = ?").get(runId) as IngestRunRow | undefined;
}

export function latestRun(): IngestRunRow | undefined {
  return getDb()
    .prepare("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1")
    .get() as IngestRunRow | undefined;
}

export function sourceRuns(runId: number): SourceRunRow[] {
  return getDb()
    .prepare("SELECT * FROM ingest_source_runs WHERE run_id = ? ORDER BY started_at")
    .all(runId) as SourceRunRow[];
}

/**
 * Reaps runs left `running` by a crashed process. Called on read paths so the
 * UI never shows a spinner for a run that died hours ago.
 */
export function reapStaleRuns(): number {
  const db = getDb();
  const live = db
    .prepare("SELECT * FROM ingest_runs WHERE status = 'running'")
    .all() as IngestRunRow[];
  let reaped = 0;
  for (const row of live) {
    if (!isAlive(row)) {
      db.prepare(
        `UPDATE ingest_runs SET status = 'stale', finished_at = ?,
           error = COALESCE(error, 'run disappeared (no heartbeat)') WHERE id = ?`,
      ).run(nowIso(), row.id);
      reaped++;
    }
  }
  return reaped;
}
