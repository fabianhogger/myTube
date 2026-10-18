import { XMLParser } from "fast-xml-parser";
import { cleanDescription } from "../../lib/format";
import type { VideoInput } from "../../lib/types";

// isArray forces single-entry feeds to still parse as arrays — otherwise a
// channel with exactly one upload parses to an object and silently yields none.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => name === "entry",
});

type Entry = Record<string, any>;
type Any = Record<string, any>;

/** A 22-char id with no "UC" prefix is the stripped feed-level form; restore it. */
export function normalizeChannelId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (trimmed.startsWith("UC")) return trimmed;
  return /^[A-Za-z0-9_-]{22}$/.test(trimmed) ? `UC${trimmed}` : trimmed;
}

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in (v as object)) return String((v as any)["#text"]);
  return String(v);
}

/** Parses a channel RSS feed into VideoInputs. Exact publish timestamps. */
export function parseChannelFeed(xml: string): { channelId: string | null; channelTitle: string | null; videos: VideoInput[] } {
  const doc = parser.parse(xml);
  const feed = doc?.feed;
  if (!feed) return { channelId: null, channelTitle: null, videos: [] };

  // YouTube's RSS strips the leading "UC" from the FEED-level <yt:channelId>
  // ("yt:channel:HnyfMq..."), while entries and the self link keep it. Prefer a
  // source that carries the real id, and repair the stripped form as a fallback.
  const selfHref = (Array.isArray(feed.link) ? feed.link : [feed.link])
    .map((l: Any) => (l ? String(l["@href"] ?? "") : ""))
    .find((href: string) => href.includes("channel_id=") || href.includes("/channel/"));
  const fromHref =
    /channel_id=(UC[\w-]{20,})/.exec(selfHref ?? "")?.[1] ??
    /\/channel\/(UC[\w-]{20,})/.exec(selfHref ?? "")?.[1] ??
    null;

  const channelId = fromHref ?? normalizeChannelId(text(feed["yt:channelId"]));
  const channelTitle = text(feed.title) ?? null;
  const entries: Entry[] = Array.isArray(feed.entry) ? feed.entry : [];

  const videos: VideoInput[] = [];
  for (const e of entries) {
    const id = text(e["yt:videoId"]);
    const title = text(e.title);
    if (!id || !title) continue;
    const group = e["media:group"] ?? {};
    const community = group["media:community"] ?? {};
    const views = community["media:statistics"]?.["@views"];
    const thumb = group["media:thumbnail"]?.["@url"];
    videos.push({
      id,
      channelId: normalizeChannelId(text(e["yt:channelId"])) ?? channelId,
      channelTitle: text(e.author?.name) ?? channelTitle,
      title,
      description: cleanDescription(text(group["media:description"]), 5000),
      // RSS carries no duration; videos.list enrichment supplies it.
      durationSeconds: null,
      publishedAt: text(e.published),
      publishedApprox: false,
      viewCount: views != null && Number.isFinite(Number(views)) ? Number(views) : null,
      thumbnailUrl: thumb ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      raw: undefined,
    });
  }
  return { channelId, channelTitle, videos };
}
