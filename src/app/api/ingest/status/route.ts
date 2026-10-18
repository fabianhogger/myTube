import { NextResponse } from "next/server";
import { readStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await readStatus();
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
