// Cron endpoint: Vercel Cron hits this every 5 min (see vercel.json).
// It invalidates the cached snapshot and immediately rebuilds it, so the
// next reader gets fresh data with zero latency.
//
// Auth: if CRON_SECRET is set, Vercel Cron automatically sends
// `Authorization: Bearer <CRON_SECRET>`. We accept that header, OR a
// `?key=` query param so you can trigger a manual refresh via a plain curl.

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { SNAPSHOT_TAG, getCachedSnapshot } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured -> allow
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${secret}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("key") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.ODDS_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "ODDS_API_KEY is not set. Add it in Vercel → Project Settings → Environment Variables and redeploy.",
      },
      { status: 500 },
    );
  }
  try {
    // Mark the cached snapshot stale, then immediately re-build so the next
    // reader gets a fresh payload without having to wait for the compute.
    revalidateTag(SNAPSHOT_TAG);
    const snapshot = await getCachedSnapshot();
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

export const GET = handle;
export const POST = handle;
