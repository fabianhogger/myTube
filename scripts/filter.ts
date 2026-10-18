/**
 * Runs only the Claude filter stage. This is the loop you use after editing
 * filter-prompt.md.
 */
import { getDb } from "../src/lib/db";
import { logger } from "../src/lib/log";
import { getActivePrompt } from "../src/lib/prompt";
import { runFilter, refilterEstimate } from "../src/ingest/filter/run";
import { batchStats, countStaleVerdicts, dropStaleVerdicts } from "../src/lib/repo/verdicts";
import { videoStats } from "../src/lib/repo/videos";

const log = logger("filter:cli");

async function main() {
  getDb();
  const prompt = getActivePrompt();
  log.info(`prompt ${prompt.hash} (${prompt.model}, pipeline v${prompt.pipelineVersion})`);

  // Verdicts decided before enrichment saw "duration: unknown" and are worth redoing.
  const stale = countStaleVerdicts(prompt.hash);
  if (stale > 0) {
    if (process.argv.includes("--refresh-stale")) {
      const dropped = dropStaleVerdicts(prompt.hash);
      log.info(`dropped ${dropped} verdict(s) decided before their video was enriched`);
    } else {
      log.warn(
        `${stale} verdict(s) were decided before their video was enriched (no duration, ` +
          "so Shorts were not recognised). Re-judge them with: npm run filter -- --refresh-stale",
      );
    }
  }

  const { pending, estimatedUsd } = refilterEstimate(prompt.hash);
  if (pending === 0) {
    const s = videoStats(prompt.hash);
    log.info(`nothing to judge — ${s.pass} pass, ${s.block} block already recorded for this prompt`);
    return;
  }
  log.info(`${pending} video(s) to judge, roughly $${estimatedUsd.toFixed(2)}`);

  // A dry run by default above this much, so that merely invoking this script
  // can never start a large spend. Pass --yes to actually run it.
  const CONFIRM_ABOVE_USD = 0.5;
  if (estimatedUsd > CONFIRM_ABOVE_USD && !process.argv.includes("--yes")) {
    log.warn(
      `that is over $${CONFIRM_ABOVE_USD.toFixed(2)}, so nothing has been sent. Re-run with --yes to confirm:`,
    );
    log.warn(`  npm run filter -- --yes`);
    log.warn(`A single run stops at $${(Number(process.env.MYTUBE_MAX_SPEND_USD) || 2).toFixed(2)}; ` +
      "override with MYTUBE_MAX_SPEND_USD=<dollars>.");
    return;
  }

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
