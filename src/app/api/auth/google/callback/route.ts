import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode } from "@/ingest/google/oauth";
import { logger } from "@/lib/log";

const log = logger("api:oauth");

/** Google redirects a real browser here, so this has to be a GET endpoint. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const error = params.get("error");
  const code = params.get("code");
  const state = params.get("state");
  const expected = req.cookies.get("mytube_oauth_state")?.value;

  if (error) return fail(`Google returned: ${error}`, 400);
  if (!expected || state !== expected) return fail("State mismatch — start the flow again.", 400);
  if (!code) return fail("No authorization code in the callback.", 400);

  try {
    await exchangeCode(code);
    log.info("refresh token stored");
    const res = NextResponse.redirect(new URL("/", req.nextUrl.origin));
    res.cookies.delete("mytube_oauth_state");
    return res;
  } catch (err) {
    log.error(`token exchange failed: ${(err as Error).message}`);
    return fail((err as Error).message, 500);
  }
}

function fail(message: string, status: number) {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>MyTube</title>
     <body style="font:16px system-ui;padding:3rem;max-width:34rem">
     <h1>Could not connect</h1><p>${message}</p><p><a href="/">back to MyTube</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
