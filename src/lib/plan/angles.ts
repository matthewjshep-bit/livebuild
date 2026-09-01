import type { Vec2 } from "@/lib/schema";

/**
 * Which directions a drawing is built on.
 *
 * This is where "snap to the most probable shape, but keep real angles" lives.
 * A freehand wall is never straight and never at a round number of degrees, so
 * something has to decide that eleven strokes at 89.2, 90.4, 90.1... are all
 * one direction and that the two at 31 degrees are another. Rounding to the
 * nearest 5 degrees would do it, badly: it splits a wall drawn at 92.5 across
 * two buckets and it has no opinion at all about which directions the drawing
 * actually uses.
 *
 * So: find the modes by length-weighted mean shift, and snap each wall to its
 * own nearest mode. A wall that is near nothing keeps the angle it was drawn
 * at, which is the half of the requirement that stops this being a squaring-up
 * tool.
 *
 * Two details do most of the work.
 *
 * **Directions are doubled before averaging.** A wall has no arrowhead - drawn
 * left-to-right or right-to-left it is the same wall - so its direction lives
 * on a half circle, where 179 degrees and 1 degree are two degrees apart.
 * Averaging them naively gives 90, which is perpendicular to both. Doubling the
 * angle maps the half circle onto a full one where ordinary circular statistics
 * work, and halving at the end brings it back.
 *
 * **Directions fold into 0-90, not 0-180**, because walls come in perpendicular
 * pairs - which is why `footprint.dominantAngle` has always folded that way.
 *
 * This started out computing both folds and preferring 90 only when it
 * explained nearly everything, on the theory that a wing at 30 degrees to the
 * rest of the house needed the wider one. The test disproved it: a wing has two
 * walls, at 30 and at 120, and those are a perpendicular pair like any other,
 * so the 90 fold represents it as one clean family at 30. Snapping stays
 * correct because every gap is measured modulo 90 - a wall at 88 degrees
 * offered a mode at 0 is two degrees away, not eighty-eight, and turns the
 * short way onto 90. The 180 fold was answering a question that does not
 * arise, so it is gone.
 */

export type Segment = { a: Vec2; b: Vec2 };

export type AngleMode = {
  /** Degrees, in the fold's own range. */
  degrees: number;
  /** Total length of the segments that landed on it. */
  length: number;
  /** Its share of the total, 0 to 1. */
  share: number;
};

export type AngleFamily = {
  modes: AngleMode[];
  /** How much of the drawn length sits within tolerance of a mode. */
  explained: number;
};

/** Walls come in perpendicular pairs, so a direction lives in a quarter turn. */
export const FOLD = 90;

const DEG = 180 / Math.PI;

/** Length-weighted, because one long wall says more than three short ones. */
function measure(s: Segment): number {
  return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
}

/** A segment's direction, folded into [0, fold). */
export function directionOf(s: Segment, fold: number = FOLD): number {
  const raw = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * DEG;
  return ((raw % fold) + fold) % fold;
}

/** The shortest signed way from `a` to `b` on a circle of circumference `fold`. */
export function angleGap(a: number, b: number, fold: number = FOLD): number {
  let d = ((b - a) % fold + fold) % fold;
  if (d > fold / 2) d -= fold;
  return d;
}

/**
 * Mean shift on the doubled angle, which is what makes the wrap-around correct.
 *
 * Each seed walks uphill through the length-weighted density until it settles;
 * seeds that settle together are one mode. Doing this on raw degrees would put
 * a mode at 90 for a wall family straddling 0, which is the one answer that is
 * certainly wrong.
 */
function findModes(segments: Segment[], bandwidthDeg: number, minShare: number): AngleMode[] {
  const fold = FOLD;
  const entries = segments
    .map((s) => ({ angle: directionOf(s, fold), length: measure(s) }))
    .filter((e) => e.length > 1e-9);
  const total = entries.reduce((sum, e) => sum + e.length, 0);
  if (total <= 0) return [];

  // Onto the doubled circle: a fold of 90 becomes a full turn at 4x, a fold of
  // 180 at 2x. Either way the arithmetic below is plain circular averaging.
  const scale = 360 / fold;
  const toCircle = (deg: number) => (deg * scale * Math.PI) / 180;
  const bandwidth = (bandwidthDeg * scale * Math.PI) / 180;

  const settle = (start: number): number => {
    let at = start;
    for (let pass = 0; pass < 60; pass++) {
      let sx = 0;
      let sy = 0;
      for (const e of entries) {
        const theta = toCircle(e.angle);
        // Angular distance on the doubled circle.
        let d = theta - at;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) > bandwidth) continue;
        const w = e.length * Math.exp(-(d * d) / (2 * (bandwidth / 2) ** 2));
        sx += Math.cos(theta) * w;
        sy += Math.sin(theta) * w;
      }
      if (sx === 0 && sy === 0) return at;
      const next = Math.atan2(sy, sx);
      const moved = Math.abs(Math.atan2(Math.sin(next - at), Math.cos(next - at)));
      at = next;
      if (moved < 1e-6) break;
    }
    return at;
  };

  // Merge settled seeds that agree to within a fifth of the bandwidth.
  const settled: Array<{ at: number; length: number }> = [];
  for (const e of entries) {
    const at = settle(toCircle(e.angle));
    const near = settled.find((m) => {
      const d = Math.atan2(Math.sin(m.at - at), Math.cos(m.at - at));
      return Math.abs(d) < bandwidth / 5;
    });
    if (near) near.length += e.length;
    else settled.push({ at, length: e.length });
  }

  return settled
    .map((m) => {
      let deg = ((m.at * 180) / Math.PI) / scale;
      deg = ((deg % fold) + fold) % fold;
      return { degrees: deg, length: m.length, share: m.length / total };
    })
    .filter((m) => m.share >= minShare)
    .sort((a, z) => z.length - a.length);
}

/** How much of the drawn length sits within `tolerance` of some mode. */
function explainedBy(segments: Segment[], modes: AngleMode[], tolerance: number) {
  const fold = FOLD;
  let total = 0;
  let hit = 0;
  for (const s of segments) {
    const length = measure(s);
    if (length <= 1e-9) continue;
    total += length;
    const angle = directionOf(s, fold);
    if (modes.some((m) => Math.abs(angleGap(angle, m.degrees, fold)) <= tolerance)) hit += length;
  }
  return total > 0 ? hit / total : 0;
}

export type AngleOptions = {
  /** How far apart two directions can be and still be the same wall family. */
  bandwidthDeg?: number;
  /** Modes carrying less than this share of the drawn length are noise. */
  minShare?: number;
  /** How near a mode a wall must be before it is snapped to it. */
  toleranceDeg?: number;
};

/**
 * The directions a set of segments is built on.
 *
 * Tried both ways round: folded to 90, which assumes the perpendicular pairs a
 * building is made of, and folded to 180, which does not. The 90 fold wins only
 * when it explains nearly everything - so a plan that is square to itself gets
 * one clean family, and a plan with a genuine 30 degree wing keeps both.
 */
export function dominantAngles(segments: Segment[], options: AngleOptions = {}): AngleFamily {
  const bandwidthDeg = options.bandwidthDeg ?? 6;
  const minShare = options.minShare ?? 0.05;
  const toleranceDeg = options.toleranceDeg ?? 12;

  const modes = findModes(segments, bandwidthDeg, minShare);
  return { modes, explained: explainedBy(segments, modes, toleranceDeg) };
}

/**
 * Turn a segment onto its nearest direction, about its own middle.
 *
 * About the middle rather than an end, so a wall straightens without sliding -
 * an endpoint that was touching its neighbour goes on touching it, near enough
 * for the snapping that follows to close the rest.
 *
 * A segment further than `toleranceDeg` from every mode is returned untouched.
 * That is the "keep real angles" half: an outbuilding at 40 degrees to
 * everything else stays at 40 degrees rather than being dragged square.
 */
export function snapToFamily(
  segment: Segment,
  family: AngleFamily,
  toleranceDeg = 12,
): { segment: Segment; snapped: boolean } {
  if (family.modes.length === 0) return { segment, snapped: false };

  const angle = directionOf(segment);
  let best = family.modes[0];
  let bestGap = Infinity;
  for (const mode of family.modes) {
    const gap = Math.abs(angleGap(angle, mode.degrees));
    if (gap < bestGap) {
      bestGap = gap;
      best = mode;
    }
  }
  if (bestGap > toleranceDeg) return { segment, snapped: false };

  const turn = (angleGap(angle, best.degrees) * Math.PI) / 180;
  const mid: Vec2 = [(segment.a[0] + segment.b[0]) / 2, (segment.a[1] + segment.b[1]) / 2];
  const spin = ([x, y]: Vec2): Vec2 => {
    const dx = x - mid[0];
    const dy = y - mid[1];
    return [
      mid[0] + dx * Math.cos(turn) - dy * Math.sin(turn),
      mid[1] + dx * Math.sin(turn) + dy * Math.cos(turn),
    ];
  };
  return { segment: { a: spin(segment.a), b: spin(segment.b) }, snapped: true };
}

/**
 * The angle a closed ring is built on, to the nearest degree.
 *
 * `footprint.dominantAngle` in the general machinery's terms, and it must keep
 * answering exactly what it always has: a bucket-per-degree histogram of total
 * edge length folded into 0-90, ignoring edges under 0.4m. That is a different
 * estimator from mean shift - coarser, and deliberately so, because it feeds a
 * rotation that everything downstream is stored against. Changing its answers
 * would move every mapped house.
 */
export function ringAngle(points: Vec2[], minEdgeM = 0.4): number {
  const buckets = new Map<number, number>();
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < minEdgeM) continue;
    const angle = directionOf({ a, b }, 90);
    const bucket = Math.round(angle);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + length);
  }

  let best = 0;
  let bestLength = -1;
  for (const [bucket, length] of buckets) {
    if (length > bestLength) {
      bestLength = length;
      best = bucket;
    }
  }
  return best;
}
