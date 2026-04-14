// Orchestrator: fetch both sources, match events, de-vig, compute edges.

import { devigMultiplicative } from "./devig";
import {
  matchEvents,
  matchOutrightSides,
  matchOutrights,
  matchSides,
} from "./match";
import { fetchAllPinnacleEvents } from "./pinnacle";
import { fetchPolymarketSportsEvents, polymarketUrl } from "./polymarket";
import type { EdgeRow, PinnacleEvent, Snapshot } from "./types";

export async function buildSnapshot(): Promise<Snapshot> {
  const errors: string[] = [];
  const startedAt = Date.now();

  // Fire both sources in parallel — they're independent.
  const [pmResult, pinResult] = await Promise.allSettled([
    fetchPolymarketSportsEvents(),
    fetchAllPinnacleEvents(),
  ]);

  const pmFetch = pmResult.status === "fulfilled" ? pmResult.value : null;
  const pmEvents = pmFetch?.events ?? [];
  if (pmResult.status === "rejected") {
    errors.push(`polymarket: ${(pmResult.reason as Error)?.message ?? pmResult.reason}`);
  }

  let pinEvents: PinnacleEvent[] = [];
  let pinSportsFetched = 0;
  if (pinResult.status === "fulfilled") {
    pinEvents = pinResult.value.events;
    pinSportsFetched = pinResult.value.sportsFetched;
    errors.push(...pinResult.value.errors);
  } else {
    errors.push(`pinnacle: ${(pinResult.reason as Error)?.message ?? pinResult.reason}`);
  }

  // Two passes: game-level h2h matches and tournament-level outright matches.
  const h2hMatches = matchEvents(pmEvents, pinEvents);
  const outrightMatches = matchOutrights(pmEvents, pinEvents);

  const pinH2hCount = pinEvents.filter((e) => !e.isOutright).length;
  const pinOutrightCount = pinEvents.filter((e) => e.isOutright).length;

  const rows: EdgeRow[] = [];
  let comparedSides = 0;

  const runMatches = (
    matches: typeof h2hMatches,
    kind: "h2h" | "outright",
  ): void => {
    for (const match of matches) {
      const devig = devigMultiplicative(match.pin.outcomes);
      if (!devig) continue;

      const sideMatches =
        kind === "outright" ? matchOutrightSides(match) : matchSides(match);

      for (const sm of sideMatches) {
        comparedSides++;
        const pmPrice = sm.pmSide.price;
        const pinFair = devig.fair[sm.pinOutcomeKey];
        if (!Number.isFinite(pmPrice) || !Number.isFinite(pinFair)) continue;
        if (pmPrice <= 0 || pmPrice >= 1 || pinFair <= 0 || pinFair >= 1) continue;

        // Only rows where Polymarket's price is BELOW Pinnacle's de-vigged
        // fair probability — i.e., you're paying less than fair.
        if (pmPrice >= pinFair) continue;

        const edge = pinFair / pmPrice - 1;

        rows.push({
          sport: match.pin.sportGroup,
          sportKey: match.pin.sportKey,
          commenceTime: match.pin.commenceTime,
          eventTitle: match.pm.title,
          side: sm.displayLabel,
          pmPrice,
          pmDecimal: 1 / pmPrice,
          pinFairProb: pinFair,
          pinFairDecimal: 1 / pinFair,
          edge,
          polymarketUrl: polymarketUrl(match.pm.slug, sm.pmSide.marketSlug),
          kind,
        });
      }
    }
  };

  runMatches(h2hMatches, "h2h");
  runMatches(outrightMatches, "outright");

  rows.sort((a, b) => b.edge - a.edge);

  const buildMs = Date.now() - startedAt;
  console.log(
    `[compare] pm=${pmEvents.length}(scanned=${pmFetch?.stats.totalScanned ?? 0}) ` +
      `pin=h2h:${pinH2hCount}+out:${pinOutrightCount} ` +
      `matches=h2h:${h2hMatches.length}+out:${outrightMatches.length} ` +
      `compared=${comparedSides} +ev=${rows.length} in ${buildMs}ms`,
  );
  if (errors.length) console.warn("[compare] errors:", errors);

  return {
    updatedAt: new Date().toISOString(),
    rows,
    stats: {
      polymarketEvents: pmEvents.length,
      polymarketScanned: pmFetch?.stats.totalScanned ?? 0,
      pinnacleH2hEvents: pinH2hCount,
      pinnacleOutrightEvents: pinOutrightCount,
      pinnacleSportsFetched: pinSportsFetched,
      h2hMatches: h2hMatches.length,
      outrightMatches: outrightMatches.length,
      matchedEvents: h2hMatches.length + outrightMatches.length,
      comparedSides,
      positiveEdges: rows.length,
      sampleTags: pmFetch?.stats.sampleTags ?? [],
      sampleTitles: pmFetch?.stats.sampleTitles ?? [],
      buildMs,
      errors,
    },
  };
}
