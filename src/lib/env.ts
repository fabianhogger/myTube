import path from "node:path";

/** Repo root. All local state lives under <root>/data. */
export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "mytube.db");
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

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.local.example to .env.local and fill it in.`);
  return v;
}
