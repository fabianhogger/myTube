import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { consentUrl } from "@/ingest/google/oauth";

/** Kicks off the Google consent flow. State is round-tripped in a cookie. */
export async function GET() {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    const res = NextResponse.redirect(consentUrl(state));
    res.cookies.set("mytube_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return res;
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
