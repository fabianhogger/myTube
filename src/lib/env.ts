import fs from "node:fs";
import path from "node:path";

/** Repo root. All local state lives under <root>/data. */
export const ROOT = process.cwd();

/**
 * Next loads .env.local by itself, but the CLI scripts (`npm run ingest`,
 * `npm run filter`) are plain node processes and would otherwise start with no
 * API keys. Existing process env always wins, so an inline override still works.
 */
function loadEnvLocal(): void {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

// Next already loads .env.local itself; this is only for the plain-node scripts.
if (!process.env.NEXT_RUNTIME) loadEnvLocal();
export const DATA_DIR = path.join(ROOT, "data");
/** Overridable so the smoke tests get their own database and never touch the real feed. */
export const DB_PATH = process.env.MYTUBE_DB_PATH
  ? path.resolve(ROOT, process.env.MYTUBE_DB_PATH)
  : path.join(DATA_DIR, "mytube.db");
export const CHROME_PROFILE_DIR = path.join(DATA_DIR, "chrome-profile");
export const DEBUG_DIR = path.join(DATA_DIR, "debug");
export const LOG_DIR = path.join(DATA_DIR, "logs");
export const FIXTURES_DIR = path.join(ROOT, "fixtures");
export const PROMPT_PATH = path.join(ROOT, "filter-prompt.md");
export const PROMPT_EXAMPLE_PATH = path.join(ROOT, "filter-prompt.example.md");

const flag = (name: string) => {
  const v = process.env[name];
  return v === "1" || v === "true";
};

/** Serve every network source from fixtures/ instead of the network. */
export const OFFLINE = () => flag("MYTUBE_OFFLINE");
/** Decide verdicts locally instead of calling Claude. */
export const FAKE_LLM = () => flag("MYTUBE_FAKE_LLM");
/** Headless unless explicitly disabled. */
export const SCRAPE_HEADLESS = () => process.env.MYTUBE_SCRAPE_HEADLESS !== "0";
/** Undefined means "use Playwright's bundled Chromium". */
export const CHROME_CHANNEL = () => process.env.MYTUBE_CHROME_CHANNEL || undefined;
export const BASE_URL = () => process.env.MYTUBE_BASE_URL || "http://localhost:3000";
export const OAUTH_REDIRECT_URI = () => `${BASE_URL()}/api/auth/google/callback`;
export const OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

/**
 * Optional. videos.list reads only public data, so a plain API key is enough and
 * keeps enrichment working even when the OAuth token is missing or expired.
 * Your private subscription list still requires OAuth.
 */
export const YOUTUBE_API_KEY = () => process.env.YOUTUBE_API_KEY || undefined;

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.local.example to .env.local and fill it in.`);
  return v;
}
