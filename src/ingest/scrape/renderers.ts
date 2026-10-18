/**
 * Extraction from ytInitialData. Every accessor is a tolerant multi-path walk,
 * never a property chain: YouTube is mid-migration from *Renderer to *ViewModel
 * and a single response can carry a mix of both shapes.
 */
import { parseClockDuration, parseRelativeTime, parseViewCount } from "../../lib/format";
import type { VideoInput } from "../../lib/types";

type Any = Record<string, any>;

/** First defined value among dotted paths. Array indices are plain numbers: "title.runs.0.text". */
export function pick<T = unknown>(obj: unknown, ...paths: string[]): T | undefined {
  for (const p of paths) {
    let cur: any = obj;
    for (const seg of p.split(".")) {
      if (cur == null) break;
      cur = cur[seg];
    }
    if (cur !== undefined && cur !== null) return cur as T;
  }
  return undefined;
}

export type ExtractStats = { entries: number; videos: number; skipped: number; shapes: Record<string, number> };

const newStats = (): ExtractStats => ({ entries: 0, videos: 0, skipped: 0, shapes: {} });

function note(stats: ExtractStats, shape: string) {
  stats.shapes[shape] = (stats.shapes[shape] ?? 0) + 1;
}

const isShortsUrl = (r: Any) =>
  String(pick(r, "navigationEndpoint.commandMetadata.webCommandMetadata.url") ?? "").includes("/shorts/");

/** The classic shape, used by home, subscriptions and search. */
function fromVideoRenderer(r: Any, now: Date): VideoInput | null {
  const id = pick<string>(r, "videoId");
  if (!id) return null;
  const title =
    pick<string>(r, "title.runs.0.text", "title.simpleText", "title.accessibility.accessibilityData.label") ?? "";
  if (!title) return null;

  const durationText = pick<string>(r, "lengthText.simpleText", "lengthText.runs.0.text");
  const duration = parseClockDuration(durationText ?? null);
  const publishedText = pick<string>(r, "publishedTimeText.simpleText", "publishedTimeText.runs.0.text");

  const badges = (pick<Any[]>(r, "badges") ?? [])
    .map((b) => String(pick(b, "metadataBadgeRenderer.style") ?? ""));
  const isLive =
    badges.includes("BADGE_STYLE_TYPE_LIVE_NOW") ||
    pick(r, "thumbnailOverlays") !== undefined &&
      JSON.stringify(pick(r, "thumbnailOverlays")).includes("LIVE");
  const isUpcoming = pick(r, "upcomingEventData") !== undefined;

  return {
    id,
    channelId: pick<string>(
      r,
      "ownerText.runs.0.navigationEndpoint.browseEndpoint.browseId",
      "longBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId",
      "shortBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId",
    ) ?? null,
    channelTitle:
      pick<string>(r, "ownerText.runs.0.text", "longBylineText.runs.0.text", "shortBylineText.runs.0.text") ?? null,
    title,
    description:
      pick<string>(r, "descriptionSnippet.runs.0.text", "detailedMetadataSnippets.0.snippetText.runs.0.text") ?? null,
    durationSeconds: duration,
    // Relative text only: stored approximate so RSS/API can upgrade it.
    publishedAt: parseRelativeTime(publishedText ?? null, now),
    publishedApprox: true,
    viewCount: parseViewCount(
      pick<string>(r, "viewCountText.simpleText", "shortViewCountText.simpleText", "viewCountText.runs.0.text") ?? null,
    ),
    thumbnailUrl: lastThumb(pick<Any[]>(r, "thumbnail.thumbnails")) ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isShort: isShortsUrl(r) || (duration != null && duration <= 180),
    isLive: Boolean(isLive),
    isUpcoming,
    raw: undefined,
  };
}

/** Shorts shelf entries. */
function fromReelItemRenderer(r: Any, _now: Date): VideoInput | null {
  const id = pick<string>(r, "videoId");
  if (!id) return null;
  const title = pick<string>(r, "headline.simpleText", "headline.runs.0.text", "accessibility.accessibilityData.label");
  if (!title) return null;
  return {
    id,
    channelId: null,
    channelTitle: null,
    title,
    description: null,
    durationSeconds: null,
    publishedAt: null,
    publishedApprox: true,
    viewCount: parseViewCount(pick<string>(r, "viewCountText.simpleText") ?? null),
    thumbnailUrl: lastThumb(pick<Any[]>(r, "thumbnail.thumbnails")) ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isShort: true,
    isLive: false,
    isUpcoming: false,
  };
}

/**
 * The newer rollout shape. contentId carries the video id, and the metadata
 * rows are loose parts rather than named fields: the human-readable value is in
 * `text.content` ("9.4M", "5d ago") while the classification lives in
 * `accessibilityLabel` ("9.4 million views", "5 days ago"). Both are used.
 */
function fromLockupViewModel(r: Any, now: Date): VideoInput | null {
  const id = pick<string>(r, "contentId");
  if (!id) return null;
  const meta = pick<Any>(r, "metadata.lockupMetadataViewModel") ?? {};
  const title = pick<string>(meta, "title.content", "title.simpleText");
  if (!title) return null;

  type Part = { content: string; label: string; hasPlayIcon: boolean };
  const parts: Part[] = [];
  const rows = pick<Any[]>(meta, "metadata.contentMetadataViewModel.metadataRows") ?? [];
  for (const row of rows) {
    for (const part of pick<Any[]>(row, "metadataParts") ?? []) {
      const content = pick<string>(part, "text.content");
      if (!content) continue;
      parts.push({
        content,
        label: pick<string>(part, "accessibilityLabel") ?? "",
        hasPlayIcon: String(pick(part, "leadingIcon.name") ?? "").includes("PLAY_ARROW"),
      });
    }
  }

  const isViews = (p: Part) => p.hasPlayIcon || /\bviews?\b/i.test(p.label) || /\bviews?\b/i.test(p.content);
  const isAge = (p: Part) => /\bago\b/i.test(p.label) || /\bago\b/i.test(p.content);

  const viewsPart = parts.find(isViews);
  const agePart = parts.find(isAge);
  // Whatever is left is the channel — absent on a channel's own page, present on home.
  const channelPart = parts.find((p) => !isViews(p) && !isAge(p) && !/^\d/.test(p.content));

  const duration = parseClockDuration(findDurationBadge(r));
  const isShortsLockup =
    String(pick(r, "rendererContext.commandContext.onTap.innertubeCommand.commandMetadata.webCommandMetadata.url") ?? "")
      .includes("/shorts/") ||
    String(pick(r, "contentType") ?? "").includes("SHORTS");

  return {
    id,
    channelId:
      pick<string>(
        meta,
        "image.decoratedAvatarViewModel.avatar.avatarViewModel.rendererContext.commandContext.onTap.innertubeCommand.browseEndpoint.browseId",
      ) ?? null,
    channelTitle: channelPart?.content ?? null,
    title,
    description: null,
    durationSeconds: duration,
    // The abbreviated content ("5d ago") is harder to parse than the label
    // ("5 days ago"), so the label is tried first.
    publishedAt: parseRelativeTime(agePart?.label ?? null, now) ?? parseRelativeTime(agePart?.content ?? null, now),
    publishedApprox: true,
    viewCount: parseViewCount(viewsPart?.content ?? null) ?? parseViewCount(viewsPart?.label ?? null),
    thumbnailUrl:
      pick<string>(r, "contentImage.thumbnailViewModel.image.sources.0.url") ??
      `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isShort: isShortsLockup || (duration != null && duration <= 180),
    isLive: false,
    isUpcoming: false,
  };
}

/** The duration overlay in lockupViewModel is nested unpredictably; search for it. */
function findDurationBadge(r: Any): string | null {
  const overlays = pick<Any[]>(r, "contentImage.thumbnailViewModel.overlays") ?? [];
  const json = JSON.stringify(overlays);
  const m = /"text":"(\d{1,2}:\d{2}(?::\d{2})?)"/.exec(json);
  return m ? m[1] : null;
}

function lastThumb(thumbs: Any[] | undefined): string | null {
  if (!thumbs?.length) return null;
  return pick<string>(thumbs[thumbs.length - 1], "url") ?? null;
}

/**
 * A shelf row ("Mix for you", "Because you watched ...") holds its own list of
 * items. These must be descended into rather than skipped: on the logged-in
 * home feed most videos arrive inside a shelf.
 */
function shelfItems(content: Any): Any[] | null {
  return (
    pick<Any[]>(content, "richSectionRenderer.content.richShelfRenderer.contents") ??
    pick<Any[]>(content, "richShelfRenderer.contents") ??
    pick<Any[]>(content, "richSectionRenderer.content.richGridRenderer.contents") ??
    pick<Any[]>(content, "shelfRenderer.content.horizontalListRenderer.items") ??
    pick<Any[]>(content, "reelShelfRenderer.items") ??
    null
  );
}

/** Dispatches one grid/section entry through whichever shape it turns out to be. */
function extractEntry(entry: Any, stats: ExtractStats, now: Date): VideoInput | null {
  stats.entries++;

  // Unwrap the richItemRenderer / itemSectionRenderer envelopes.
  const content: Any =
    pick<Any>(entry, "richItemRenderer.content") ?? pick<Any>(entry, "content") ?? entry;

  const candidates: [string, (r: Any, now: Date) => VideoInput | null][] = [
    ["videoRenderer", fromVideoRenderer],
    ["gridVideoRenderer", fromVideoRenderer],
    ["compactVideoRenderer", fromVideoRenderer],
    ["reelItemRenderer", fromReelItemRenderer],
    ["shortsLockupViewModel", fromLockupViewModel],
    ["lockupViewModel", fromLockupViewModel],
  ];

  for (const [key, fn] of candidates) {
    const r = content[key] ?? (entry as Any)[key];
    if (r) {
      const out = fn(r, now);
      if (out) {
        note(stats, key);
        stats.videos++;
        return out;
      }
      note(stats, `${key}:unparsed`);
      stats.skipped++;
      return null;
    }
  }

  // Ads and continuation sentinels: expected, not errors.
  const known = ["continuationItemRenderer", "adSlotRenderer", "promotedSparklesWebRenderer", "feedNudgeRenderer"];
  const seen = known.find((k) => content[k] ?? (entry as Any)[k]);
  note(stats, seen ?? `unknown:${Object.keys(content).slice(0, 2).join("+") || "empty"}`);
  stats.skipped++;
  return null;
}

/**
 * Walks both browse layouts. Home and subscriptions normally use richGrid, but
 * subscriptions can also serve the date-grouped shelf/grid layout, so both are
 * handled rather than guessing which one is live today.
 */
export function extractFromBrowseData(data: unknown): { videos: VideoInput[]; stats: ExtractStats } {
  const stats = newStats();
  const now = new Date();
  const videos: VideoInput[] = [];
  const seen = new Set<string>();

  const add = (v: VideoInput | null) => {
    if (v && !seen.has(v.id)) {
      seen.add(v.id);
      videos.push(v);
    }
  };

  /** Expands shelves one level at a time so a nested row still yields its videos. */
  const push = (entry: Any, depth = 0) => {
    const content: Any = pick<Any>(entry, "richItemRenderer.content") ?? entry;
    const items = depth < 3 ? shelfItems(content) : null;
    if (items) {
      note(stats, "shelf");
      for (const item of items) push(item, depth + 1);
      return;
    }
    add(extractEntry(entry, stats, now));
  };

  const tabs = pick<Any[]>(data, "contents.twoColumnBrowseResultsRenderer.tabs") ?? [];
  const tab =
    tabs.find((t) => pick<boolean>(t, "tabRenderer.selected") === true) ??
    tabs.find((t) => pick(t, "tabRenderer.content") !== undefined);
  const tabContent = pick<Any>(tab, "tabRenderer.content");

  // Layout 1: richGridRenderer (home, and usually subscriptions)
  for (const entry of pick<Any[]>(tabContent, "richGridRenderer.contents") ?? []) {
    push(entry);
  }

  // Layout 2: sectionList -> itemSection -> shelf -> grid (date-grouped subscriptions)
  for (const section of pick<Any[]>(tabContent, "sectionListRenderer.contents") ?? []) {
    const items = pick<Any[]>(section, "itemSectionRenderer.contents") ?? [];
    for (const item of items) {
      const gridItems =
        pick<Any[]>(item, "shelfRenderer.content.gridRenderer.items") ??
        pick<Any[]>(item, "gridRenderer.items") ??
        pick<Any[]>(item, "shelfRenderer.content.expandedShelfContentsRenderer.items");
      if (gridItems) {
        for (const gi of gridItems) push(gi);
      } else {
        push(item);
      }
    }
  }

  return { videos, stats };
}

/** Continuation responses from /youtubei/v1/browse carry the same entry shapes. */
export function extractFromContinuation(payload: unknown): { videos: VideoInput[]; stats: ExtractStats } {
  const stats = newStats();
  const now = new Date();
  const videos: VideoInput[] = [];
  const seen = new Set<string>();

  const actions = [
    ...(pick<Any[]>(payload, "onResponseReceivedActions") ?? []),
    ...(pick<Any[]>(payload, "onResponseReceivedEndpoints") ?? []),
  ];
  for (const action of actions) {
    const items =
      pick<Any[]>(action, "appendContinuationItemsAction.continuationItems") ??
      pick<Any[]>(action, "reloadContinuationItemsCommand.continuationItems") ??
      [];
    for (const entry of items) {
      const content: Any = pick<Any>(entry, "richItemRenderer.content") ?? entry;
      const shelf = shelfItems(content);
      const candidates = shelf ?? [entry];
      for (const c of candidates) {
        const v = extractEntry(c, stats, now);
        if (v && !seen.has(v.id)) {
          seen.add(v.id);
          videos.push(v);
        }
      }
    }
  }
  return { videos, stats };
}
