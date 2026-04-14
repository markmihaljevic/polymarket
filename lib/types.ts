// Shared type definitions for the odds-edge pipeline.

export type SportGroup = "Soccer" | "Tennis" | "American Football" | "Basketball" | "Ice Hockey";

/** The five sports the app tracks, with a stable UI label. */
export const TRACKED_SPORT_GROUPS: SportGroup[] = [
  "Soccer",
  "Tennis",
  "American Football",
  "Basketball",
  "Ice Hockey",
];

/** A normalized sports event from The Odds API (Pinnacle side). */
export interface PinnacleEvent {
  id: string;
  sportKey: string;
  sportGroup: SportGroup;
  commenceTime: string; // ISO
  homeTeam: string;
  awayTeam: string;
  /** h2h outcomes as decimal odds keyed by the outcome name as returned by the API.
   *  For soccer, a "Draw" key may also be present. */
  outcomes: Record<string, number>;
}

/** One side (outcome) of a Polymarket market that maps to a single bettable pick. */
export interface PolymarketSide {
  /** Human label shown in the UI ("Kansas City Chiefs", "Draw", "Over 220.5"). */
  label: string;
  /** 0..1 price to BUY this side right now (ask). This is what the user would pay. */
  price: number;
  /** Market slug on Polymarket — used to build a link. */
  marketSlug: string;
  /** The conditionId of the underlying market. */
  conditionId: string;
}

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  /** Event start — ISO. */
  startDate?: string;
  /** Tag slugs from Polymarket (e.g., ["sports", "nfl"]). */
  tagSlugs: string[];
  /** One entry per bettable side across all markets in the event. */
  sides: PolymarketSide[];
}

/** A +EV row shown on the page. */
export interface EdgeRow {
  sport: SportGroup;
  sportKey: string;
  commenceTime: string;
  eventTitle: string;
  side: string;
  pmPrice: number;      // 0..1
  pmDecimal: number;    // 1 / pmPrice
  pinFairProb: number;  // 0..1 (de-vigged)
  pinFairDecimal: number;
  edge: number;         // pinFairProb / pmPrice - 1
  polymarketUrl: string;
}

export interface Snapshot {
  updatedAt: string;   // ISO
  rows: EdgeRow[];
  /** Diagnostics for the debug panel / logs. */
  stats: {
    polymarketEvents: number;
    polymarketScanned: number;
    pinnacleEvents: number;
    matchedEvents: number;
    comparedSides: number;
    positiveEdges: number;
    sampleTags: string[];
    sampleTitles: string[];
    buildMs: number;
    errors: string[];
  };
}
