/**
 * The ingest entry point. The UI's button spawns exactly this script, so both
 * paths run the same code and there is only one surface to debug.
 *
 *   npm run ingest                      full run
 *   npm run ingest -- --only=rss,filter  selected stages
 *   npm run ingest -- --dry-run          migrations + plan only
 */
import { getDb } from "../src/lib/db";
import { logger } from "../src/lib/log";
import { acquireRun, attachPid, finishRun, heartbeat } from "../src/lib/repo/runs";
import { ALL_STAGES, runIngest, type StageName } from "../src/ingest/run";

const log = logger("ingest:cli");

function parseArgs(argv: string[]) {
  /** Supports both `--flag=value` and `--flag value`; a bare flag returns "". */
  const get = (name: string) => {
    const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i < 0) return undefined;
    const hit = argv[i];
    if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
    const next = argv[i + 1];
    return next && !next.startsWith("--") ? next : "";
  };
  const onlyRaw = get("only");
  const only = onlyRaw
    ? onlyRaw.split(",").map((s) => s.trim()).filter(Boolean) as StageName[]
    : undefined;
  const bad = only?.filter((s) => !ALL_STAGES.includes(s)) ?? [];
  if (bad.length) {
    console.error(`Unknown stage(s): ${bad.join(", ")}\nValid stages: ${ALL_STAGES.join(", ")}`);
    process.exit(2);
  }
  const runIdRaw = get("run-id");
  return {
    only,
    dryRun: get("dry-run") !== undefined,
    runId: runIdRaw ? Number(runIdRaw) : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Touch the DB first so migrations apply before anything else runs.
  const db = getDb();
  log.info(`schema version ${db.pragma("user_version", { simple: true })}`);

  // A run id passed in means the UI already claimed the lock for us.
  let runId: number | null;
  if (args.runId != null) {
    runId = args.runId;
  } else {
    const lock = acquireRun("cli");
    if (!lock.ok) {
      log.error(`an ingest is already running (run ${lock.runId}). Wait for it, or kill it.`);
      process.exit(3);
    }
    runId = lock.runId;
  }
  attachPid(runId, process.pid);

  // Keep the heartbeat alive even while a stage blocks for a long time.
  const ticker = setInterval(() => {
    try {
      heartbeat(runId);
    } catch {
      /* best effort: a heartbeat failure must not kill the run */
    }
  }, 15_000);
  ticker.unref?.();

  try {
    const { status } = await runIngest({ runId, only: args.only, dryRun: args.dryRun });
    clearInterval(ticker);
    if (args.dryRun) finishRun(runId, "done", { dryRun: true });
    process.exit(status === "failed" ? 1 : 0);
  } catch (err) {
    clearInterval(ticker);
    log.error(`ingest crashed: ${(err as Error).message}`);
    finishRun(runId, "failed", undefined, (err as Error).message);
    process.exit(1);
  }
}

main();
