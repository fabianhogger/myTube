/**
 * Manage channels and the ban list. A banned channel is hidden from the feed,
 * skipped during RSS polling, and — the part that matters — never sent to Claude,
 * so you stop paying to judge videos you will never see.
 *
 *   npm run channels                      list channels (most videos first)
 *   npm run channels -- --banned          just the banned ones
 *   npm run channels -- --countries       country breakdown
 *   npm run channels -- --ban "<query>"   ban by id, title, or substring
 *   npm run channels -- --unban "<query>"
 *   npm run channels -- --ban-country GR  ban every channel from a country
 *   npm run channels -- --reason "too much drama"   annotate a ban
 *   npm run channels -- --limit 40
 *
 * Bans are reversible and never delete anything: unbanning restores the
 * channel's existing verdicts and videos immediately.
 */
import { getDb } from "../src/lib/db";
import { getActivePrompt } from "../src/lib/prompt";
import {
  bannedChannels, channelOverview, channelsByCountry, findChannels, setBanned,
} from "../src/lib/repo/channels";
import { logger } from "../src/lib/log";

const log = logger("channels");
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const val = (f: string) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

getDb();
const prompt = getActivePrompt();
const limit = Number(val("limit") ?? 50);
const reason = val("reason");

function row(c: { title: string; country: string | null; videos: number; passed: number; is_banned: number; id: string }) {
  const flag = c.is_banned ? "BANNED" : "";
  return `  ${(c.country ?? "--").padEnd(3)} ${String(c.videos).padStart(4)} vids ${String(c.passed ?? 0).padStart(4)} pass  ${c.title.slice(0, 40).padEnd(42)} ${flag}`;
}

/** Shows what a query matched and bans it, refusing to guess between many matches. */
function applyBan(query: string, banned: boolean) {
  const matches = findChannels(query);
  if (matches.length === 0) {
    log.error(`no channel matches "${query}". List them with: npm run channels`);
    process.exit(1);
  }
  if (matches.length > 1 && !has("yes")) {
    log.warn(`"${query}" matches ${matches.length} channels:`);
    for (const m of matches) console.log(`    ${m.id}  ${m.title}${m.is_banned ? "  (already banned)" : ""}`);
    log.warn("Re-run with an exact title or id, or add --yes to apply to all of them.");
    process.exit(2);
  }
  const n = setBanned(matches.map((m) => m.id), banned, reason);
  log.info(`${banned ? "banned" : "unbanned"} ${n} channel(s): ${matches.map((m) => m.title).join(", ")}`);
  if (banned) {
    const hidden = getDb()
      .prepare(
        `SELECT COUNT(*) FROM videos WHERE channel_id IN (${matches.map(() => "?").join(",")})`,
      )
      .pluck()
      .get(...matches.map((m) => m.id)) as number;
    log.info(`${hidden} video(s) now hidden and excluded from future filtering`);
  }
}

const banQuery = val("ban");
const unbanQuery = val("unban");
const banCountry = val("ban-country");

if (banQuery) {
  applyBan(banQuery, true);
} else if (unbanQuery) {
  applyBan(unbanQuery, false);
} else if (banCountry) {
  const matches = channelsByCountry(banCountry);
  if (!matches.length) {
    log.error(`no channels with country "${banCountry.toUpperCase()}". See: npm run channels -- --countries`);
    process.exit(1);
  }
  if (!has("yes")) {
    log.warn(`${matches.length} channel(s) from ${banCountry.toUpperCase()}:`);
    for (const m of matches) console.log(`    ${m.title}`);
    log.warn("Add --yes to ban them all.");
    process.exit(2);
  }
  const n = setBanned(matches.map((m) => m.id), true, reason ?? `country ${banCountry.toUpperCase()}`);
  log.info(`banned ${n} channel(s) from ${banCountry.toUpperCase()}`);
} else if (has("banned")) {
  const rows = bannedChannels();
  if (!rows.length) {
    console.log("\nno banned channels. Ban one with: npm run channels -- --ban \"<name>\"\n");
  } else {
    console.log(`\nBANNED (${rows.length})\n`);
    for (const c of rows) {
      console.log(`  ${c.id}  ${c.title}${c.banned_reason ? `  — ${c.banned_reason}` : ""}`);
    }
    console.log("\n  unban with: npm run channels -- --unban \"<name>\"\n");
  }
} else if (has("countries")) {
  const rows = getDb()
    .prepare(
      `SELECT COALESCE(country,'--') AS country, COUNT(*) AS channels,
              SUM(is_banned) AS banned
       FROM channels WHERE is_subscribed = 1
       GROUP BY COALESCE(country,'--') ORDER BY channels DESC`,
    )
    .all() as { country: string; channels: number; banned: number }[];
  console.log("\nsubscribed channels by country ('--' = the owner never set one)\n");
  for (const r of rows) {
    console.log(`  ${r.country.padEnd(4)} ${String(r.channels).padStart(4)} channels${r.banned ? `  (${r.banned} banned)` : ""}`);
  }
  console.log("\n  ban a whole country: npm run channels -- --ban-country GR --yes\n");
} else {
  const all = channelOverview(prompt.hash);
  const banned = all.filter((c) => c.is_banned).length;
  console.log(`\n${all.length} channels (${banned} banned) — showing up to ${limit}, most videos first\n`);
  console.log("  cc  vids  pass  title");
  for (const c of all.slice(0, limit)) console.log(row(c));
  console.log(`\n  npm run channels -- --ban "<name>"      hide a channel entirely`);
  console.log(`  npm run channels -- --countries         country breakdown\n`);
}
