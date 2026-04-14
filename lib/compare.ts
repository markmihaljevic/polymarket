// Orchestrator: fetch both sides, match, de-vig, compute edges, return a snapshot.

import { devigMultiplicative } from "./devig";
import { matchEvents, matchSides } from "./match";
import { fetchAllPinnacleEvents } from "./pinnacle";
import { fetchPolymarketSportsEvents, polymarketUrl } from "./polymarket";
import type { EdgeRow, Snapshot } from "./types";

export async function buildSnapshot(): Promise<Snapshot> {
  const errors: string[] = [];
  const startedAt = Date.now();

  // Fire both sources in parallel — they're independent.
  const [pmResult, pinResult] = await Promise.allSettled([
    fetchPolymarketSportsEvents(),
    fetchAllPinnacleEvents(),
  ]);

  const pmEvents = pmResult.status === "fulfilled" ? pmResult.value : [];
  if (pmResult.status === "rejected") {
    errors.push(`polymarket: ${(pmResult.reason as Error)?.message ?? pmResult.reason}`);
  }

  const pinEvents = pinResult.status === "fulfilled" ? pinResult.value.events : [];
  if (pinResult.status === "fulfilled") errors.push(...pinResult.value.errors);
  if (pinResult.status === "rejected") {
    errors.push(`pinnacle: ${(pinResult.reason as Error)?.message ?? pinResult.reason}`);
  }

  const matches = matchEvents(pmEvents, pinEvents);

  const rows: EdgeRow[] = [];
  let comparedSides = 0;

  for (const match of matches) {
    const devig = devigMultiplicative(match.pin.outcomes);
    if (!devig) continue;

    const sideMatches = matchSides(match);
    for (const sm of sideMatches) {
      comparedSides++;
      const pmPrice = sm.pmSide.price;
      const pinFair = devig.fair[sm.pinOutcomeKey];
      if (!Number.isFinite(pmPrice) || !Number.isFinite(pinFair)) continue;
      if (pmPrice <= 0 || pmPrice >= 1 || pinFair <= 0 || pinFair >= 1) continue;

      // We only care about rows where Polymarket's price is BELOW Pinnacle's
      // de-vigged fair probability — i.e., you're buying for less than fair.
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
      });
    }
  }

  rows.sort((a, b) => b.edge - a.edge);

  const elapsed = Date.now() - startedAt;
  console.log(
    `[compare] pm=${pmEvents.length} pin=${pinEvents.length} matched=${matches.length} compared=${comparedSides} +ev=${rows.length} in ${elapsed}ms`,
  );
  if (errors.length) console.warn("[compare] errors:", errors);

  return {
    updatedAt: new Date().toISOString(),
    rows,
    stats: {
      polymarketEvents: pmEvents.length,
      pinnacleEvents: pinEvents.length,
      matchedEvents: matches.length,
      comparedSides,
      positiveEdges: rows.length,
      errors,
    },
  };
}
