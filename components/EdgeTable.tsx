"use client";

import { useEffect, useMemo, useState } from "react";
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

export function EdgeTable() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minEdge, setMinEdge] = useState<number>(MIN_EDGE_DEFAULT);
  const [enabledSports, setEnabledSports] = useState<Set<SportGroup>>(
    () => new Set(TRACKED_SPORT_GROUPS),
  );

  // Poll the snapshot every 30s so the page stays current without a reload.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/snapshot", { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (json.ok) {
          setSnapshot(json.snapshot);
          setError(null);
        } else {
          setError(json.error ?? "failed to load snapshot");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Polymarket vs Pinnacle
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            Markets where Polymarket is paying more than Pinnacle&apos;s de-vigged
            fair price.
          </p>
        </div>
        <div className="text-right text-xs text-neutral-500">
          {snapshot && (
            <>
              Updated{" "}
              <time dateTime={snapshot.updatedAt}>
                {new Date(snapshot.updatedAt).toLocaleTimeString()}
              </time>
              <br />
              {snapshot.stats.polymarketEvents} PM ·{" "}
              {snapshot.stats.pinnacleEvents} Pinnacle ·{" "}
              {snapshot.stats.matchedEvents} matched
            </>
          )}
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
          {error}
        </div>
      )}

      {!snapshot && !error && (
        <div className="py-20 text-center text-sm text-neutral-500">
          Loading latest snapshot…
        </div>
      )}

      {snapshot && visibleRows.length === 0 && (
        <div className="py-20 text-center text-sm text-neutral-500">
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

      {snapshot?.stats.errors && snapshot.stats.errors.length > 0 && (
        <details className="mt-6 text-xs text-neutral-500">
          <summary className="cursor-pointer">
            {snapshot.stats.errors.length} warning(s) during last refresh
          </summary>
          <ul className="mt-2 space-y-1">
            {snapshot.stats.errors.map((e, i) => (
              <li key={i} className="font-mono">
                {e}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function formatProb(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}
