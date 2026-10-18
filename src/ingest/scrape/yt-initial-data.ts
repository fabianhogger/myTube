import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { DEBUG_DIR } from "../../lib/env";
import { NamedError } from "../../lib/types";

/**
 * Reads ytInitialData from the live page, with an HTML regex fallback. The two
 * paths fail independently: occasionally the var is set by a different bootstrap
 * and window.ytInitialData is absent at evaluate time.
 */
export async function readYtInitialData(page: Page): Promise<unknown> {
  const fromWindow = await page
    .evaluate(() => (window as unknown as { ytInitialData?: unknown }).ytInitialData ?? null)
    .catch(() => null);
  if (fromWindow && typeof fromWindow === "object") return fromWindow;

  const html = await page.content();
  const m = /ytInitialData"?\s*=\s*({[\s\S]+?});\s*(?:<\/script>|var )/.exec(html);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      /* fall through to the error below */
    }
  }
  throw new NamedError(
    "no_initial_data",
    `ytInitialData not found on ${page.url()} (page was ${html.length} bytes)`,
  );
}

/**
 * The single artifact that turns "the shape changed again" into a short fix.
 * Written on every extraction failure.
 */
export function dumpDebug(runId: number | null, source: string, payload: unknown): string {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const file = path.join(DEBUG_DIR, `${runId ?? "adhoc"}-${source}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

/**
 * YouTube answers a logged-out browse with a feedNudgeRenderer ("sign in to get
 * your recommendations") and no video entries. Recognising that shape turns an
 * opaque "extracted 0 videos" into an instruction.
 */
export function looksLoggedOut(data: unknown): boolean {
  const s = JSON.stringify(data ?? {});
  return s.includes("feedNudgeRenderer") || s.includes("ytd-shelf-renderer-sign-in");
}

/** Pre-flight: tell a signed-out profile apart from a consent wall and a bot check. */
export async function assertUsablePage(page: Page): Promise<void> {
  const url = page.url();
  if (/\/signin|ServiceLogin|accounts\.google\.com/.test(url)) {
    throw new NamedError("not_signed_in", `redirected to ${url} — run \`npm run yt:login\``);
  }
  if (/consent\.youtube\.com|consent\.google\.com/.test(url)) {
    throw new NamedError(
      "consent_wall",
      "YouTube is showing a consent wall — the profile lost its SOCS cookie. Run `npm run yt:login`.",
    );
  }
  const body = await page.locator("body").innerText().catch(() => "");
  if (/confirm you'?re not a bot|unusual traffic/i.test(body)) {
    throw new NamedError(
      "bot_check",
      "YouTube served a bot interstitial. Retry with MYTUBE_SCRAPE_HEADLESS=0, or run `npm run yt:login` again.",
    );
  }
}
