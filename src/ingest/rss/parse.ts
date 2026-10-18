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

  const channelId = text(feed["yt:channelId"]) ?? null;
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
      channelId: channelId ?? text(e["yt:channelId"]),
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
