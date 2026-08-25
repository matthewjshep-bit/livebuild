/**
 * The whole-house sanity check.
 *
 * Ported from the prvt-reviews wholesaling repo (`shared/rehab-catalog.js`).
 * These are whole-project cost ranges by house size - the numbers a wholesaler
 * carries in their head - and they exist here for one purpose: to sit beside
 * the itemised takeoff and show whether it is plausible.
 *
 * The two are computed from completely different things. The takeoff multiplies
 * measured quantities by a rate card; this looks only at square footage. When
 * they roughly agree, the rate card is sane. When they do not, one of them is
 * wrong and it is worth knowing which - a badly wrong rate silently applied to
 * every room is otherwise invisible.
 *
 * **This is Seattle-area, mid-grade flip pricing.** It is a starting point for
 * that market and a judgement call anywhere else.
 */

/** The house size the flat costs below were priced against. */
export const BASELINE_SQFT = 1500;

/**
 * How a flat cost moves with house size.
 *
 * Half the money in a scaling line is effectively fixed - mobilisation, a
 * minimum crew day, the trip charge, the permit - and half tracks the area
 * worked. So a house at half the baseline costs about 75% of the baseline
 * price, not 50%. Clamped at both ends because neither a shed nor a mansion is
 * really linear.
 *
 * Kept from the original because it exists for a reason: without it a 770 sqft
 * cottage was billed $6,000 to paint its exterior and $12,000 to reroof a
 * footprint a third that size.
 */
export function sizeFactor(sqft: number): number {
  if (!(sqft > 0)) return 1;
  return Math.min(1.5, Math.max(0.6, 0.5 + 0.5 * (sqft / BASELINE_SQFT)));
}

export type Band = {
  max: number;
  label: string;
  light: [number, number];
  medium: [number, number];
  heavy: [number, number];
};

export const REHAB_BANDS: Band[] = [
  { max: 1000, label: "under 1,000 sqft", light: [20000, 30000], medium: [30000, 50000], heavy: [50000, 70000] },
  { max: 1500, label: "1,000-1,500 sqft", light: [40000, 50000], medium: [50000, 70000], heavy: [70000, 90000] },
  { max: 2000, label: "1,500-2,000 sqft", light: [60000, 70000], medium: [70000, 90000], heavy: [90000, 110000] },
  { max: 2500, label: "2,000-2,500 sqft", light: [70000, 80000], medium: [80000, 100000], heavy: [100000, 120000] },
  { max: Infinity, label: "over 2,500 sqft", light: [80000, 90000], medium: [90000, 110000], heavy: [110000, 130000] },
];

/**
 * The band for a size. Null when the size is unknown - guessing here would
 * anchor the whole repair number on nothing.
 */
export function rehabBand(sqft: number): Band | null {
  if (!(sqft > 0)) return null;
  return REHAB_BANDS.find((b) => sqft <= b.max) ?? REHAB_BANDS[REHAB_BANDS.length - 1];
}

export type Verdict = "below" | "light" | "medium" | "heavy" | "above" | "unknown";

export type Comparison = {
  band: Band | null;
  verdict: Verdict;
  /** Plain-English reading, shown beside the takeoff total. */
  summary: string;
};

/**
 * Place an itemised total against the bands.
 *
 * `above` is a judgement call rather than an error - the heaviest band is
 * open-ended in the original, and a genuine gut can exceed it.
 */
export function compareToBands(total: number, livingSqft: number): Comparison {
  const band = rehabBand(livingSqft);
  if (!band) {
    return { band: null, verdict: "unknown", summary: "Floor area unknown, so there is nothing to compare against." };
  }

  const size = band.label;
  let verdict: Verdict;
  if (total < band.light[0]) verdict = "below";
  else if (total <= band.light[1]) verdict = "light";
  else if (total <= band.medium[1]) verdict = "medium";
  else if (total <= band.heavy[1]) verdict = "heavy";
  else verdict = "above";

  const money = (n: number) => `$${Math.round(n / 1000)}k`;

  const summary =
    verdict === "below"
      ? `Below the usual range for a house ${size} — a light rehab there starts around ${money(band.light[0])}. Worth checking nothing was missed.`
      : verdict === "above"
        ? `Above the usual range for a house ${size}, where a heavy rehab runs ${money(band.heavy[0])}–${money(band.heavy[1])}. Fine for a genuine gut; otherwise check the rates.`
        : `In line with a ${verdict} rehab for a house ${size} (${money(band[verdict][0])}–${money(band[verdict][1])}).`;

  return { band, verdict, summary };
}
