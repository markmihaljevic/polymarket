// Polymarket data source — Gamma Markets API.
//
// We page through active events and keep the ones that look like sports (by
// checking tags and, as a fallback, titles). Each event contains one or more
// markets; each market has outcomes and prices. We flatten everything into a
// list of `PolymarketSide` (one bettable pick) per event.
//
// The Gamma API returns `outcomes`/`outcomePrices`/`clobTokenIds` as
// stringified JSON arrays — we JSON.parse them defensively.

import type { PolymarketEvent, PolymarketSide } from "./types";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// Permissive substring matcher: if any of these tokens appears in an event's
// tag slug/label OR in its title, we count it as a sports event. Casting the
// net wide — over-inclusion here is harmless because the matching step later
// will only pair events that also have a Pinnacle line.
const SPORT_KEYWORDS: string[] = [
  "sport", // catches "sports" and "sports-games" umbrella tags
  // US leagues
  "nfl",
  "nba",
  "nhl",
  "mlb", // not tracked but doesn't hurt — filtered out downstream
  "mls",
  "wnba",
  // General labels
  "soccer",
  "football",
  "basketball",
  "hockey",
  "tennis",
  // Soccer competitions / leagues
  "premier league",
  "premier-league",
  "epl",
  "la liga",
  "la-liga",
  "laliga",
  "bundesliga",
  "serie a",
  "serie-a",
  "seriea",
  "ligue 1",
  "ligue-1",
  "ligue1",
  "champions league",
  "champions-league",
  "europa league",
  "europa-league",
  "world cup",
  "world-cup",
  "worldcup",
  "copa america",
  "copa-america",
  "euros",
  "euro 2024",
  "euro-2024",
  // Tennis tours
  "atp",
  "wta",
  "wimbledon",
  "roland garros",
  "us open",
  "australian open",
];

interface GammaTag {
  id?: string | number;
  label?: string;
  slug?: string;
}

interface GammaMarket {
  id?: string;
  conditionId?: string;
  question?: string;
  slug?: string;
  active?: boolean;
  closed?: boolean;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  bestAsk?: number | string;
  bestBid?: number | string;
  lastTradePrice?: number | string;
  volume?: number | string;
  liquidity?: number | string;
  gameStartTime?: string;
  endDate?: string;
}

interface GammaEvent {
  id?: string;
  slug?: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
  tags?: GammaTag[];
  markets?: GammaMarket[];
}

export interface PolymarketFetchResult {
  events: PolymarketEvent[];
  /** Diagnostics: everything that makes it past the sports filter. */
  stats: {
    totalScanned: number;
    sportsMatched: number;
    sampleTags: string[];
    sampleTitles: string[];
  };
}

/**
 * Fetch active events from Gamma, filtered to anything that looks like sports.
 */
export async function fetchPolymarketSportsEvents(): Promise<PolymarketFetchResult> {
  const events: PolymarketEvent[] = [];
  const sampleTagSet = new Set<string>();
  const sampleTitles: string[] = [];
  let totalScanned = 0;

  const pageSize = 200;
  const maxEvents = 1000;

  for (let offset = 0; offset < maxEvents; offset += pageSize) {
    const url =
      `${GAMMA_BASE}/events` +
      `?closed=false&active=true` +
      `&limit=${pageSize}&offset=${offset}` +
      `&order=volume&ascending=false`;

    const res = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json", "user-agent": "polymarket-edge/1.0" },
    });
    if (!res.ok) {
      throw new Error(
        `gamma /events failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }

    const page = (await res.json()) as GammaEvent[];
    if (!Array.isArray(page) || page.length === 0) break;
    totalScanned += page.length;

    for (const ev of page) {
      if (ev.closed === true) continue;

      // Collect tags for the debug panel regardless of whether we keep them.
      for (const t of ev.tags ?? []) {
        if (t.slug && sampleTagSet.size < 60) sampleTagSet.add(t.slug.toLowerCase());
      }

      if (!isSportsEvent(ev)) continue;
      const mapped = mapEvent(ev);
      if (!mapped) continue;

      events.push(mapped);
      if (sampleTitles.length < 15) sampleTitles.push(mapped.title);
    }

    if (page.length < pageSize) break;
  }

  return {
    events,
    stats: {
      totalScanned,
      sportsMatched: events.length,
      sampleTags: Array.from(sampleTagSet).slice(0, 40),
      sampleTitles,
    },
  };
}

function isSportsEvent(ev: GammaEvent): boolean {
  // Tag-based check (primary).
  for (const t of ev.tags ?? []) {
    const haystack = `${t.slug ?? ""} ${t.label ?? ""}`.toLowerCase();
    for (const kw of SPORT_KEYWORDS) {
      if (haystack.includes(kw)) return true;
    }
  }
  // Fallback: title heuristics for events that came through without the tag
  // we'd expect.
  const title = (ev.title ?? "").toLowerCase();
  for (const kw of SPORT_KEYWORDS) {
    if (title.includes(kw)) return true;
  }
  return false;
}

function mapEvent(ev: GammaEvent): PolymarketEvent | null {
  if (!ev.id || !ev.slug || !ev.title) return null;

  const tagSlugs: string[] = [];
  for (const t of ev.tags ?? []) {
    if (t.slug) tagSlugs.push(t.slug.toLowerCase());
  }

  const sides: PolymarketSide[] = [];
  for (const m of ev.markets ?? []) {
    if (m.closed === true || m.active === false) continue;
    if (!m.conditionId || !m.slug) continue;
    const outcomes = parseStringOrArray(m.outcomes);
    const prices = parseStringOrArray(m.outcomePrices);
    if (!outcomes || !prices || outcomes.length !== prices.length) continue;

    for (let i = 0; i < outcomes.length; i++) {
      const label = outcomes[i];
      const priceNum = Number(prices[i]);
      if (!Number.isFinite(priceNum) || priceNum <= 0 || priceNum >= 1) continue;

      // For YES/NO markets we want the YES side only — the NO side is just
      // (1 - yes) and its "team" is the opponent, which we'd re-derive in
      // matching. Keeping both doubles our row count with no added info.
      if (
        outcomes.length === 2 &&
        label.toLowerCase() === "no" &&
        outcomes.some((o) => o.toLowerCase() === "yes")
      ) {
        continue;
      }

      const isBinaryYes =
        outcomes.length === 2 &&
        label.toLowerCase() === "yes" &&
        outcomes.some((o) => o.toLowerCase() === "no");
      const labelForMatch = isBinaryYes && m.question ? `@Q:${m.question}` : label;

      sides.push({
        label: labelForMatch,
        price: priceNum,
        marketSlug: m.slug,
        conditionId: m.conditionId,
      });
    }
  }

  if (sides.length === 0) return null;

  return {
    id: ev.id,
    slug: ev.slug,
    title: ev.title,
    startDate: ev.startDate,
    tagSlugs,
    sides,
  };
}

function parseStringOrArray(v: string | string[] | undefined): string[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(String);
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map(String);
    return null;
  } catch {
    return null;
  }
}

/** Build a user-facing link to the Polymarket event page. */
export function polymarketUrl(eventSlug: string, _marketSlug: string): string {
  return `https://polymarket.com/event/${eventSlug}`;
}
