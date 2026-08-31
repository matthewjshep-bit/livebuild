/**
 * The sizes houses are actually built to.
 *
 * A vision model is good at recognising things and bad at measuring them, and
 * the difference matters because everything downstream of a wrong dimension is
 * wrong by the same factor while looking entirely self-consistent. So the
 * division of labour is: the model says what it is looking at, and this says
 * how big that is.
 *
 * Snapping is not rounding for tidiness. Skirting comes in stock heights, doors
 * come in stock widths, a ceiling is framed to a standard stud. A reading of
 * 141mm is a 140mm board seen at a slight angle; a reading of 210mm is
 * something else and should stay 210mm. So a value within tolerance of a
 * standard becomes that standard, and a value outside every tolerance is kept
 * exactly as it came and flagged - because a house genuinely can have a 2.2m
 * ceiling, and forcing it to 2.44m would throw away the very thing that made
 * the room distinctive.
 */

export type SnapTable = {
  /** The stock sizes, in metres. */
  readonly values: readonly number[];
  /** How far off one a reading may be and still be taken as that one. */
  readonly toleranceM: number;
};

export const STANDARDS = {
  /** 3", 3.5", 4.5", 5.5", 6.5", 7.5" skirting. */
  baseboardM: { values: [0.076, 0.089, 0.114, 0.14, 0.165, 0.19], toleranceM: 0.018 },
  crownM: { values: [0.089, 0.114, 0.14, 0.165], toleranceM: 0.018 },
  /** 7'6", 8', 8'6", 9', 9'6", 10', 11', 12'. */
  ceilingM: {
    values: [2.29, 2.44, 2.59, 2.74, 2.9, 3.05, 3.35, 3.66],
    toleranceM: 0.09,
  },
  /** 24" to 36" leaf widths. */
  doorWidthM: { values: [0.61, 0.68, 0.71, 0.76, 0.81, 0.91], toleranceM: 0.045 },
  /** A cased opening is measured, not stocked, but it is framed in half-feet. */
  openingWidthM: { values: [1.22, 1.52, 1.83, 2.13, 2.44, 3.05], toleranceM: 0.12 },
} as const;

export type StandardName = keyof typeof STANDARDS;

export type Snapped = {
  value: number;
  /** True when the reading was close enough to a stock size to become it. */
  snapped: boolean;
};

export function snap(value: number, table: SnapTable): Snapped {
  let best: number | null = null;
  let bestGap = Infinity;
  for (const candidate of table.values) {
    const gap = Math.abs(candidate - value);
    if (gap < bestGap) {
      bestGap = gap;
      best = candidate;
    }
  }
  if (best !== null && bestGap <= table.toleranceM) return { value: best, snapped: true };
  return { value, snapped: false };
}

/** Snap by name, and leave anything absent absent. */
export function snapTo(
  value: number | null | undefined,
  name: StandardName,
): Snapped | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return snap(value, STANDARDS[name]);
}

/**
 * Whether a room's stated dimensions and the model's own scale reference agree.
 *
 * The scale reference is the highest-leverage field in the whole extraction: a
 * model that names the object it measured everything against, and how wide it
 * believes that object to be, has told you enough to check its arithmetic. When
 * it says it used the doorway, the true width is already known - so the implied
 * error is computable, and a reading that is out by a third can be marked down
 * rather than believed.
 */
export function scaleError(assumedM: number, trueM: number): number {
  if (!Number.isFinite(assumedM) || assumedM <= 0 || trueM <= 0) return 0;
  return Math.abs(assumedM - trueM) / trueM;
}

/** Past this, a reading's dimensions are not worth trusting. */
export const SCALE_TOLERANCE = 0.15;
