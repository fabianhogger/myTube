import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { LOG_DIR, ROOT } from "@/lib/env";
import { logger } from "@/lib/log";
import { acquireRun, attachPid } from "@/lib/repo/runs";

const log = logger("api:ingest");

/**
 * Starts an ingest in a detached child process and returns immediately.
 *
 * A 2-5 minute ingest (Chromium, ~150 RSS fetches, a dozen Claude calls) cannot
 * run inside a request: it would blow past fetch timeouts, and Next's dev server
 * recycles workers on file change, which would kill the job mid-write. Spawning
 * the same script the CLI uses also means there is only one code path to debug.
 */
export async function POST() {
  const lock = acquireRun("ui");
  if (!lock.ok) {
    return NextResponse.json(
      { error: "an ingest is already running", runId: lock.runId },
      { status: 409 },
    );
  }

  const runId = lock.runId;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, `ingest-${runId}.log`);
    const fd = fs.openSync(logFile, "a");

    const child = spawn("npx", ["tsx", "scripts/ingest.ts", "--run-id", String(runId)], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    child.unref();
    if (child.pid) attachPid(runId, child.pid);

    log.info(`run ${runId} started as pid ${child.pid}, logging to ${logFile}`);
    return NextResponse.json({ runId, pid: child.pid, logFile });
  } catch (err) {
    const message = (err as Error).message;
    log.error(`failed to spawn ingest: ${message}`);
    return NextResponse.json({ error: message, runId }, { status: 500 });
  }
}
