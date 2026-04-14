// Polymarket data source — Gamma Markets API.
//
// We call the /events endpoint and filter events whose tag slugs match one of
// the five tracked sports. Each event contains one or more markets; each
// market has a set of outcomes and prices. We flatten everything into a list
// of `PolymarketSide` (one bettable pick) per event.
//
// The Gamma API returns outcomes/outcomePrices/clobTokenIds as stringified
// JSON — we JSON.parse them defensively.

import type { PolymarketEvent, PolymarketSide } from "./types";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// Polymarket tag slugs that correspond to our tracked sports. We keep this
// deliberately broad because different leagues get their own slugs and the
// set changes over time; anything we miss will just be absent until added.
export const POLYMARKET_SPORT_TAG_SLUGS = new Set<string>([
  "sports",
  // NFL
  "nfl",
  // NBA
  "nba",
  // NHL
  "nhl",
  // Tennis (Polymarket doesn't always split by tour)
  "tennis",
  "atp",
  "wta",
  // Soccer — parent + biggest leagues / competitions
  "soccer",
  "epl",
  "premier-league",
  "la-liga",
  "laliga",
  "serie-a",
  "bundesliga",
  "ligue-1",
  "ligue1",
  "champions-league",
  "uefa-champions-league",
  "europa-league",
  "world-cup",
  "euros",
  "euro-2024",
  "copa-america",
  "mls",
]);

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

/**
 * Fetch a page of sports-tagged events from Gamma. We go for the broadest
 * filter (closed=false, active=true, a generous limit) and then filter by tag
 * client-side so we don't miss anything due to tag filter quirks.
 */
export async function fetchPolymarketSportsEvents(): Promise<PolymarketEvent[]> {
  const events: PolymarketEvent[] = [];
  const pageSize = 200;
  // Pull up to 600 events. Polymarket sports volume rarely exceeds this at once.
  for (let offset = 0; offset < 600; offset += pageSize) {
    const url =
      `${GAMMA_BASE}/events` +
      `?closed=false&active=true` +
      `&limit=${pageSize}&offset=${offset}` +
      `&order=volume&ascending=false`;

    const res = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`gamma /events failed: ${res.status} ${await res.text()}`);
    }
    const page = (await res.json()) as GammaEvent[];
    if (!Array.isArray(page) || page.length === 0) break;

    for (const ev of page) {
      const mapped = mapEvent(ev);
      if (mapped && isSportsTagged(mapped.tagSlugs)) events.push(mapped);
    }
    if (page.length < pageSize) break;
  }
  return events;
}

function isSportsTagged(tagSlugs: string[]): boolean {
  for (const t of tagSlugs) {
    if (POLYMARKET_SPORT_TAG_SLUGS.has(t)) return true;
  }
  return false;
}

function mapEvent(ev: GammaEvent): PolymarketEvent | null {
  if (!ev.id || !ev.slug || !ev.title) return null;
  if (ev.closed === true) return null;

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

      // For YES/NO markets, the label to match against Pinnacle is not
      // literally "Yes" — it's the team the market is asking about. We encode
      // the question into the label so lib/match.ts can extract it.
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

/** Build a user-facing link to the Polymarket market. */
export function polymarketUrl(eventSlug: string, marketSlug: string): string {
  // Polymarket's canonical URL is /event/<event-slug>. The market slug is
  // present as a section/anchor within the event page.
  return `https://polymarket.com/event/${eventSlug}`;
}
