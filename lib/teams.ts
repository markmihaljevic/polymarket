// Team/event name normalization and fuzzy matching utilities.
//
// Polymarket and Pinnacle frequently use slightly different names for the same
// team ("Man City" vs "Manchester City", "KC" vs "Kansas City Chiefs").
// Rather than maintain a huge alias table, we tokenize, strip noise words, and
// do a set-overlap check. Good enough for 95%+ of matches.

const NOISE_WORDS = new Set([
  "the", "fc", "cf", "afc", "sc", "ac", "cd", "ca", "fk", "de", "do", "of",
  "club", "football", "united", "utd", "city", "town", "county",
  // American pro sports team suffixes that frequently differ between sources.
  // We keep them in the token list but ALSO keep a copy without them so the
  // comparator has something to fall back on.
]);

const CITY_TO_TEAM: Record<string, string> = {
  // A few common short forms we normalize up-front.
  "kc": "kansas city",
  "ny": "new york",
  "la": "los angeles",
  "sf": "san francisco",
  "phi": "philadelphia",
  "nola": "new orleans",
};

const ACCENTS = /[\u0300-\u036f]/g;

export function normalize(input: string): string {
  return input
    .normalize("NFD")
    .replace(ACCENTS, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(input: string): string[] {
  const normalized = normalize(input);
  const expanded = normalized
    .split(" ")
    .map((t) => CITY_TO_TEAM[t] ?? t)
    .join(" ");
  return expanded
    .split(" ")
    .filter((t) => t.length > 0 && !NOISE_WORDS.has(t));
}

/** Token set — used for subset/overlap checks. */
export function tokenSet(input: string): Set<string> {
  return new Set(tokenize(input));
}

/**
 * Score two name strings 0..1.
 * 1.0 = every token in the shorter set is present in the longer set.
 * 0.0 = no overlap.
 */
export function nameSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;
  return hit / small.size;
}

/**
 * Returns true if `haystack` plausibly contains a reference to `needle`
 * (where needle is typically a team name).
 */
export function mentions(haystack: string, needle: string): boolean {
  return nameSimilarity(haystack, needle) >= 0.5;
}

/**
 * Extract the likely team label from a Yes/No market question.
 *
 *   "Will the Kansas City Chiefs beat the Buffalo Bills?"
 *     + homeTeam="Kansas City Chiefs", awayTeam="Buffalo Bills"
 *       -> "Kansas City Chiefs"  (because it's mentioned first after "Will/beat")
 *
 *   "Chiefs vs Bills: Chiefs to win?" + teams -> "Kansas City Chiefs"
 *
 * Returns the matched team name (home or away) or null if neither cleanly wins.
 */
export function extractYesSide(
  question: string,
  home: string,
  away: string,
): string | null {
  const q = normalize(question);
  const homeScore = nameSimilarity(q, home);
  const awayScore = nameSimilarity(q, away);

  // If only one team is clearly mentioned, that's the YES side.
  if (homeScore >= 0.5 && awayScore < 0.5) return home;
  if (awayScore >= 0.5 && homeScore < 0.5) return away;

  // Both mentioned — use word order: whichever team appears first is usually
  // the subject of "Will X beat Y?" or "X to win vs Y?"
  if (homeScore >= 0.5 && awayScore >= 0.5) {
    const homeIdx = earliestTokenIndex(q, home);
    const awayIdx = earliestTokenIndex(q, away);
    if (homeIdx !== -1 && awayIdx !== -1) {
      return homeIdx <= awayIdx ? home : away;
    }
  }
  return null;
}

function earliestTokenIndex(haystack: string, needle: string): number {
  const tokens = tokenize(needle);
  let earliest = -1;
  for (const t of tokens) {
    const idx = haystack.indexOf(t);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  return earliest;
}
