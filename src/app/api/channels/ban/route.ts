import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@/lib/log";
import { getChannel, setBanned } from "@/lib/repo/channels";

const log = logger("api:ban");

/**
 * Bans or unbans one channel by id. Reversible by design — the UI offers an
 * undo, so this has to work in both directions.
 */
export async function POST(req: NextRequest) {
  let body: { channelId?: unknown; banned?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }
  // The feed can show a scraped video whose channel was never recorded.
  const channel = getChannel(channelId);
  if (!channel) {
    return NextResponse.json({ error: `unknown channel ${channelId}` }, { status: 404 });
  }

  const banned = body.banned === undefined ? true : Boolean(body.banned);
  const reason = typeof body.reason === "string" ? body.reason : "banned from the feed";

  const changed = setBanned([channelId], banned, banned ? reason : undefined);
  log.info(`${banned ? "banned" : "unbanned"} ${channel.title} (${channelId})`);

  return NextResponse.json({
    channelId,
    title: channel.title,
    banned,
    changed,
  });
}
