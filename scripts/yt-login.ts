/**
 * Headed sign-in into the persistent Chrome profile the scraper reuses.
 * Run once, and again whenever Google invalidates the session.
 */
import { CHROME_CHANNEL, CHROME_PATH, CHROME_PROFILE_DIR } from "../src/lib/env";
import { isSignedIn, launchContext, signInDetail, YT_AUTH_COOKIE } from "../src/ingest/scrape/browser";
import { logger } from "../src/lib/log";

const log = logger("yt:login");
const TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 2000;

async function main() {
  const which = CHROME_PATH() ?? CHROME_CHANNEL() ?? "Playwright's bundled Chromium";
  log.info(`opening ${which}`);
  log.info(`profile: ${CHROME_PROFILE_DIR}`);
  log.info("Sign in to YouTube in that window, accept any cookie/consent dialog, and");
  log.info("check that your avatar appears in the top-right of youtube.com.");
  log.info("Signing into Google alone is not enough — YouTube issues its own cookie.");

  const ctx = await launchContext({ headless: false });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });

    // Poll for the session cookie rather than waiting on a keypress, so the
    // script knows when it is actually done.
    const deadline = Date.now() + TIMEOUT_MS;
    let signedIn = false;
    let noticedGoogleOnly = false;
    while (Date.now() < deadline) {
      if (await isSignedIn(ctx)) {
        signedIn = true;
        break;
      }
      // The common half-finished state: Google session, no YouTube session.
      const detail = await signInDetail(ctx);
      if (detail.google && !detail.youtube && !noticedGoogleOnly) {
        noticedGoogleOnly = true;
        log.warn("signed into Google, but YouTube has not issued its cookie yet.");
        log.warn("Open https://www.youtube.com and confirm your avatar is top-right.");
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    if (!signedIn) {
      const detail = await signInDetail(ctx);
      log.error(
        `no YouTube session (${YT_AUTH_COOKIE} on .youtube.com) after 10 minutes — nothing usable saved.` +
          (detail.google ? " A Google session was found, but YouTube itself never signed in." : ""),
      );
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
