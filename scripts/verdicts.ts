/**
 * Inspect what the filter decided. Blocked videos never appear in the UI, so
 * this is how you audit and tune the prompt.
 *
 *   npm run verdicts                   summary
 *   npm run verdicts -- --blocked      why videos were hidden
 *   npm run verdicts -- --passed
 *   npm run verdicts -- --errors
 *   npm run verdicts -- --video <id>
 *   npm run verdicts -- --diff <hash>  compare the current prompt with another
 */
import { getDb } from "../src/lib/db";
import { getActivePrompt } from "../src/lib/prompt";
import { batchStats, verdictsByDecision } from "../src/lib/repo/verdicts";
import { videoStats } from "../src/lib/repo/videos";
import type { Decision } from "../src/lib/types";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const val = (f: string) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const limit = Number(val("limit") ?? 50);

const db = getDb();
const prompt = getActivePrompt();

function list(decision: Decision) {
  const rows = verdictsByDecision(prompt.hash, decision, limit);
  if (!rows.length) {
    console.log(`no ${decision} verdicts for prompt ${prompt.hash}`);
    return;
  }
  console.log(`\n${decision.toUpperCase()} (${rows.length} of ${videoStats(prompt.hash)[decision]})\n`);
  for (const r of rows) {
    const conf = r.confidence != null ? r.confidence.toFixed(2) : " -- ";
    console.log(`  ${conf}  ${(r.channel_title ?? "unknown").slice(0, 22).padEnd(22)}  ${r.title.slice(0, 58)}`);
    console.log(`        ${r.reason}`);
  }
}

const videoId = val("video");
if (videoId) {
  const v = db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId) as any;
  if (!v) {
    console.log(`no such video: ${videoId}`);
    process.exit(1);
  }
  console.log(`\n${v.title}\n  channel   ${v.channel_title}\n  sources   ${v.sources}\n  duration  ${v.duration_seconds}s\n  published ${v.published_at}${v.published_approx ? " (approx)" : ""}`);
  const all = db
    .prepare(
      `SELECT fp.hash, fp.created_at, fv.decision, fv.confidence, fv.reason
       FROM filter_verdicts fv JOIN filter_prompts fp ON fp.hash = fv.prompt_hash
       WHERE fv.video_id = ? ORDER BY fp.created_at`,
    )
    .all(videoId) as any[];
  console.log("\n  verdicts across prompts:");
  for (const r of all) {
    const current = r.hash === prompt.hash ? " <- current" : "";
    console.log(`    ${r.hash}  ${r.decision.padEnd(5)}  ${r.reason}${current}`);
  }
  process.exit(0);
}

const other = val("diff");
if (other) {
  // The payoff of hashing verdicts by prompt: comparing two prompts is pure SQL.
  const rows = db
    .prepare(
      `SELECT v.title, v.channel_title, a.decision AS now_d, b.decision AS other_d, a.reason AS now_r
       FROM filter_verdicts a
       JOIN filter_verdicts b ON b.video_id = a.video_id AND b.prompt_hash = ?
       JOIN videos v ON v.id = a.video_id
       WHERE a.prompt_hash = ? AND a.decision <> b.decision
       ORDER BY a.decision LIMIT ?`,
    )
    .all(other, prompt.hash, limit) as any[];
  console.log(`\n${rows.length} disagreement(s) between ${prompt.hash} (current) and ${other}\n`);
  for (const r of rows) {
    console.log(`  ${r.other_d} -> ${r.now_d}  ${r.title.slice(0, 60)}`);
    console.log(`        ${r.now_r}`);
  }
  process.exit(0);
}

if (has("blocked")) list("block");
else if (has("passed")) list("pass");
else if (has("errors")) list("error");
else {
  const s = videoStats(prompt.hash);
  const b = batchStats(prompt.hash);
  const prompts = db
    .prepare("SELECT hash, created_at FROM filter_prompts ORDER BY created_at DESC LIMIT 10")
    .all() as any[];

  console.log(`\nprompt     ${prompt.hash}  (${prompt.model}, pipeline v${prompt.pipelineVersion})`);
  console.log(`videos     ${s.total} in the database`);
  console.log(`verdicts   ${s.pass} pass · ${s.block} block · ${s.error} error · ${s.unjudged} unjudged`);
  console.log(
    `spend      $${Number(b.cost_usd ?? 0).toFixed(4)} over ${b.batches ?? 0} batch(es)` +
      `${b.failed ? `, ${b.failed} failed` : ""}`,
  );
  console.log(
    `tokens     in ${b.input_tokens ?? 0} · cached ${b.cache_read_tokens ?? 0} · out ${b.output_tokens ?? 0}`,
  );
  if (prompts.length > 1) {
    console.log(`\nprompt history (compare with --diff <hash>):`);
    for (const p of prompts) {
      const n = db
        .prepare("SELECT COUNT(*) FROM filter_verdicts WHERE prompt_hash = ?")
        .pluck()
        .get(p.hash);
      console.log(`  ${p.hash}  ${p.created_at}  ${n} verdict(s)${p.hash === prompt.hash ? "  <- current" : ""}`);
    }
  }
  console.log(`\n  npm run verdicts -- --blocked    see why videos were hidden`);
}
