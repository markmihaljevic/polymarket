// Cron endpoint: Vercel Cron calls this on a schedule (see vercel.json).
// It rebuilds the snapshot and writes it to KV. Protected by CRON_SECRET.

import { NextResponse } from "next/server";
import { buildSnapshot } from "@/lib/compare";
import { writeSnapshot } from "@/lib/kv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Give the function up to 60s to finish fetching both data sources.
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured -> no auth enforced (dev)
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const snapshot = await buildSnapshot();
    await writeSnapshot(snapshot);
    return NextResponse.json({
      ok: true,
      updatedAt: snapshot.updatedAt,
      stats: snapshot.stats,
    });
  } catch (e) {
    console.error("[cron/refresh] failed:", e);
    return NextResponse.json(
      { ok: false, error: (e as Error).message ?? String(e) },
      { status: 500 },
    );
  }
}

// Also accept POST so you can trigger a refresh from the UI or curl without
// having to think about method. Same handler.
export const POST = GET;
