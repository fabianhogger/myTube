/**
 * Phase 0 verification: the merge precedence in upsertVideos. This is the
 * easiest logic in the app to get quietly wrong and the hardest to notice
 * later, so it gets a test before anything is built on top of it.
 */
import { getDb } from "../src/lib/db";
import { upsertVideos } from "../src/lib/repo/videos";
import { upsertChannels } from "../src/lib/repo/channels";
import type { VideoInput } from "../src/lib/types";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "} ${name}${ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

const db = getDb();
// Isolated scratch ids so the test can run against a real DB without touching the feed.
const VID = "__smoke_vid1";
const CID = "__smoke_chan1";
db.prepare("DELETE FROM videos WHERE id = ?").run(VID);
db.prepare("DELETE FROM channels WHERE id = ?").run(CID);

upsertChannels([{ id: CID, title: "Smoke Channel", isSubscribed: true }]);

// 1. Scraper sees it first: relative date only, has a duration, short description.
const scraped: VideoInput = {
  id: VID, channelId: CID, channelTitle: "Smoke Channel",
  title: "A Real Video", description: "short desc",
  durationSeconds: 754, publishedAt: "2026-10-15T00:00:00Z", publishedApprox: true,
  viewCount: 1200, thumbnailUrl: "https://i.ytimg.com/vi/x/hq.jpg", isShort: false,
};
const r1 = upsertVideos([scraped], "scrape_home", null, { positions: true });
check("first upsert inserts one row", r1, { found: 1, inserted: 1 });

// 2. RSS then supplies the exact timestamp and a longer description, no duration.
const fromRss: VideoInput = {
  id: VID, channelId: CID, channelTitle: "Smoke Channel",
  title: "A Real Video",
  description: "a considerably longer and more informative description from the rss feed",
  durationSeconds: null, publishedAt: "2026-10-15T09:30:00Z", publishedApprox: false,
  viewCount: null, thumbnailUrl: null,
};
const r2 = upsertVideos([fromRss], "rss", null);
check("second upsert updates, does not insert", r2, { found: 1, inserted: 0 });

const row = db.prepare("SELECT * FROM videos WHERE id = ?").get(VID) as any;

check("still exactly one row", db.prepare("SELECT COUNT(*) FROM videos WHERE id = ?").pluck().get(VID), 1);
check("sources carries both", JSON.parse(row.sources).sort(), ["rss", "scrape_home"]);
check("exact timestamp overwrote the approximate one", row.published_at, "2026-10-15T09:30:00Z");
check("published_approx downgraded to 0", row.published_approx, 0);
check("duration preserved (rss had none)", row.duration_seconds, 754);
check("longer description won", row.description, fromRss.description);
check("view count preserved (rss had none)", row.view_count, 1200);
check("thumbnail preserved (rss had none)", row.thumbnail_url, "https://i.ytimg.com/vi/x/hq.jpg");

// 3. Re-sending the same scrape must not append a duplicate source.
upsertVideos([scraped], "scrape_home", null);
const row2 = db.prepare("SELECT sources, published_at FROM videos WHERE id = ?").get(VID) as any;
check("re-upsert does not duplicate sources", JSON.parse(row2.sources).sort(), ["rss", "scrape_home"]);
check("approximate date cannot clobber the exact one", row2.published_at, "2026-10-15T09:30:00Z");

// 4. Sightings are per (run, source, video) and idempotent within a run.
db.prepare("DELETE FROM video_sightings WHERE video_id = ?").run(VID);
upsertVideos([scraped], "scrape_home", null);
upsertVideos([scraped], "scrape_home", null);
const sightings = db.prepare("SELECT COUNT(*) FROM video_sightings WHERE video_id = ?").pluck().get(VID);
check("null run_id sightings both recorded (unique index ignores NULLs)", sightings, 2);

// cleanup
db.prepare("DELETE FROM videos WHERE id = ?").run(VID);
db.prepare("DELETE FROM channels WHERE id = ?").run(CID);

console.log(failures === 0 ? "\nmerge precedence: all checks passed" : `\nmerge precedence: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
