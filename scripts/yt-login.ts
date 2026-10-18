/**
 * Headed sign-in into the persistent Chrome profile the scraper reuses.
 * Run once, and again whenever Google invalidates the session.
 */
import { CHROME_CHANNEL, CHROME_PATH, CHROME_PROFILE_DIR } from "../src/lib/env";
import { isSignedIn, launchContext, SESSION_COOKIES } from "../src/ingest/scrape/browser";
import { logger } from "../src/lib/log";

const log = logger("yt:login");
const TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 2000;

async function main() {
  const which = CHROME_PATH() ?? CHROME_CHANNEL() ?? "Playwright's bundled Chromium";
  log.info(`opening ${which}`);
  log.info(`profile: ${CHROME_PROFILE_DIR}`);
  log.info("sign in to YouTube in the window, and accept any cookie/consent dialog.");

  const ctx = await launchContext({ headless: false });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });

    // Poll for the session cookie rather than waiting on a keypress, so the
    // script knows when it is actually done.
    const deadline = Date.now() + TIMEOUT_MS;
    let signedIn = false;
    while (Date.now() < deadline) {
      if (await isSignedIn(ctx)) {
        signedIn = true;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    if (!signedIn) {
      log.error(`no session cookie (${SESSION_COOKIES.join("/")}) after 10 minutes — nothing saved.`);
      process.exitCode = 1;
      return;
    }

    log.info("signed in. Give it a moment, then this window will close itself.");
    // Let YouTube finish writing its consent/preference cookies.
    await new Promise((r) => setTimeout(r, 3000));
  } finally {
    // Closing the context is what flushes cookies to the profile on disk.
    // A process.exit() with the context still open loses the whole session.
    await ctx.close();
  }
  log.info("profile saved. `npm run ingest` can now scrape your logged-in feed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
