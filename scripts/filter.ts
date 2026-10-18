/**
 * Runs only the Claude filter stage. This is the loop you use after editing
 * filter-prompt.md.
 */
import { getDb } from "../src/lib/db";
import { logger } from "../src/lib/log";
import { getActivePrompt } from "../src/lib/prompt";
import { runFilter, refilterEstimate } from "../src/ingest/filter/run";
import { batchStats } from "../src/lib/repo/verdicts";
import { videoStats } from "../src/lib/repo/videos";

const log = logger("filter:cli");

async function main() {
  getDb();
  const prompt = getActivePrompt();
  const { pending, estimatedUsd } = refilterEstimate(prompt.hash);

  log.info(`prompt ${prompt.hash} (${prompt.model}, pipeline v${prompt.pipelineVersion})`);
  if (pending === 0) {
    const s = videoStats(prompt.hash);
    log.info(`nothing to judge — ${s.pass} pass, ${s.block} block already recorded for this prompt`);
    return;
  }
  log.info(`${pending} video(s) to judge, roughly $${estimatedUsd.toFixed(2)}`);

  const result = await runFilter(null);
  const totals = batchStats(prompt.hash);
  log.info(
    `done: ${result.pass} pass, ${result.block} block, ${result.errored} error · ` +
      `$${result.costUsd.toFixed(4)} this run, $${Number(totals.cost_usd ?? 0).toFixed(4)} for this prompt`,
  );
  if (result.cacheRead === 0 && result.batches > 1) {
    log.info("cache_read was 0 — the system prefix is likely under the 1024-token caching floor");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
