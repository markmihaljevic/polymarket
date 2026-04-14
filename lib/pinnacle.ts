// Pinnacle data source — accessed via The Odds API v4.
//
// Docs: https://the-odds-api.com/liveapi/guides/v4/
//
// We pull the full list of active sports, filter to the five groups we track,
// and for each sport fetch h2h (moneyline) odds restricted to the `pinnacle`
// bookmaker. The API is billed per request, so we only hit sports that are
// currently active.

import type { PinnacleEvent, SportGroup } from "./types";
import { TRACKED_SPORT_GROUPS } from "./types";

const BASE = "https://api.the-odds-api.com/v4";

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
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

function requireApiKey(): string {
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY is not set");
  return key;
}

/** Fetch /sports and return only the keys in our five tracked groups. */
export async function listTrackedSports(): Promise<
  { key: string; group: SportGroup }[]
> {
  const apiKey = requireApiKey();

  const override = (process.env.ODDS_API_SPORTS_OVERRIDE ?? "").trim();
  if (override) {
    return override
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .map((key) => ({ key, group: groupFromKey(key) }))
      .filter((s): s is { key: string; group: SportGroup } => s.group !== null);
  }

  const url = `${BASE}/sports?apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`odds-api /sports failed: ${res.status} ${await res.text()}`);
  }
  const data: OddsApiSport[] = await res.json();
  const tracked: { key: string; group: SportGroup }[] = [];
  for (const s of data) {
    if (!s.active) continue;
    if (s.has_outrights) continue; // outrights/futures don't pair with Polymarket h2h
    const g = normalizeGroup(s.group);
    if (g && (TRACKED_SPORT_GROUPS as string[]).includes(g)) {
      tracked.push({ key: s.key, group: g });
    }
  }
  return tracked;
}

/** Fetch h2h Pinnacle odds for a single sport key. */
export async function fetchPinnacleOdds(
  sportKey: string,
  group: SportGroup,
): Promise<PinnacleEvent[]> {
  const apiKey = requireApiKey();
  const url =
    `${BASE}/sports/${encodeURIComponent(sportKey)}/odds` +
    `?apiKey=${encodeURIComponent(apiKey)}` +
    `&regions=eu` +
    `&markets=h2h` +
    `&oddsFormat=decimal` +
    `&bookmakers=pinnacle`;

  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return []; // sport has no current events
  if (!res.ok) {
    throw new Error(
      `odds-api /odds[${sportKey}] failed: ${res.status} ${await res.text()}`,
    );
  }
  const events: OddsApiEvent[] = await res.json();
  const out: PinnacleEvent[] = [];
  for (const ev of events) {
    const pin = ev.bookmakers.find((b) => b.key === "pinnacle");
    if (!pin) continue;
    const h2h = pin.markets.find((m) => m.key === "h2h");
    if (!h2h || h2h.outcomes.length < 2) continue;

    const outcomes: Record<string, number> = {};
    for (const o of h2h.outcomes) {
      if (typeof o.price === "number" && Number.isFinite(o.price)) {
        outcomes[o.name] = o.price;
      }
    }
    if (Object.keys(outcomes).length < 2) continue;

    out.push({
      id: ev.id,
      sportKey: ev.sport_key,
      sportGroup: group,
      commenceTime: ev.commence_time,
      homeTeam: ev.home_team,
      awayTeam: ev.away_team,
      outcomes,
    });
  }
  return out;
}

/** Fetch lines across all tracked sports in parallel. */
export async function fetchAllPinnacleEvents(): Promise<{
  events: PinnacleEvent[];
  errors: string[];
}> {
  const errors: string[] = [];
  let sports: { key: string; group: SportGroup }[] = [];
  try {
    sports = await listTrackedSports();
  } catch (e) {
    errors.push(`listTrackedSports: ${(e as Error).message}`);
    return { events: [], errors };
  }

  const results = await Promise.allSettled(
    sports.map((s) => fetchPinnacleOdds(s.key, s.group)),
  );
  const events: PinnacleEvent[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      events.push(...r.value);
    } else {
      errors.push(`${sports[i].key}: ${r.reason?.message ?? r.reason}`);
    }
  });
  return { events, errors };
}

// --- helpers ---

function normalizeGroup(group: string): SportGroup | null {
  // The Odds API's `group` field for tennis is "Tennis", soccer is "Soccer",
  // etc. Normalize exact strings to our SportGroup union.
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
  if (key === "americanfootball_nfl") return "American Football";
  if (key === "basketball_nba") return "Basketball";
  if (key === "icehockey_nhl") return "Ice Hockey";
  return null;
}
