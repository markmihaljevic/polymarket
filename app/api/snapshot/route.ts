// Public read of the latest snapshot.
//
// Backed by Next.js `unstable_cache` — the first call after deploy (or after
// a cron-triggered invalidation) rebuilds; everything else is served from
// Vercel's shared Data Cache. No external Redis required.
//
// Always returns a `diag` block so the client can show a helpful panel when
// something's wrong (missing env var, cron not firing, etc).

import { NextResponse } from "next/server";
import { getCachedSnapshot } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function diag() {
  return {
    hasOddsApiKey: Boolean(process.env.ODDS_API_KEY),
    hasCronSecret: Boolean(process.env.CRON_SECRET),
    vercelEnv: process.env.VERCEL_ENV ?? null,
    region: process.env.VERCEL_REGION ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
  };
}

export async function GET() {
  if (!process.env.ODDS_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "ODDS_API_KEY is not set. Add it in Vercel → Project Settings → Environment Variables and redeploy.",
        diag: diag(),
      },
      { status: 500 },
    );
  }

  try {
    const snapshot = await getCachedSnapshot();
    return NextResponse.json({ ok: true, snapshot, diag: diag() });
  } catch (e) {
    console.error("[api/snapshot] failed:", e);
    return NextResponse.json(
      {
        ok: false,
        error: (e as Error).message ?? String(e),
        diag: diag(),
      },
      { status: 500 },
    );
  }
}
