// Event and side matching between Polymarket and Pinnacle.
//
// The problem: Polymarket event titles, market questions and outcome labels
// are free-form prose; Pinnacle (via The Odds API) gives us clean
// (home_team, away_team, commence_time) tuples. We need to pair them up so
// we can compare a Polymarket price to a Pinnacle fair price for the same
// underlying pick.
//
// Strategy:
//   1. For each PinnacleEvent, find PolymarketEvents whose title (or any side
//      label / question) mentions BOTH home and away teams and whose start
//      time is within ±6h.
//   2. For each Polymarket side in that event, figure out which Pinnacle
//      outcome it corresponds to:
//         - If the side is a @Q:-prefixed YES/NO, use teams.extractYesSide.
//         - Otherwise, score the label against each Pinnacle outcome name
//           and pick the best if the similarity is clearly high.

import type { PinnacleEvent, PolymarketEvent, PolymarketSide } from "./types";
import { extractYesSide, nameSimilarity, tokenSet } from "./teams";

const TIME_WINDOW_MS = 6 * 60 * 60 * 1000; // ±6h

export interface EventMatch {
  pm: PolymarketEvent;
  pin: PinnacleEvent;
}

export interface SideMatch {
  pmSide: PolymarketSide;
  /** The exact key into PinnacleEvent.outcomes that this side maps to. */
  pinOutcomeKey: string;
  /** The clean label to show in the UI. */
  displayLabel: string;
}

export function matchEvents(
  pmEvents: PolymarketEvent[],
  pinEvents: PinnacleEvent[],
): EventMatch[] {
  const matches: EventMatch[] = [];
  for (const pin of pinEvents) {
    const pinTime = Date.parse(pin.commenceTime);
    if (!Number.isFinite(pinTime)) continue;

    let best: { pm: PolymarketEvent; score: number } | null = null;
    for (const pm of pmEvents) {
      if (!eventTimeClose(pm.startDate, pinTime)) continue;
      const score = scoreEventPair(pm, pin);
      if (score < 0.6) continue;
      if (!best || score > best.score) best = { pm, score };
    }
    if (best) matches.push({ pm: best.pm, pin });
  }
  return dedupe(matches);
}

function dedupe(matches: EventMatch[]): EventMatch[] {
  // If two Pinnacle events matched the same Polymarket event, keep only the
  // one with a closer start time — otherwise we'd double-count rows.
  const byPmId = new Map<string, EventMatch>();
  for (const m of matches) {
    const existing = byPmId.get(m.pm.id);
    if (!existing) {
      byPmId.set(m.pm.id, m);
      continue;
    }
    const pmT = Date.parse(m.pm.startDate ?? "") || 0;
    const existingDelta = Math.abs(pmT - Date.parse(existing.pin.commenceTime));
    const newDelta = Math.abs(pmT - Date.parse(m.pin.commenceTime));
    if (newDelta < existingDelta) byPmId.set(m.pm.id, m);
  }
  return Array.from(byPmId.values());
}

function eventTimeClose(pmStart: string | undefined, pinTime: number): boolean {
  if (!pmStart) return true; // no start on PM side -> skip the time filter
  const pmT = Date.parse(pmStart);
  if (!Number.isFinite(pmT)) return true;
  return Math.abs(pmT - pinTime) <= TIME_WINDOW_MS;
}

/**
 * Score a (pm event, pinnacle event) pair from 0..1 based on whether both
 * team names appear anywhere in the Polymarket event's title or in its
 * market questions / outcome labels.
 */
function scoreEventPair(pm: PolymarketEvent, pin: PinnacleEvent): number {
  const haystack = [
    pm.title,
    ...pm.sides.map((s) => (s.label.startsWith("@Q:") ? s.label.slice(3) : s.label)),
  ].join(" \n ");

  const homeScore = nameSimilarity(haystack, pin.homeTeam);
  const awayScore = nameSimilarity(haystack, pin.awayTeam);
  if (homeScore < 0.5 || awayScore < 0.5) return 0;

  // Both teams mentioned — blend: require both strong, reward strength.
  return Math.min(homeScore, awayScore) * 0.7 + ((homeScore + awayScore) / 2) * 0.3;
}

/**
 * For a matched event, resolve each Polymarket side to a Pinnacle outcome key.
 * Sides we can't confidently resolve are dropped.
 */
export function matchSides(match: EventMatch): SideMatch[] {
  const { pm, pin } = match;
  const out: SideMatch[] = [];
  const pinKeys = Object.keys(pin.outcomes);

  for (const side of pm.sides) {
    if (side.label.startsWith("@Q:")) {
      const question = side.label.slice(3);
      const team = extractYesSide(question, pin.homeTeam, pin.awayTeam);
      if (!team) continue;
      const key = bestOutcomeKey(pinKeys, team);
      if (!key) continue;
      out.push({ pmSide: side, pinOutcomeKey: key, displayLabel: team });
      continue;
    }

    // Multi-outcome market: the label itself is the team (or "Draw").
    const key = bestOutcomeKey(pinKeys, side.label);
    if (!key) continue;
    out.push({ pmSide: side, pinOutcomeKey: key, displayLabel: pin.outcomes[key] ? key : side.label });
  }

  return out;
}

function bestOutcomeKey(keys: string[], target: string): string | null {
  if (keys.length === 0) return null;

  // "Draw" is a special case in soccer.
  const normalized = target.toLowerCase().trim();
  if (normalized === "draw" || normalized === "tie") {
    const draw = keys.find((k) => k.toLowerCase() === "draw");
    return draw ?? null;
  }

  let best: { key: string; score: number } | null = null;
  for (const k of keys) {
    // Never match "Draw" against a team.
    if (k.toLowerCase() === "draw") continue;
    const score = nameSimilarity(k, target);
    if (score < 0.5) continue;
    if (!best || score > best.score) best = { key: k, score };
  }
  return best?.key ?? null;
}

// Export for tests / debugging
export const __test = { scoreEventPair, bestOutcomeKey, tokenSet };
