// Pinnacle data source — accessed via The Odds API v4.
//
// Docs: https://the-odds-api.com/liveapi/guides/v4/
//
// Two important details:
//
// 1. The Odds API exposes *game-level* h2h and *tournament-level* outright
//    (futures) markets under different sport keys. Some sports have only
//    outrights (`has_outrights: true`), some only h2h, some both (as
//    separate keys). We fetch both flavors from the leagues we care about.
//
// 2. Request throttling. Firing all active sports in parallel trips the
//    API's per-second rate limit and returns 429 for most of them. We use a
//    bounded worker pool (concurrency 3) plus exponential-backoff retries
//    to stay well under their throttle.
//
// We also restrict to a hand-curated list of "major" sport roots. The Odds
// API returns ~80+ active sport keys; most of them (Danish Superliga,
// Chilean Primera, Swedish Allsvenskan, etc.) aren't on Polymarket anyway,
// so fetching them just wastes quota and rate-limit headroom.

import type { PinnacleEvent, SportGroup } from "./types";
import { TRACKED_SPORT_GROUPS } from "./types";

const BASE = "https://api.the-odds-api.com/v4";

/** Sport-key roots we care about. A key matches if it equals a root OR starts
 *  with `<root>_` (to catch associated outright sport keys like
 *  `soccer_epl_winner`, `basketball_nba_championship_winner`). */
const MAJOR_SPORT_ROOTS = [
  "americanfootball_nfl",
  "basketball_nba",
  "icehockey_nhl",
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_france_ligue_one",
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
  "soccer_usa_mls",
  "soccer_fa_cup",
  "soccer_fifa_world_cup",
  "soccer_uefa_european_championship",
  "soccer_conmebol_copa_america",
  "tennis_atp",
  "tennis_wta",
];

function isMajorSport(key: string): boolean {
  return MAJOR_SPORT_ROOTS.some(
    (root) => key === root || key.startsWith(root + "_"),
  );
}

// ---- Odds API response shapes ----

interface OddsApiSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
}

interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}

interface OddsApiMarket {
  key: string;
  last_update: string;
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsApiMarket[];
}

interface OddsApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string | null;
  away_team: string | null;
  bookmakers: OddsApiBookmaker[];
}

// ---- Public API ----

function requireApiKey(): string {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY is not set");
  return key;
}

interface TrackedSport {
  key: string;
  group: SportGroup;
  isOutright: boolean;
}

export async function listTrackedSports(): Promise<TrackedSport[]> {
  const apiKey = requireApiKey();

  const override = (process.env.ODDS_API_SPORTS_OVERRIDE ?? "").trim();
  if (override) {
    return override
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .map((key): TrackedSport | null => {
        const group = groupFromKey(key);
        if (!group) return null;
        return { key, group, isOutright: /_winner$/.test(key) };
      })
      .filter((s): s is TrackedSport => s !== null);
  }

  const res = await fetchWithRetry(
    `${BASE}/sports?apiKey=${encodeURIComponent(apiKey)}&all=true`,
  );
  if (!res.ok) {
    throw new Error(`odds-api /sports failed: ${res.status} ${await res.text()}`);
  }
  const data: OddsApiSport[] = await res.json();
  const tracked: TrackedSport[] = [];
  for (const s of data) {
    if (!s.active) continue;
    if (!isMajorSport(s.key)) continue;
    const g = normalizeGroup(s.group);
    if (!g || !(TRACKED_SPORT_GROUPS as string[]).includes(g)) continue;
    tracked.push({ key: s.key, group: g, isOutright: Boolean(s.has_outrights) });
  }
  return tracked;
}

/** Fetch Pinnacle odds (h2h or outrights) for a single sport key. */
export async function fetchPinnacleOdds(
  sportKey: string,
  group: SportGroup,
  isOutright: boolean,
): Promise<PinnacleEvent[]> {
  const apiKey = requireApiKey();
  const marketsParam = isOutright ? "outrights" : "h2h";
  const url =
    `${BASE}/sports/${encodeURIComponent(sportKey)}/odds` +
    `?apiKey=${encodeURIComponent(apiKey)}` +
    `&regions=eu` +
    `&markets=${marketsParam}` +
    `&oddsFormat=decimal` +
    `&bookmakers=pinnacle`;

  const res = await fetchWithRetry(url);
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(
      `odds-api /odds[${sportKey}] failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const events: OddsApiEvent[] = await res.json();
  const out: PinnacleEvent[] = [];

  for (const ev of events) {
    const pin = ev.bookmakers.find((b) => b.key === "pinnacle");
    if (!pin) continue;
    // For outrights the market key in the response is "outrights"; for h2h, "h2h".
    const market = pin.markets.find(
      (m) => m.key === marketsParam || m.key === "h2h" || m.key === "outrights",
    );
    if (!market || market.outcomes.length < 2) continue;

    const outcomes: Record<string, number> = {};
    for (const o of market.outcomes) {
      if (typeof o.price === "number" && Number.isFinite(o.price) && o.price > 1) {
        outcomes[o.name] = o.price;
      }
    }
    if (Object.keys(outcomes).length < 2) continue;

    if (isOutright) {
      out.push({
        id: ev.id,
        sportKey: ev.sport_key,
        sportGroup: group,
        commenceTime: ev.commence_time,
        homeTeam: "",
        awayTeam: "",
        outcomes,
        isOutright: true,
        tournamentName: ev.sport_title || sportKey,
      });
    } else {
      out.push({
        id: ev.id,
        sportKey: ev.sport_key,
        sportGroup: group,
        commenceTime: ev.commence_time,
        homeTeam: ev.home_team ?? "",
        awayTeam: ev.away_team ?? "",
        outcomes,
      });
    }
  }
  return out;
}

export async function fetchAllPinnacleEvents(): Promise<{
  events: PinnacleEvent[];
  errors: string[];
  sportsFetched: number;
}> {
  const errors: string[] = [];
  let sports: TrackedSport[] = [];
  try {
    sports = await listTrackedSports();
  } catch (e) {
    errors.push(`listTrackedSports: ${(e as Error).message}`);
    return { events: [], errors, sportsFetched: 0 };
  }

  // Bounded concurrency (3 workers) + 429 retries. Keeps us safely under
  // the Odds API per-second throttle regardless of how many sports are active.
  const results = await mapWithConcurrency(sports, 3, (s) =>
    fetchPinnacleOdds(s.key, s.group, s.isOutright),
  );

  const events: PinnacleEvent[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      events.push(...r.value);
    } else {
      errors.push(`${sports[i].key}: ${(r.reason as Error)?.message ?? r.reason}`);
    }
  });
  return { events, errors, sportsFetched: sports.length };
}

// ---- internals ----

/**
 * Fetch with exponential backoff on 429. Waits 500ms, 1s, 2s, 4s between
 * retries — max total wait ~7.5s before giving up.
 */
async function fetchWithRetry(url: string, maxAttempts = 4): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status !== 429) return res;
    lastRes = res;
    const waitMs = 500 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  // Return the last 429 response so the caller can surface the error text.
  return lastRes ?? fetch(url, { cache: "no-store" });
}

/** Bounded worker pool. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = { status: "fulfilled", value: await fn(items[idx]) };
      } catch (e) {
        results[idx] = { status: "rejected", reason: e };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

function normalizeGroup(group: string): SportGroup | null {
  const g = group.trim();
  if (g === "Soccer") return "Soccer";
  if (g === "Tennis") return "Tennis";
  if (g === "American Football") return "American Football";
  if (g === "Basketball") return "Basketball";
  if (g === "Ice Hockey") return "Ice Hockey";
  return null;
}

function groupFromKey(key: string): SportGroup | null {
  if (key.startsWith("soccer_")) return "Soccer";
  if (key.startsWith("tennis_")) return "Tennis";
  if (key.startsWith("americanfootball_")) return "American Football";
  if (key.startsWith("basketball_")) return "Basketball";
  if (key.startsWith("icehockey_")) return "Ice Hockey";
  return null;
}
