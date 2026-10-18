import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { FIXTURES_DIR, OFFLINE, YOUTUBE_API_KEY } from "../../lib/env";
import { logger } from "../../lib/log";
import { setChannelMeta, upsertChannels, uploadsPlaylistId } from "../../lib/repo/channels";
import type { ChannelInput } from "../../lib/types";
import { authorizedClient, youtubeClient } from "./oauth";

const log = logger("subscriptions");

type RawSubs = {
  items?: {
    snippet?: {
      title?: string | null;
      resourceId?: { channelId?: string | null } | null;
      thumbnails?: { default?: { url?: string | null } | null } | null;
    } | null;
  }[];
  nextPageToken?: string | null;
};

function toChannels(pages: RawSubs[]): ChannelInput[] {
  const out: ChannelInput[] = [];
  for (const page of pages) {
    for (const item of page.items ?? []) {
      const id = item.snippet?.resourceId?.channelId;
      if (!id) continue;
      out.push({
        id,
        title: item.snippet?.title ?? id,
        thumbnailUrl: item.snippet?.thumbnails?.default?.url ?? null,
        uploadsPlaylistId: uploadsPlaylistId(id),
        isSubscribed: true,
      });
    }
  }
  return out;
}

/** 1 quota unit per page, 50 channels per page. */
export async function syncSubscriptions(): Promise<{ found: number; inserted: number }> {
  let pages: RawSubs[];

  if (OFFLINE()) {
    const file = path.join(FIXTURES_DIR, "subscriptions.json");
    log.info(`offline: reading ${file}`);
    pages = [JSON.parse(fs.readFileSync(file, "utf8"))];
  } else {
    const yt = youtubeClient(await authorizedClient());
    pages = [];
    let pageToken: string | undefined;
    do {
      const res = await yt.subscriptions.list({
        part: ["snippet"],
        mine: true,
        maxResults: 50,
        pageToken,
      });
      pages.push(res.data as RawSubs);
      pageToken = res.data.nextPageToken ?? undefined;
      log.info(`page ${pages.length}: ${res.data.items?.length ?? 0} subscriptions`);
    } while (pageToken);
  }

  const channels = toChannels(pages);
  if (channels.length === 0) {
    throw new Error("subscriptions.list returned no channels — expected at least one subscription");
  }
  const result = upsertChannels(channels);
  log.info(`${result.found} subscriptions (${result.inserted} new channels)`);

  if (!OFFLINE()) {
    // channels.list costs 1 unit per 50 ids and fills in snippet.country, which
    // is set for roughly three quarters of channels. Non-fatal: the subscription
    // list is the point of this stage, country is a bonus.
    try {
      await fetchChannelMeta(channels.map((c) => c.id));
    } catch (err) {
      log.warn(`could not fetch channel country/subscribers: ${(err as Error).message}`);
    }
  }
  return result;
}

/** snippet.country is an ISO 3166-1 alpha-2 code, set only when the owner filled it in. */
async function fetchChannelMeta(ids: string[]): Promise<void> {
  const key = YOUTUBE_API_KEY();
  const yt = key
    ? google.youtube({ version: "v3", auth: key })
    : youtubeClient(await authorizedClient());

  const meta: { id: string; country?: string | null; subscriberCount?: number | null }[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await yt.channels.list({
      part: ["snippet", "statistics"],
      id: ids.slice(i, i + 50),
      maxResults: 50,
    });
    for (const c of res.data.items ?? []) {
      if (!c.id) continue;
      meta.push({
        id: c.id,
        country: c.snippet?.country ?? null,
        subscriberCount: c.statistics?.subscriberCount ? Number(c.statistics.subscriberCount) : null,
      });
    }
  }
  setChannelMeta(meta);
  const known = meta.filter((m) => m.country).length;
  log.info(`country known for ${known}/${meta.length} channels`);
}
