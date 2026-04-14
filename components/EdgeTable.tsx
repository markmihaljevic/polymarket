"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { EdgeRow, Snapshot, SportGroup } from "@/lib/types";
import { TRACKED_SPORT_GROUPS } from "@/lib/types";

const SPORT_LABELS: Record<SportGroup, string> = {
  Soccer: "Soccer",
  Tennis: "Tennis",
  "American Football": "NFL",
  Basketball: "NBA",
  "Ice Hockey": "NHL",
};

const MIN_EDGE_DEFAULT = Number(process.env.NEXT_PUBLIC_MIN_EDGE ?? "0.02");

interface SnapshotResponse {
  ok: boolean;
  snapshot?: Snapshot;
  error?: string;
  diag?: {
    hasOddsApiKey: boolean;
    hasCronSecret: boolean;
    vercelEnv: string | null;
    region: string | null;
    nodeEnv: string | null;
  };
}

export function EdgeTable() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [diag, setDiag] = useState<SnapshotResponse["diag"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [minEdge, setMinEdge] = useState<number>(MIN_EDGE_DEFAULT);
  const [enabledSports, setEnabledSports] = useState<Set<SportGroup>>(
    () => new Set(TRACKED_SPORT_GROUPS),
  );

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store" });
      const json = (await res.json()) as SnapshotResponse;
      if (json.diag) setDiag(json.diag);
      if (json.ok && json.snapshot) {
        setSnapshot(json.snapshot);
        setError(null);
      } else {
        setError(json.error ?? "failed to load snapshot");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Initial load + polling every 60s.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await loadSnapshot();
    })();
    const id = setInterval(() => {
      if (!cancelled) loadSnapshot();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [loadSnapshot]);

  const forceRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      // Trigger a rebuild via the cron endpoint. If CRON_SECRET is set, this
      // will 401 unless the user has it — in that case we still re-poll the
      // snapshot, which will have been refreshed by Vercel's cron anyway.
      const res = await fetch("/api/cron/refresh", {
        method: "POST",
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          setError(
            "Manual refresh requires CRON_SECRET. Either unset it, or curl the endpoint with the Authorization header. Auto-polling continues.",
          );
        } else {
          setError(json.error ?? `refresh failed: ${res.status}`);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await loadSnapshot();
      setRefreshing(false);
    }
  }, [loadSnapshot]);

  const visibleRows = useMemo(() => {
    if (!snapshot) return [] as EdgeRow[];
    return snapshot.rows.filter(
      (r) => r.edge >= minEdge && enabledSports.has(r.sport),
    );
  }, [snapshot, minEdge, enabledSports]);

  function toggleSport(s: SportGroup) {
    setEnabledSports((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Polymarket vs Pinnacle
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            Markets where Polymarket is paying more than Pinnacle&apos;s de-vigged
            fair price.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 text-right text-xs text-neutral-500">
          {snapshot && (
            <div>
              Updated{" "}
              <time dateTime={snapshot.updatedAt}>
                {new Date(snapshot.updatedAt).toLocaleTimeString()}
              </time>
              <br />
              {snapshot.stats.polymarketEvents} PM ·{" "}
              {snapshot.stats.pinnacleEvents} Pinnacle ·{" "}
              {snapshot.stats.matchedEvents} matched
            </div>
          )}
          <button
            onClick={forceRefresh}
            disabled={refreshing}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="flex flex-wrap gap-2">
          {TRACKED_SPORT_GROUPS.map((s) => {
            const active = enabledSports.has(s);
            return (
              <button
                key={s}
                onClick={() => toggleSport(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  active
                    ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40"
                    : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                }`}
              >
                {SPORT_LABELS[s]}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <label className="text-xs text-neutral-400">min edge</label>
          <input
            type="range"
            min={0}
            max={0.2}
            step={0.005}
            value={minEdge}
            onChange={(e) => setMinEdge(Number(e.target.value))}
            className="w-40 accent-emerald-500"
          />
          <span className="w-12 text-right font-mono text-xs text-neutral-300">
            {(minEdge * 100).toFixed(1)}%
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-amber-600/40 bg-amber-950/30 p-3 text-sm text-amber-300">
          <div className="font-medium">Snapshot error</div>
          <div className="mt-1 font-mono text-xs">{error}</div>
          {diag && (
            <div className="mt-2 text-xs text-amber-400/80">
              env: ODDS_API_KEY={diag.hasOddsApiKey ? "✓" : "✗"} · CRON_SECRET=
              {diag.hasCronSecret ? "✓" : "✗"} · vercel={diag.vercelEnv ?? "?"}{" "}
              · region={diag.region ?? "?"}
            </div>
          )}
        </div>
      )}

      {!snapshot && !error && (
        <div className="py-20 text-center text-sm text-neutral-500">
          Loading latest snapshot…
        </div>
      )}

      {snapshot && visibleRows.length === 0 && (
        <div className="py-16 text-center text-sm text-neutral-500">
          No +EV markets right now matching your filters.
        </div>
      )}

      {visibleRows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900/60 text-xs uppercase tracking-wider text-neutral-400">
              <tr>
                <th className="px-4 py-3 text-left">Sport</th>
                <th className="px-4 py-3 text-left">Event</th>
                <th className="px-4 py-3 text-left">Pick</th>
                <th className="px-4 py-3 text-left">Starts</th>
                <th className="px-4 py-3 text-right">PM price</th>
                <th className="px-4 py-3 text-right">Fair</th>
                <th className="px-4 py-3 text-right">Edge</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r, i) => (
                <tr
                  key={`${r.polymarketUrl}-${r.side}-${i}`}
                  className="border-t border-neutral-800/70 hover:bg-neutral-900/30"
                >
                  <td className="px-4 py-3 text-neutral-400">
                    {SPORT_LABELS[r.sport]}
                  </td>
                  <td className="px-4 py-3 text-neutral-200">{r.eventTitle}</td>
                  <td className="px-4 py-3 text-neutral-200">{r.side}</td>
                  <td className="px-4 py-3 text-xs text-neutral-500">
                    {new Date(r.commenceTime).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-neutral-200">
                    {formatProb(r.pmPrice)}
                    <span className="ml-1 text-xs text-neutral-500">
                      ({r.pmDecimal.toFixed(2)})
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-neutral-400">
                    {formatProb(r.pinFairProb)}
                    <span className="ml-1 text-xs text-neutral-600">
                      ({r.pinFairDecimal.toFixed(2)})
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-400">
                    +{(r.edge * 100).toFixed(2)}%
                  </td>
                  <td className="px-4 py-3 text-right">
                    <a
                      href={r.polymarketUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-neutral-400 underline decoration-dotted hover:text-neutral-200"
                    >
                      open ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {snapshot && (
        <details className="mt-6 text-xs text-neutral-500">
          <summary className="cursor-pointer">Diagnostics</summary>
          <div className="mt-3 space-y-2 rounded-md border border-neutral-800 bg-neutral-900/30 p-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
              <span>polymarket scanned</span>
              <span>{snapshot.stats.polymarketScanned}</span>
              <span>polymarket (sports)</span>
              <span>{snapshot.stats.polymarketEvents}</span>
              <span>pinnacle events</span>
              <span>{snapshot.stats.pinnacleEvents}</span>
              <span>matched events</span>
              <span>{snapshot.stats.matchedEvents}</span>
              <span>compared sides</span>
              <span>{snapshot.stats.comparedSides}</span>
              <span>positive edges</span>
              <span>{snapshot.stats.positiveEdges}</span>
              <span>build time</span>
              <span>{snapshot.stats.buildMs}ms</span>
            </div>
            {snapshot.stats.sampleTags.length > 0 && (
              <div>
                <div className="mt-2 font-medium text-neutral-400">
                  sample tag slugs seen on Polymarket
                </div>
                <div className="mt-1 font-mono text-[10px] text-neutral-500">
                  {snapshot.stats.sampleTags.join(" · ")}
                </div>
              </div>
            )}
            {snapshot.stats.sampleTitles.length > 0 && (
              <div>
                <div className="mt-2 font-medium text-neutral-400">
                  sample sports event titles
                </div>
                <ul className="mt-1 list-disc pl-4 text-[11px] text-neutral-500">
                  {snapshot.stats.sampleTitles.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
            {snapshot.stats.errors.length > 0 && (
              <div>
                <div className="mt-2 font-medium text-amber-400">
                  {snapshot.stats.errors.length} warning(s) during last refresh
                </div>
                <ul className="mt-1 list-disc pl-4 font-mono text-[10px] text-amber-300/80">
                  {snapshot.stats.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            {diag && (
              <div className="mt-2 text-[11px] text-neutral-600">
                env: ODDS_API_KEY={diag.hasOddsApiKey ? "✓" : "✗"} · CRON_SECRET=
                {diag.hasCronSecret ? "✓" : "✗"} · vercel={diag.vercelEnv ?? "?"}{" "}
                · region={diag.region ?? "?"}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function formatProb(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}
