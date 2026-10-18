/**
 * Re-captures offline fixtures from live YouTube. Run this when the renderer
 * shape changes and the offline tests stop reflecting reality.
 *
 *   npm run fixtures            capture from the logged-in profile (home + subs)
 *   npm run fixtures -- --public  capture a public channel page, no login needed
 */
import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "../src/lib/env";
import { logger } from "../src/lib/log";
import { withContext, isSignedIn, profileExists } from "../src/ingest/scrape/browser";
import { readYtInitialData } from "../src/ingest/scrape/yt-initial-data";
import { extractFromBrowseData } from "../src/ingest/scrape/renderers";

const log = logger("fixtures");

/** responseContext carries visitor/session identifiers, and the tracking blobs are bloat. */
function sanitize(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(sanitize);
  if (o && typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (["responseContext", "clickTrackingParams", "trackingParams", "loggingDirectives"].includes(k)) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return o;
}

async function capture(url: string, name: string, headless: boolean) {
  const data = await withContext(
    async (ctx) => {
      if (!(await isSignedIn(ctx))) log.warn("profile is not signed in — capturing the logged-out view");
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(2500);
      return readYtInitialData(page);
    },
    { headless },
  );

  const clean = sanitize(data);
  const { videos, stats } = extractFromBrowseData(clean);
  const file = path.join(FIXTURES_DIR, `ytInitialData-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(clean, null, 1));
  log.info(`${file}: ${videos.length} videos extractable, shapes ${JSON.stringify(stats.shapes)}`);
  if (videos.length === 0) log.warn("captured payload yields no videos — check the page or the extractor");
}

async function main() {
  const publicOnly = process.argv.includes("--public");
  if (!profileExists() && !publicOnly) {
    log.error("no browser profile — run `npm run yt:login`, or pass --public");
    process.exit(1);
  }
  if (publicOnly) {
    await capture("https://www.youtube.com/@veritasium/videos", "home", true);
  } else {
    await capture("https://www.youtube.com/", "home", true);
    await capture("https://www.youtube.com/feed/subscriptions", "subscriptions", true);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
