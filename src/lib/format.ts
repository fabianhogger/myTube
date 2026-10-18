/** Formatting shared by the UI and the Claude prompt payload, so both agree. */

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "PT12M34S" -> 754. YouTube's contentDetails.duration format. */
export function parseIso8601Duration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  const total = (+(d ?? 0) * 86400) + (+(h ?? 0) * 3600) + (+(min ?? 0) * 60) + +(s ?? 0);
  return total > 0 ? total : null;
}

/** "12:34" / "1:02:03" -> seconds. YouTube's scraped lengthText format. */
export function parseClockDuration(text: string | null | undefined): number | null {
  if (!text) return null;
  const parts = text.trim().split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

const UNIT_SECONDS: Record<string, number> = {
  second: 1, minute: 60, hour: 3600, day: 86400,
  week: 604800, month: 2629800, year: 31557600,
};

/**
 * "3 days ago" -> an ISO timestamp. Coarse by nature, so callers must store the
 * result with published_approx = 1 so an exact value can overwrite it later.
 */
export function parseRelativeTime(text: string | null | undefined, now = new Date()): string | null {
  if (!text) return null;
  const full = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i.exec(text);
  if (full) {
    const secs = Number(full[1]) * UNIT_SECONDS[full[2].toLowerCase()];
    return new Date(now.getTime() - secs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  // The newer lockup shape abbreviates: "5d ago", "3w ago", "2mo ago", "1y ago".
  const abbrev = /(\d+)\s*(s|min|m|h|d|w|mo|y)\s*ago/i.exec(text);
  if (abbrev) {
    const key = abbrev[2].toLowerCase();
    const unit =
      key === "s" ? "second" : key === "min" ? "minute" : key === "h" ? "hour" :
      key === "d" ? "day" : key === "w" ? "week" : key === "mo" ? "month" :
      key === "y" ? "year" : key === "m" ? "month" : null;
    if (!unit) return null;
    const secs = Number(abbrev[1]) * UNIT_SECONDS[unit];
    return new Date(now.getTime() - secs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return null;
}

/** "1.2M views" / "1,234" -> 1200000 / 1234. */
export function parseViewCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const clean = text.replace(/,/g, "");
  // Accessibility labels spell the magnitude out: "9.4 million views".
  const word = /([\d.]+)\s*(thousand|million|billion)/i.exec(clean);
  if (word) {
    const mult = { thousand: 1e3, million: 1e6, billion: 1e9 }[word[2].toLowerCase()]!;
    return Math.round(Number(word[1]) * mult);
  }
  const m = /([\d.]+)\s*([KMB])?/i.exec(clean);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

export function formatViewCount(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K views`;
  return `${n} view${n === 1 ? "" : "s"}`;
}

/**
 * An ISO timestamp -> "3 days ago". Used in the UI and as the `age` field sent
 * to Claude, so a prompt like "nothing older than two weeks" works without the
 * model needing to know today's date.
 */
export function formatRelativeAge(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  const units: [string, number][] = [
    ["year", UNIT_SECONDS.year], ["month", UNIT_SECONDS.month], ["week", UNIT_SECONDS.week],
    ["day", UNIT_SECONDS.day], ["hour", UNIT_SECONDS.hour], ["minute", UNIT_SECONDS.minute],
  ];
  for (const [name, size] of units) {
    const n = Math.floor(secs / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/** Strip URLs, collapse whitespace, hard-cut. Keeps sponsor link-dumps out of the prompt. */
export function cleanDescription(text: string | null | undefined, maxChars = 500): string {
  if (!text) return "";
  const cleaned = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars).trimEnd()}…` : cleaned;
}
