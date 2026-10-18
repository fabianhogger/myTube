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

/**
 * YouTube's own auth cookie, scoped to .youtube.com.
 *
 * Checking for Google's SID/SAPISID is NOT enough: those live on .google.com and
 * are present whenever you are signed into any Google property. You can hold a
 * full Google session while youtube.com still treats you as a logged-out
 * visitor, in which case the home feed returns a "sign in" nudge and no videos.
 * LOGIN_INFO is the cookie that actually means "signed in to YouTube".
 */
export const YT_AUTH_COOKIE = "LOGIN_INFO";

/** Google-scoped session cookies: necessary but not sufficient. Used for diagnostics. */
export const GOOGLE_SESSION_COOKIES = ["SAPISID", "__Secure-3PSID", "__Secure-1PSID", "SID"];

export async function isSignedIn(ctx: BrowserContext): Promise<boolean> {
  const cookies = await ctx.cookies();
  return cookies.some(
    (c) => c.domain.includes("youtube.com") && c.name === YT_AUTH_COOKIE && c.value.length > 0,
  );
}

/** Tells "no Google session at all" apart from "Google yes, YouTube no". */
export async function signInDetail(ctx: BrowserContext): Promise<{
  google: boolean;
  youtube: boolean;
}> {
  const cookies = await ctx.cookies();
  return {
    google: cookies.some((c) => GOOGLE_SESSION_COOKIES.includes(c.name) && c.value.length > 0),
    youtube: cookies.some(
      (c) => c.domain.includes("youtube.com") && c.name === YT_AUTH_COOKIE && c.value.length > 0,
    ),
  };
}
