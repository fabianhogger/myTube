import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, OFFLINE } from "../../lib/env";
import { logger } from "../../lib/log";
import { upsertChannels, uploadsPlaylistId } from "../../lib/repo/channels";
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
  return result;
}
