// Snapshot caching.
//
// We use Next.js's `unstable_cache` as the primary persistence layer. On
// Vercel this is backed by the managed Data Cache, which is shared across
// all invocations of the serverless function — no external Redis required.
//
// - /api/snapshot reads via `getCachedSnapshot`
// - /api/cron/refresh calls `revalidateTag(SNAPSHOT_TAG)` to mark stale,
//   then calls `getCachedSnapshot()` again to force a rebuild + re-cache.
//
// We also keep a tiny in-process mirror so that within a warm serverless
// invocation, consecutive polls are served instantly.

import { unstable_cache } from "next/cache";
import { buildSnapshot } from "./compare";
import type { Snapshot } from "./types";

export const SNAPSHOT_TAG = "snapshot-v1";
const CACHE_KEY = "pm-pinnacle-snapshot-v1";

// Soft TTL inside the cached function. We revalidate hourly as a safety net,
// but the cron invalidates every 5 min so that's the effective refresh rate.
const REVALIDATE_SECONDS = 60 * 60;

export const getCachedSnapshot: () => Promise<Snapshot> = unstable_cache(
  async () => {
    const started = Date.now();
    const snap = await buildSnapshot();
    console.log(
      `[cache] built snapshot in ${Date.now() - started}ms (rows=${snap.rows.length})`,
    );
    return snap;
  },
  [CACHE_KEY],
  { revalidate: REVALIDATE_SECONDS, tags: [SNAPSHOT_TAG] },
);
