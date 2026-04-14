// Event and side matching between Polymarket and Pinnacle.
//
// Two distinct flavors:
//
// - **h2h matching**: Pinnacle gives us (home, away, commence_time). We find
//   a Polymarket event whose title / market questions mention BOTH teams
//   and whose start time is within ±6h. Each Polymarket side is then
//   resolved to one of Pinnacle's outcome keys.
//
// - **outright matching**: Pinnacle gives us a season/tournament outright
//   with N entrants. We find a Polymarket event that looks like a futures
//   market (title contains "Winner", "Champion", "MVP", etc.) and whose
//   name fuzzy-matches the Pinnacle tournament name. Each Polymarket side
//   is resolved to one of the outright outcomes.

import type { PinnacleEvent, PolymarketEvent, PolymarketSide } from "./types";
import { extractYesSide, nameSimilarity } from "./teams";

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

// ==========================================================================
// h2h matching
// ==========================================================================

export function matchEvents(
  pmEvents: PolymarketEvent[],
  pinEvents: PinnacleEvent[],
): EventMatch[] {
  const matches: EventMatch[] = [];
  for (const pin of pinEvents) {
    if (pin.isOutright) continue;
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
  // If two Pinnacle events matched the same Polymarket event, keep the one
  // with a closer start time.
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

function scoreEventPair(pm: PolymarketEvent, pin: PinnacleEvent): number {
  const haystack = [
    pm.title,
    ...pm.sides.map((s) => (s.label.startsWith("@Q:") ? s.label.slice(3) : s.label)),
  ].join(" \n ");

  const homeScore = nameSimilarity(haystack, pin.homeTeam);
  const awayScore = nameSimilarity(haystack, pin.awayTeam);
  if (homeScore < 0.5 || awayScore < 0.5) return 0;

  return Math.min(homeScore, awayScore) * 0.7 + ((homeScore + awayScore) / 2) * 0.3;
}

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

    const key = bestOutcomeKey(pinKeys, side.label);
    if (!key) continue;
    out.push({ pmSide: side, pinOutcomeKey: key, displayLabel: key });
  }

  return out;
}

function bestOutcomeKey(keys: string[], target: string): string | null {
  if (keys.length === 0) return null;

  const normalized = target.toLowerCase().trim();
  if (normalized === "draw" || normalized === "tie") {
    const draw = keys.find((k) => k.toLowerCase() === "draw");
    return draw ?? null;
  }

  let best: { key: string; score: number } | null = null;
  for (const k of keys) {
    if (k.toLowerCase() === "draw") continue;
    const score = nameSimilarity(k, target);
    if (score < 0.5) continue;
    if (!best || score > best.score) best = { key: k, score };
  }
  return best?.key ?? null;
}

// ==========================================================================
// Outright matching
// ==========================================================================

// Matches titles like "2026 NBA Champion", "English Premier League Winner",
// "NBA MVP", "Stanley Cup Winner", "World Series Champion 2026", etc.
const OUTRIGHT_TITLE_RE = /\b(winner|champion|champs|finals?|title|mvp|trophy)\b/i;

export function matchOutrights(
  pmEvents: PolymarketEvent[],
  pinEvents: PinnacleEvent[],
): EventMatch[] {
  const outrights = pinEvents.filter((e) => e.isOutright);
  if (outrights.length === 0) return [];

  const matches: EventMatch[] = [];
  const seenPmIds = new Set<string>();

  for (const pm of pmEvents) {
    if (seenPmIds.has(pm.id)) continue;
    if (!OUTRIGHT_TITLE_RE.test(pm.title)) continue;

    let best: { pin: PinnacleEvent; score: number } | null = null;
    for (const pin of outrights) {
      const tournament = pin.tournamentName || pin.sportKey;
      // Symmetric name similarity: both directions matter because PM titles
      // are typically longer ("2026 NBA Champion") than Pinnacle's
      // ("NBA Championship Winner").
      const s1 = nameSimilarity(pm.title, tournament);
      const s2 = nameSimilarity(tournament, pm.title);
      const score = Math.max(s1, s2);
      if (score < 0.5) continue;
      if (!best || score > best.score) best = { pin, score };
    }
    if (best) {
      matches.push({ pm, pin: best.pin });
      seenPmIds.add(pm.id);
    }
  }
  return matches;
}

/** For a matched outright pair, resolve each PM side to one Pinnacle outcome. */
export function matchOutrightSides(match: EventMatch): SideMatch[] {
  const { pm, pin } = match;
  const out: SideMatch[] = [];
  const pinKeys = Object.keys(pin.outcomes);

  for (const side of pm.sides) {
    const searchText = side.label.startsWith("@Q:")
      ? side.label.slice(3)
      : side.label;

    let best: { key: string; score: number } | null = null;
    for (const key of pinKeys) {
      const score = nameSimilarity(searchText, key);
      if (score < 0.6) continue; // tighter threshold — outrights have many lookalike names
      if (!best || score > best.score) best = { key, score };
    }
    if (!best) continue;
    out.push({ pmSide: side, pinOutcomeKey: best.key, displayLabel: best.key });
  }
  return out;
}
