import Database from "better-sqlite3";
import fs from "node:fs";
import { DATA_DIR, DB_PATH, DEBUG_DIR, LOG_DIR } from "./env";
import { migrate } from "./migrations";

export type Db = Database.Database;

// Next's dev server re-evaluates modules on every edit. Without a global
// singleton that leaks one SQLite handle per hot reload until the process dies.
declare global {
  var __mytube_db: Db | undefined;
}

function open(): Db {
  for (const dir of [DATA_DIR, DEBUG_DIR, LOG_DIR]) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  // WAL is mandatory: the detached ingest process writes while the Next server reads.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

export function getDb(): Db {
  if (!globalThis.__mytube_db) globalThis.__mytube_db = open();
  return globalThis.__mytube_db;
}

/** ISO8601 UTC to the second — the one timestamp format used everywhere. */
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
