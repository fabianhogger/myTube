/**
 * Phase 3 verification: the failure paths. These are the ones that matter most,
 * because a scraper that breaks silently is worse than one that breaks loudly.
 */
import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "../src/lib/env";
import { getDb } from "../src/lib/db";
import { extractFromBrowseData } from "../src/ingest/scrape/renderers";
import { scrapeFeed, TARGETS } from "../src/ingest/scrape/feed";
import { acquireRun, finishRun, getRun, heartbeat } from "../src/lib/repo/runs";
import { getActivePrompt } from "../src/lib/prompt";
import { feed } from "../src/lib/repo/videos";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}

getDb();

async function main() {
  // --- 1. A renamed renderer must fail loudly, not report an empty feed --------
  const good = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "ytInitialData-home.json"), "utf8"));
  const broken = JSON.parse(JSON.stringify(good));
  function renameRenderers(o: any): number {
    let n = 0;
    if (Array.isArray(o)) { for (const x of o) n += renameRenderers(x); return n; }
    if (o && typeof o === "object") {
      for (const key of ["lockupViewModel", "videoRenderer", "gridVideoRenderer"]) {
        if (o[key]) { o.someRenamedViewModel = o[key]; delete o[key]; n++; }
      }
      for (const v of Object.values(o)) n += renameRenderers(v);
    }
    return n;
  }
  const renamed = renameRenderers(broken);
  check(`renamed ${renamed} renderer(s) in a copy of the fixture`, renamed > 0);
  check("good fixture still extracts videos", extractFromBrowseData(good).videos.length >= 5);
  check("renamed fixture extracts zero videos", extractFromBrowseData(broken).videos.length === 0);

  // Feed the broken payload through the real scrape path via a temp fixture.
  const brokenPath = path.join(FIXTURES_DIR, "ytInitialData-failsoft-tmp.json");
  fs.writeFileSync(brokenPath, JSON.stringify(broken));

  const prompt = getActivePrompt();
  const feedBefore = feed(prompt.hash).map((v) => v.id);

  process.env.MYTUBE_OFFLINE = "1";
  const target = { ...TARGETS.home, label: "failsoft-tmp" as const };
  let scrapeError: Error | undefined;
  try {
    await scrapeFeed(target as typeof TARGETS.home, null);
  } catch (err) {
    scrapeError = err as Error;
  }
  fs.unlinkSync(brokenPath);

  check("scrapeFeed threw instead of returning an empty result", scrapeError !== undefined,
    "a silent zero here means recommendations stop forever behind a green checkmark");
  check(
    "the error names the cause",
    /no_items_extracted|too_few_items/.test(String(scrapeError?.message) + String((scrapeError as any)?.code)),
    `got: ${scrapeError?.message}`,
  );
  const dumps = fs.existsSync("data/debug") ? fs.readdirSync("data/debug") : [];
  check("a raw payload was dumped for debugging", dumps.length > 0, `data/debug is empty`);

  const feedAfter = feed(prompt.hash).map((v) => v.id);
  check("the existing feed is unchanged by the failed scrape",
    JSON.stringify(feedBefore) === JSON.stringify(feedAfter));

  // --- 2. Single-flight lock ---------------------------------------------------
  const db = getDb();
  db.prepare("UPDATE ingest_runs SET status = 'stale' WHERE status = 'running'").run();
  const first = acquireRun("cli");
  check("first acquireRun succeeds", first.ok);
  if (first.ok) {
    // A live run needs a fresh heartbeat and a pid that exists.
    db.prepare("UPDATE ingest_runs SET pid = ? WHERE id = ?").run(process.pid, first.runId);
    heartbeat(first.runId, "testing");
    const second = acquireRun("cli");
    check("second acquireRun is rejected while the first is live",
      !second.ok && second.reason === "already_running");

    // --- 3. A killed run is reaped, not left spinning -------------------------
    // Simulate kill -9: a pid that does not exist and a stale heartbeat.
    db.prepare("UPDATE ingest_runs SET pid = 999999, heartbeat_at = '2020-01-01T00:00:00Z' WHERE id = ?")
      .run(first.runId);
    const third = acquireRun("cli");
    check("a dead run is reaped and a new one starts", third.ok);
    check("the dead run was marked stale", getRun(first.runId)?.status === "stale");
    if (third.ok) finishRun(third.runId, "done", { smoke: true });
  }
}

main().then(() => {
  console.log(failures === 0 ? "\nfail-soft: all checks passed" : `\nfail-soft: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
