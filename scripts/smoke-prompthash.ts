/**
 * Phase 2 verification: a prompt edit re-filters, and reverting it costs
 * nothing. This single test proves the (video_id, prompt_hash) design — if it
 * passes, prompt tuning is cheap and reversible.
 *
 * Runs with MYTUBE_FAKE_LLM=1 so it spends no money; it is the bookkeeping
 * that is under test, not the model's judgment.
 */
import fs from "node:fs";
import { PROMPT_PATH } from "../src/lib/env";
import { getDb } from "../src/lib/db";
import { getActivePrompt, readPromptFile } from "../src/lib/prompt";
import { runFilter } from "../src/ingest/filter/run";
import { feed } from "../src/lib/repo/videos";

process.env.MYTUBE_FAKE_LLM = "1";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}

const db = getDb();
const count = (sql: string, ...a: unknown[]) => db.prepare(sql).pluck().get(...a) as number;

async function main() {
  const original = readPromptFile();
  const originalBytes = fs.readFileSync(PROMPT_PATH);
  let editedHash: string | undefined;

  try {
    // --- baseline ---------------------------------------------------------
    const base = getActivePrompt();
    await runFilter(null);
    const baseVerdicts = count("SELECT COUNT(*) FROM filter_verdicts WHERE prompt_hash = ?", base.hash);
    const baseFeed = feed(base.hash).map((v) => v.id);
    check("baseline has verdicts for the current prompt", baseVerdicts > 0, `got ${baseVerdicts}`);
    check("baseline feed is non-empty", baseFeed.length > 0);

    // --- 1. whitespace-only change must NOT re-filter ----------------------
    fs.writeFileSync(PROMPT_PATH, `${original}\n\n   \n`);
    const whitespace = getActivePrompt();
    check("trailing-whitespace edit keeps the same hash", whitespace.hash === base.hash,
      `${base.hash} -> ${whitespace.hash}`);

    // --- 2. a real edit must produce a new hash and re-filter --------------
    // The nonce keeps this test idempotent: a fixed edit would hash the same on
    // every run, and the second run would (correctly) find its verdicts cached.
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(PROMPT_PATH, `${original}\n\nAlso block anything about cooking. (test ${nonce})\n`);
    const edited = getActivePrompt();
    editedHash = edited.hash;
    check("a real edit produces a new prompt hash", edited.hash !== base.hash);
    check("the new prompt was recorded", count("SELECT COUNT(*) FROM filter_prompts WHERE hash = ?", edited.hash) === 1);

    const pendingAfterEdit = count(
      `SELECT COUNT(*) FROM videos v LEFT JOIN filter_verdicts fv
         ON fv.video_id = v.id AND fv.prompt_hash = ?
       WHERE fv.video_id IS NULL AND v.is_upcoming = 0`,
      edited.hash,
    );
    check("every video is pending again under the new hash", pendingAfterEdit > 0, `got ${pendingAfterEdit}`);
    check("the edited prompt's feed is empty before re-filtering", feed(edited.hash).length === 0);

    const batchesBefore = count("SELECT COUNT(*) FROM filter_batches");
    await runFilter(null);
    const batchesAfterEdit = count("SELECT COUNT(*) FROM filter_batches");
    check("re-filtering ran new batches", batchesAfterEdit > batchesBefore,
      `${batchesBefore} -> ${batchesAfterEdit}`);
    check("the new hash now has verdicts",
      count("SELECT COUNT(*) FROM filter_verdicts WHERE prompt_hash = ?", edited.hash) > 0);
    check("the OLD verdicts are untouched",
      count("SELECT COUNT(*) FROM filter_verdicts WHERE prompt_hash = ?", base.hash) === baseVerdicts,
      "a prompt edit must never destroy earlier verdicts");

    // --- 3. reverting must cost nothing ------------------------------------
    fs.writeFileSync(PROMPT_PATH, originalBytes);
    const reverted = getActivePrompt();
    check("reverting restores the original hash", reverted.hash === base.hash);

    const batchesBeforeRevert = count("SELECT COUNT(*) FROM filter_batches");
    const result = await runFilter(null);
    const batchesAfterRevert = count("SELECT COUNT(*) FROM filter_batches");
    check("reverting issues ZERO new batches", batchesAfterRevert === batchesBeforeRevert,
      `${batchesBeforeRevert} -> ${batchesAfterRevert}`);
    check("reverting judges nothing", result.judged === 0, `judged ${result.judged}`);
    check("the original feed comes back byte-identical",
      JSON.stringify(feed(base.hash).map((v) => v.id)) === JSON.stringify(baseFeed));
  } finally {
    // Always restore the user's prompt, even if a check threw.
    fs.writeFileSync(PROMPT_PATH, originalBytes);
    // Drop the throwaway prompt so it does not clutter the real prompt history.
    if (editedHash) {
      db.prepare("DELETE FROM filter_verdicts WHERE prompt_hash = ?").run(editedHash);
      db.prepare("DELETE FROM filter_batches WHERE prompt_hash = ?").run(editedHash);
      db.prepare("DELETE FROM filter_prompts WHERE hash = ?").run(editedHash);
    }
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nprompt-hash: all checks passed" : `\nprompt-hash: ${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
