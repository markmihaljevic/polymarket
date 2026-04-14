// De-vigging: convert a bookmaker's quoted decimal odds into an estimate of
// the "fair" probability (no overround / juice).
//
// We use the multiplicative method — the simplest and generally unbiased for
// Pinnacle on 2-way and 3-way markets:
//
//   raw_i    = 1 / decimal_i
//   overround = sum(raw_i)
//   fair_i    = raw_i / overround
//
// For Pinnacle this tends to be within a fraction of a percent of Shin or
// power-method results, and is much easier to reason about.

export interface DevigResult {
  /** Fair probability for each outcome, same keys as input. */
  fair: Record<string, number>;
  /** Decimal overround Pinnacle was charging (e.g., 1.024 = 2.4% vig). */
  overround: number;
}

export function devigMultiplicative(
  decimalOdds: Record<string, number>,
): DevigResult | null {
  const keys = Object.keys(decimalOdds);
  if (keys.length < 2) return null;

  const raw: Record<string, number> = {};
  let total = 0;
  for (const k of keys) {
    const d = decimalOdds[k];
    if (!Number.isFinite(d) || d <= 1.0) return null;
    const r = 1 / d;
    raw[k] = r;
    total += r;
  }
  if (total <= 0) return null;

  const fair: Record<string, number> = {};
  for (const k of keys) fair[k] = raw[k] / total;

  return { fair, overround: total };
}
