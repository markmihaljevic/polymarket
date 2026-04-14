// Public read endpoint for the latest snapshot. The page fetches this client-
// side so it can poll for updates without a full page reload.

import { NextResponse } from "next/server";
import { readSnapshot } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const snap = await readSnapshot();
  if (!snap) {
    return NextResponse.json(
      { ok: false, error: "no snapshot yet — waiting for first cron run" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, snapshot: snap });
}
