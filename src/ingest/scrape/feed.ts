import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { FIXTURES_DIR, OFFLINE } from "../../lib/env";
import { logger } from "../../lib/log";
import { upsertVideos } from "../../lib/repo/videos";
import { NamedError, type Source, type VideoInput } from "../../lib/types";
import { withContext, isSignedIn, profileExists, signInDetail, YT_AUTH_COOKIE } from "./browser";
import { extractFromBrowseData, extractFromContinuation } from "./renderers";
import { assertUsablePage, dumpDebug, looksLoggedOut, readYtInitialData } from "./yt-initial-data";

const log = logger("scrape");

/**
 * Zero extracted items is a failure, not an empty feed. Without this a renderer
 * rename reads as "YouTube showed me nothing": the writer does nothing, the run
 * goes green, and recommendations silently stop forever.
 */
const MIN_EXPECTED_ITEMS = 5;

const MAX_SCROLLS = 8;
const MAX_ITEMS = 120;
const SCROLL_BUDGET_MS = 60_000;

export type ScrapeTarget = { source: Source; url: string; label: string };

export const TARGETS: Record<"home" | "subs", ScrapeTarget> = {
  home: { source: "scrape_home", url: "https://www.youtube.com/", label: "home" },
  subs: { source: "scrape_subs", url: "https://www.youtube.com/feed/subscriptions", label: "subscriptions" },
};

const jitter = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Re-reading window.ytInitialData after a scroll returns the same initial
 * payload — it is not mutated. Continuations have to be captured off the wire.
 */
async function scrapePage(page: Page, target: ScrapeTarget): Promise<{ videos: VideoInput[]; shapes: Record<string, number> }> {
  const continuations: unknown[] = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/youtubei/v1/browse")) return;
    try {
      continuations.push(await res.json());
    } catch {
      /* not every browse response is JSON we can read */
    }
  });

  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await assertUsablePage(page);

  const initial = await readYtInitialData(page);
  const first = extractFromBrowseData(initial);
  const byId = new Map<string, VideoInput>();
  for (const v of first.videos) byId.set(v.id, v);
  const shapes = { ...first.stats.shapes };

  if (byId.size === 0) {
    const file = dumpDebug(null, target.source, initial);
    if (looksLoggedOut(initial)) {
      throw new NamedError(
        "not_signed_in",
        `youtube.com served its logged-out feed. You hold a Google session but not a ` +
          `YouTube one (no LOGIN_INFO cookie). Run \`npm run yt:login\` and make sure your ` +
          `avatar appears top-right on youtube.com before the window closes. Payload: ${file}`,
      );
    }
    throw new NamedError(
      "no_items_extracted",
      `extracted 0 videos from ${target.label} (${first.stats.entries} entries seen). Raw payload: ${file}`,
    );
  }

  // Scroll for more, stopping on three consecutive scrolls that add nothing.
  const deadline = Date.now() + SCROLL_BUDGET_MS;
  let barren = 0;
  for (let i = 0; i < MAX_SCROLLS && byId.size < MAX_ITEMS && Date.now() < deadline && barren < 3; i++) {
    const before = byId.size;
    await page.evaluate(() => window.scrollBy(0, document.documentElement.clientHeight * 2));
    await page.waitForTimeout(jitter(600, 1200));

    while (continuations.length) {
      const payload = continuations.shift();
      const more = extractFromContinuation(payload);
      for (const v of more.videos) if (!byId.has(v.id)) byId.set(v.id, v);
      for (const [k, n] of Object.entries(more.stats.shapes)) shapes[k] = (shapes[k] ?? 0) + n;
    }
    barren = byId.size > before ? 0 : barren + 1;
  }

  return { videos: [...byId.values()].slice(0, MAX_ITEMS), shapes };
}

export type ScrapeResult = { found: number; inserted: number; shapes: Record<string, number> };

/** Offline mode skips Chromium entirely and feeds a captured payload to the extractor. */
function scrapeOffline(target: ScrapeTarget): { videos: VideoInput[]; shapes: Record<string, number> } {
  const specific = path.join(FIXTURES_DIR, `ytInitialData-${target.label}.json`);
  const file = fs.existsSync(specific) ? specific : path.join(FIXTURES_DIR, "ytInitialData-home.json");
  if (!fs.existsSync(file)) throw new NamedError("no_fixture", `no scrape fixture at ${file}`);
  log.info(`offline: reading ${file}`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const { videos, stats } = extractFromBrowseData(data);
  if (videos.length === 0) {
    const dump = dumpDebug(null, target.source, data);
    throw new NamedError(
      "no_items_extracted",
      `extracted 0 videos from fixture ${file} (${stats.entries} entries seen). Raw payload: ${dump}`,
    );
  }
  return { videos, shapes: stats.shapes };
}

export async function scrapeFeed(target: ScrapeTarget, runId: number | null): Promise<ScrapeResult> {
  let videos: VideoInput[];
  let shapes: Record<string, number>;

  if (OFFLINE()) {
    ({ videos, shapes } = scrapeOffline(target));
  } else {
    if (!profileExists()) {
      throw new NamedError("not_signed_in", "No browser profile yet — run `npm run yt:login` first.");
    }
    ({ videos, shapes } = await withContext(async (ctx) => {
      if (!(await isSignedIn(ctx))) {
        const detail = await signInDetail(ctx);
        throw new NamedError(
          "not_signed_in",
          detail.google
            ? `the profile has a Google session but no YouTube one (no ${YT_AUTH_COOKIE} cookie on ` +
              ".youtube.com), so youtube.com serves its logged-out feed. Run `npm run yt:login`, " +
              "open youtube.com in that window, and confirm your avatar appears top-right before it closes."
            : "the browser profile has no Google session at all — run `npm run yt:login`.",
        );
      }
      const page = await ctx.newPage();
      return scrapePage(page, target);
    }));
  }

  if (videos.length < MIN_EXPECTED_ITEMS) {
    const dump = dumpDebug(runId, target.source, { videos, shapes });
    throw new NamedError(
      "too_few_items",
      `only ${videos.length} videos from ${target.label} (expected >= ${MIN_EXPECTED_ITEMS}) — ` +
        `YouTube's renderer shape has probably changed. What was extracted: ${dump}`,
    );
  }

  // Upsert-only, never delete: a broken scrape must not remove rows.
  const r = upsertVideos(videos, target.source, runId, { positions: true });
  log.info(`${target.label}: ${r.found} videos (${r.inserted} new)`, shapes);
  return { found: r.found, inserted: r.inserted, shapes };
}
