import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { CHROME_CHANNEL, CHROME_PATH, CHROME_PROFILE_DIR, SCRAPE_HEADLESS } from "../../lib/env";
import { NamedError } from "../../lib/types";

/** Only one process may hold a Chromium profile directory at a time. */
function assertProfileFree(): void {
  const lock = path.join(CHROME_PROFILE_DIR, "SingletonLock");
  if (fs.existsSync(lock)) {
    throw new NamedError(
      "profile_locked",
      "The Chrome profile is in use — close the `npm run yt:login` window (or any other MyTube browser) and retry.",
    );
  }
}

export function profileExists(): boolean {
  return fs.existsSync(path.join(CHROME_PROFILE_DIR, "Default"));
}

export type LaunchOpts = { headless?: boolean };

export async function launchContext(opts: LaunchOpts = {}): Promise<BrowserContext> {
  const headless = opts.headless ?? SCRAPE_HEADLESS();
  if (!headless) assertProfileFree();
  else assertProfileFree();
  fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });

  // An explicit binary wins over a channel name; neither means bundled Chromium.
  const executablePath = CHROME_PATH();
  return chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
    headless,
    executablePath,
    channel: executablePath ? undefined : CHROME_CHANNEL(),
    viewport: headless ? { width: 1440, height: 1000 } : null,
    locale: "en-US",
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/**
 * Wraps the whole scrape in a wall-clock timeout and always closes the browser.
 * A hung Chromium would otherwise hang the ingest forever, and the single-flight
 * lock would then block every future run.
 */
export async function withContext<T>(
  fn: (ctx: BrowserContext) => Promise<T>,
  opts: LaunchOpts & { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const ctx = await launchContext(opts);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NamedError("scrape_timeout", `scrape exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await ctx.close().catch(() => {});
  }
}

/** The cookies that mean "this profile is signed in to Google". */
export const SESSION_COOKIES = ["SAPISID", "__Secure-3PSID", "__Secure-1PSID", "SID"];

export async function isSignedIn(ctx: BrowserContext): Promise<boolean> {
  const cookies = await ctx.cookies();
  return cookies.some((c) => SESSION_COOKIES.includes(c.name) && c.value.length > 0);
}
