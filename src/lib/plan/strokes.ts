import { type AngleFamily, dominantAngles, snapToFamily } from "@/lib/plan/angles";
import { area, centroid, pointInPolygon, signedArea } from "@/lib/plan/geometry";
import { triangulate } from "@/lib/model/tessellate";
import type { Room, Vec2 } from "@/lib/schema";
import { sqftToM2 } from "@/lib/units";

/**
 * Turning what somebody drew into rooms.
 *
 * The existing route from a drawing to a plan goes through a picture: the pad
 * flattens its strokes to a JPEG, a vision model reads rectangles out of it, and
 * `sketchToPlan` arranges those. That works, and it costs a request, a couple of
 * seconds and an API key - and it throws away the one thing the browser already
 * had, which is the actual pen path. This is the other route: vectors in, rooms
 * out, no network.
 *
 * The order matters and each step exists because the one before it cannot be
 * trusted on its own:
 *
 *   erase → resample → corners → straight lines → snap directions →
 *   weld doubled walls → join endpoints → split crossings → walk the faces →
 *   drop what is too thin to stand in → name them → fold what has no name
 *
 * **It takes the drawing as it comes.** This used to refuse rather than guess
 * wherever a wrong answer would look like a right one, which sounded principled
 * and produced a pad that would not build a house somebody had plainly drawn:
 * going back over a wall, or redrawing a corner, leaves a thin cavity between
 * two lines, and every cavity came out as a room with no name, and six of them
 * came out as a paragraph telling you to draw differently. Redrawing is not a
 * mistake. It is how drawing works.
 *
 * So the repairs are real repairs and they are all reported. Two lines along one
 * wall become one wall; a space too narrow to stand in is wall thickness and is
 * dropped; a space with no name is folded into the named room it shares the most
 * wall with. What is left refuses only when there is genuinely nothing there.
 */

export type Stroke = {
  points: Array<[number, number]>;
  width: number;
  erase: boolean;
};

export type Label = { x: number; y: number; text: string };

export type StrokeResult =
  | {
      ok: true;
      rooms: Room[];
      /** What had to be tidied, in words, so a surprise is a told surprise. */
      adjustments: string[];
    }
  | {
      ok: false;
      why: string;
      /** Where to look, in the drawing's own coordinates. */
      at: Vec2[];
    };

/** Points closer together than this along a stroke carry no information. */
const RESAMPLE_PX = 3;

/**
 * A stroke shorter than this share of the drawing is a tap or a slip.
 *
 * Relative for the same reason the join tolerance is: fifteen paper pixels was
 * a third of a small drawing's shortest wall and a rounding error on a large
 * one, so which of somebody's walls survived depended on the zoom.
 */
const MIN_STROKE_FRACTION = 0.027;

/** And never less than this, so a tiny drawing is not read as one long line. */
const MIN_STROKE_FLOOR_PX = 6;

/** How far a corner has to stick out before it is a corner. */
const CORNER_RATIO = 0.93;

/**
 * How far apart two wall ends can be and still be the same corner.
 *
 * A fraction of how big the drawing is, not a number of pixels, and that is the
 * whole point. It was 14 paper pixels, and paper pixels are screen pixels
 * divided by the zoom - which the pad clamps to between 0.3 and 4. So zooming
 * out to fit a house on screen made corner-closing thirteen times stricter than
 * zooming in, silently, and the same drawing built or refused depending on how
 * far somebody had scrolled the wheel before they started.
 *
 * Against the drawing's own diagonal it is scale-free in both senses: it no
 * longer cares about the zoom, and it no longer cares whether the house was
 * drawn small in a corner or large across the whole pad. The number is set so a
 * drawing of ordinary size behaves as it did before.
 */
const JOIN_FRACTION = 0.025;

/** Below this the drawing is too small to take a fraction of; use pixels. */
const JOIN_FLOOR_PX = 8;

/** A face smaller than this is arithmetic left over from two crossing lines. */
const SLIVER_FRACTION = 0.0008;

/**
 * Narrower than this and it is not a room, whatever its area.
 *
 * `SLIVER_FRACTION` is measured against the sum of every face, which makes it
 * useless for exactly the case it gets blamed for: a drawing whose walls were
 * each drawn twice is mostly cavities, so the cavities *are* the total and none
 * of them looks small. A cavity is not distinguished by being small. It is
 * distinguished by being thin.
 *
 * Three feet, which is narrower than any room a person stands in and much wider
 * than any wall anybody draws.
 */
const MIN_ROOM_WIDTH_M = 0.9;

/**
 * Two walls this close and this parallel are one wall drawn twice.
 *
 * A fraction of the drawing's diagonal, for the same reason as `JOIN_FRACTION`,
 * and a little more generous than it: a doubled wall is drawn deliberately
 * apart, at whatever a person thinks a wall looks like, where a missed corner
 * is only ever a slip.
 *
 * The headroom above is what stops it eating a real room. A four-foot hallway
 * in a forty-foot house is eight per cent of the diagonal - three times this -
 * and a hallway is the narrowest thing anybody draws.
 */
const DOUBLE_FRACTION = 0.03;

/** And no further apart in angle than this. */
const DOUBLE_DEG = 8;

const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Remove what was rubbed out.
 *
 * The pad's eraser is not one: it paints in the paper colour over the top, so
 * the ink is still in the stroke list and only the picture looks clean. Reading
 * the picture hid that. Reading the vectors does not, and a wall somebody
 * deliberately erased coming back as a room is about the most confusing thing
 * this could do.
 */
function applyErasers(strokes: Stroke[]): Array<Array<Vec2>> {
  const erasers = strokes.filter((s) => s.erase);
  const kept: Array<Array<Vec2>> = [];

  for (const stroke of strokes) {
    if (stroke.erase) continue;
    let run: Vec2[] = [];
    for (const point of stroke.points) {
      const rubbed = erasers.some((e) =>
        e.points.some((p) => dist(p as Vec2, point as Vec2) < e.width / 2),
      );
      if (rubbed) {
        if (run.length > 1) kept.push(run);
        run = [];
      } else {
        run.push(point as Vec2);
      }
    }
    if (run.length > 1) kept.push(run);
  }
  return kept;
}

/** Even spacing, so a slow hand and a fast one produce comparable curvature. */
function resample(points: Vec2[], spacing = RESAMPLE_PX): Vec2[] {
  if (points.length < 2) return points;
  const out: Vec2[] = [points[0]];
  let carried = 0;

  for (let i = 1; i < points.length; i++) {
    let from = points[i - 1];
    const to = points[i];
    let span = dist(from, to);
    while (carried + span >= spacing) {
      const t = (spacing - carried) / span;
      const next: Vec2 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      out.push(next);
      from = next;
      span = dist(from, to);
      carried = 0;
    }
    carried += span;
  }
  const last = points[points.length - 1];
  if (dist(out[out.length - 1], last) > spacing / 2) out.push(last);
  return out;
}

/**
 * Where a stroke turns a corner, by the straw test.
 *
 * Measure the chord across a fixed window either side of each point: on a
 * straight run it is as long as the window, and at a corner it is visibly
 * shorter. Taking the local minima below a fraction of the median is the
 * standard way to do this and it is robust to the wobble a hand puts in, which
 * a curvature estimate is not.
 */
function corners(points: Vec2[]): number[] {
  const window = 3;
  if (points.length < window * 2 + 3) return [];

  const straws: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i < window || i >= points.length - window) {
      straws.push(Infinity);
      continue;
    }
    straws.push(dist(points[i - window], points[i + window]));
  }

  const finite = straws.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  if (finite.length === 0) return [];
  const median = finite[Math.floor(finite.length / 2)];
  const threshold = median * CORNER_RATIO;

  const found: number[] = [];
  for (let i = window; i < points.length - window; i++) {
    if (straws[i] >= threshold) continue;
    // Only the sharpest point of each dip, or one corner reads as five.
    let best = i;
    let j = i;
    while (j < points.length - window && straws[j] < threshold) {
      if (straws[j] < straws[best]) best = j;
      j++;
    }
    found.push(best);
    i = j;
  }
  return found;
}

export type Segment = { a: Vec2; b: Vec2 };

/**
 * Straight lines through a stroke, cut at its corners.
 *
 * Fitted by taking the ends of each run rather than by least squares, which
 * sounds cruder than it is: the run has already been cut where it turns, so its
 * ends are on the line by construction, and the wobble between them is about to
 * be snapped to a direction anyway.
 */
function segmentsOf(points: Vec2[], shortest: number): Segment[] {
  const cuts = [0, ...corners(points), points.length - 1];
  const out: Segment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = points[cuts[i]];
    const b = points[cuts[i + 1]];
    if (dist(a, b) >= shortest) out.push({ a, b });
  }
  return out;
}

/** How big the drawing is, from the raw ink - before there are any segments. */
function spanOfPoints(runs: Vec2[][]): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const run of runs) {
    for (const [x, y] of run) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return 0;
  return Math.hypot(x1 - x0, y1 - y0);
}

/** How big the drawing is, corner to corner. What every tolerance is a fraction of. */
function spanOf(segments: Segment[]): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { a, b } of segments) {
    for (const [x, y] of [a, b]) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return 0;
  return Math.hypot(x1 - x0, y1 - y0);
}

/**
 * The narrowest a shape gets, near enough.
 *
 * Twice the area over the perimeter - the radius of the largest circle that
 * fits, for anything convex, and an over-estimate for anything else. Both of
 * those are the right way round here: it is being used to say "nobody could
 * stand in this", and over-estimating the width means erring towards keeping a
 * space rather than towards silently eating a real room.
 */
function minWidth(polygon: Vec2[]): number {
  let perimeter = 0;
  for (let i = 0; i < polygon.length; i++) {
    perimeter += dist(polygon[i], polygon[(i + 1) % polygon.length]);
  }
  if (perimeter < 1e-9) return 0;
  return (2 * area(polygon)) / perimeter;
}

/** Where a point falls along a segment, and how far off it. */
function project(p: Vec2, a: Vec2, b: Vec2): { t: number; offset: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { t: 0, offset: dist(p, a) };
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const foot: Vec2 = [a[0] + dx * t, a[1] + dy * t];
  return { t, offset: dist(p, foot) };
}

/**
 * One wall drawn twice is one wall.
 *
 * The single most common thing a person does on this pad, and the thing it
 * handled worst. Going back over a line you already drew, or drawing a wall as
 * its two faces the way a floor plan is printed, leaves two near-parallel
 * segments a few pixels apart - and the face walk quite correctly finds the
 * cavity between them and calls it a room. Six walls drawn twice is six rooms
 * nobody meant, each with no name, and that was a refusal.
 *
 * `weld` half-rescued this by accident: if the two lines' *ends* happened to
 * land within its tolerance they collapsed onto each other and the cavity never
 * formed. That made the outcome depend on how tidily the ends lined up, which is
 * not a property anybody can aim for. This looks at the walls rather than at
 * their ends: near-parallel, near-touching, and overlapping along their shared
 * direction means one wall, and the survivor runs the length of both.
 *
 * Runs after the directions are snapped, so "parallel" is already mostly
 * decided, and before `weld`, so the merged wall's ends take part in the corner
 * clustering like any other.
 */
function mergeDoubles(
  segments: Segment[],
  gap: number,
): { segments: Segment[]; merged: number } {
  const out: Segment[] = [];
  const taken = new Array(segments.length).fill(false);
  let merged = 0;

  const cosLimit = Math.cos((DOUBLE_DEG * Math.PI) / 180);

  for (let i = 0; i < segments.length; i++) {
    if (taken[i]) continue;
    // The running union: every segment found to be the same wall as this one.
    const group = [segments[i]];
    taken[i] = true;

    // Repeat, because A may pair with B and B with C without A reaching C.
    let grew = true;
    while (grew) {
      grew = false;
      const { a, b } = group[0];
      const len = dist(a, b);
      if (len < 1e-9) break;

      for (let j = 0; j < segments.length; j++) {
        if (taken[j]) continue;
        const other = segments[j];

        // Parallel, either way round - a wall has no arrowhead.
        const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        const otherLen = dist(other.a, other.b);
        if (otherLen < 1e-9) continue;
        const v = [(other.b[0] - other.a[0]) / otherLen, (other.b[1] - other.a[1]) / otherLen];
        if (Math.abs(u[0] * v[0] + u[1] * v[1]) < cosLimit) continue;

        // Close, measured across the wall rather than along it.
        const pa = project(other.a, a, b);
        const pb = project(other.b, a, b);
        if (pa.offset > gap || pb.offset > gap) continue;

        // And genuinely overlapping, so two walls end to end stay two walls.
        const lo = Math.min(pa.t, pb.t);
        const hi = Math.max(pa.t, pb.t);
        if (hi < 0.05 || lo > 0.95) continue;

        group.push(other);
        taken[j] = true;
        merged++;
        grew = true;
      }
    }

    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }

    /**
     * The survivor: the average line, spanning everything it replaces.
     *
     * Taken along the longest member's direction, because that is the one whose
     * angle the snap pass had the most length to be confident about.
     */
    const longest = group.reduce((best, s) => (dist(s.a, s.b) > dist(best.a, best.b) ? s : best));
    const len = dist(longest.a, longest.b);
    const u: Vec2 = [(longest.b[0] - longest.a[0]) / len, (longest.b[1] - longest.a[1]) / len];

    const ends = group.flatMap((s) => [s.a, s.b]);
    const mid: Vec2 = [
      ends.reduce((sum, p) => sum + p[0], 0) / ends.length,
      ends.reduce((sum, p) => sum + p[1], 0) / ends.length,
    ];
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of ends) {
      const t = (p[0] - mid[0]) * u[0] + (p[1] - mid[1]) * u[1];
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    out.push({
      a: [mid[0] + u[0] * lo, mid[1] + u[1] * lo],
      b: [mid[0] + u[0] * hi, mid[1] + u[1] * hi],
    });
  }

  return { segments: out, merged };
}

/** Join ends that were meant to meet, and split a wall drawn into another. */
function weld(
  segments: Segment[],
  join: number,
): { segments: Segment[]; moved: number; gaps: Vec2[] } {
  const ends: Vec2[] = segments.flatMap((s) => [s.a, s.b]);
  const parent = ends.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (dist(ends[i], ends[j]) <= join) parent[find(i)] = find(j);
    }
  }

  // Each cluster collapses to its own average.
  const clusters = new Map<number, Vec2[]>();
  ends.forEach((p, i) => {
    const root = find(i);
    const list = clusters.get(root);
    if (list) list.push(p);
    else clusters.set(root, [p]);
  });
  const at = new Map<number, Vec2>();
  for (const [root, points] of clusters) {
    at.set(root, [
      points.reduce((s, p) => s + p[0], 0) / points.length,
      points.reduce((s, p) => s + p[1], 0) / points.length,
    ]);
  }

  let moved = 0;
  let welded: Segment[] = segments.map((s, i) => {
    const a = at.get(find(i * 2))!;
    const b = at.get(find(i * 2 + 1))!;
    if (dist(a, s.a) > 1e-6 || dist(b, s.b) > 1e-6) moved++;
    return { a, b };
  });

  /**
   * A wall drawn into the middle of another one.
   *
   * The endpoint clustering above only joins ends to ends, so a T-junction -
   * which is how anybody draws an interior wall - leaves the stem floating a few
   * pixels off the crossbar with no shared vertex. Nothing downstream can walk a
   * face through that. Snapping the stem onto the bar and splitting the bar
   * there is the one structural repair this does, and it is the difference
   * between two rooms and one.
   *
   * **Repeated until nothing is left to join.** This ran three passes, and one
   * split per pass, so a drawing could only ever have three T-junctions
   * repaired - and an interior wall has two ends. Three interior walls was the
   * effective ceiling: draw a fourth and it silently did nothing, its rooms came
   * out as one space, and the only symptom was a plan with fewer rooms than
   * walls. A six-room house is not an unusual drawing, so the ceiling was well
   * inside what anybody would actually draw.
   *
   * Restarting the scan after each split is deliberate: the split rebuilds the
   * segment list, so every index after `j` has moved. The cap is on the number
   * of repairs rather than on passes, and it is generous - each repair adds one
   * segment, and a hand drawing has tens of them, so it exists to bound a bug
   * rather than to bound the work.
   */
  const REPAIR_LIMIT = welded.length * 4 + 16;
  for (let repair = 0; repair < REPAIR_LIMIT; repair++) {
    let split = false;
    for (let i = 0; i < welded.length && !split; i++) {
      for (const end of [welded[i].a, welded[i].b]) {
        for (let j = 0; j < welded.length; j++) {
          if (i === j) continue;
          const { a, b } = welded[j];
          if (dist(end, a) <= join || dist(end, b) <= join) continue;
          const len = dist(a, b);
          if (len < 1e-9) continue;
          const t =
            ((end[0] - a[0]) * (b[0] - a[0]) + (end[1] - a[1]) * (b[1] - a[1])) / (len * len);
          if (t <= 0.02 || t >= 0.98) continue;
          const foot: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          if (dist(end, foot) > join) continue;

          end[0] = foot[0];
          end[1] = foot[1];
          welded = [
            ...welded.slice(0, j),
            { a, b: foot },
            { a: foot, b },
            ...welded.slice(j + 1),
          ];
          moved++;
          split = true;
          break;
        }
        if (split) break;
      }
    }
    if (!split) break;
  }

  // Whatever is still dangling is a gap somebody has to decide about.
  const gaps: Vec2[] = [];
  const endsNow = welded.flatMap((s) => [s.a, s.b]);
  for (const p of endsNow) {
    const touching = endsNow.filter((q) => q !== p && dist(p, q) < 1e-6).length;
    if (touching === 0) gaps.push(p);
  }

  return { segments: welded, moved, gaps };
}

/**
 * When nothing closes, join the loose ends.
 *
 * The last resort, and deliberately the last: a wall that stops a hundred and
 * sixty pixels short of the next one is not a slip of the hand, and `weld`'s
 * tolerance has no business reaching that far. But refusing was worse. A person
 * who drew three walls of a room and wrote "Kitchen" in it has told you where
 * the fourth wall goes, and the reader is the only party that does not know.
 *
 * Safe because it checks its own work. Ends are joined nearest pair first, and
 * the result is kept only if it produced more rooms than there were before -
 * so on a drawing that was already fine, this cannot do anything at all.
 */
function closeGaps(segments: Segment[]): { segments: Segment[]; closed: number } {
  const before = faces(planarise(segments)).length;

  // A loose end is one that no other end shares a point with.
  const ends = segments.flatMap((s) => [s.a, s.b]);
  const loose = ends.filter((p) => !ends.some((q) => q !== p && dist(p, q) < 1e-6));
  if (loose.length < 2) return { segments, closed: 0 };

  const pairs: Array<{ a: Vec2; b: Vec2; away: number }> = [];
  for (let i = 0; i < loose.length; i++) {
    for (let j = i + 1; j < loose.length; j++) {
      pairs.push({ a: loose[i], b: loose[j], away: dist(loose[i], loose[j]) });
    }
  }
  pairs.sort((x, y) => x.away - y.away);

  const used = new Set<Vec2>();
  let working = segments;
  let closed = 0;
  for (const pair of pairs) {
    if (used.has(pair.a) || used.has(pair.b)) continue;
    used.add(pair.a);
    used.add(pair.b);
    working = [...working, { a: pair.a, b: pair.b }];
    closed++;
  }

  if (closed === 0) return { segments, closed: 0 };
  // Only if it helped.
  if (faces(planarise(working)).length <= before) return { segments, closed: 0 };
  return { segments: working, closed };
}

/** Cut every segment where another crosses it. */
function planarise(segments: Segment[]): Segment[] {
  const cuts = segments.map<number[]>(() => [0, 1]);

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const p = segments[i].a;
      const r: Vec2 = [segments[i].b[0] - p[0], segments[i].b[1] - p[1]];
      const q = segments[j].a;
      const s: Vec2 = [segments[j].b[0] - q[0], segments[j].b[1] - q[1]];
      const denom = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denom;
      const u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / denom;
      if (t > 1e-6 && t < 1 - 1e-6) cuts[i].push(t);
      if (u > 1e-6 && u < 1 - 1e-6) cuts[j].push(u);
    }
  }

  const out: Segment[] = [];
  segments.forEach((seg, i) => {
    const ts = [...new Set(cuts[i])].sort((a, b) => a - b);
    for (let k = 0; k < ts.length - 1; k++) {
      const a: Vec2 = [
        seg.a[0] + (seg.b[0] - seg.a[0]) * ts[k],
        seg.a[1] + (seg.b[1] - seg.a[1]) * ts[k],
      ];
      const b: Vec2 = [
        seg.a[0] + (seg.b[0] - seg.a[0]) * ts[k + 1],
        seg.a[1] + (seg.b[1] - seg.a[1]) * ts[k + 1],
      ];
      if (dist(a, b) > 1e-6) out.push({ a, b });
    }
  });
  return out;
}

const key = (p: Vec2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

/**
 * The rooms a set of walls encloses.
 *
 * Every wall is two half-edges, one each way. At each vertex the half-edges are
 * sorted by angle, and from any half-edge the next one round a face is the
 * clockwise-most turn at its far end. Following that consumes each half-edge
 * exactly once and yields every face, including the one outside the building -
 * which is the only one wound the other way, and is dropped by its sign rather
 * than by being the biggest.
 */
function faces(segments: Segment[]): Vec2[][] {
  const at = new Map<string, Vec2>();
  const out = new Map<string, string[]>();
  for (const s of segments) {
    at.set(key(s.a), s.a);
    at.set(key(s.b), s.b);
    for (const [from, to] of [
      [s.a, s.b],
      [s.b, s.a],
    ] as const) {
      const list = out.get(key(from));
      if (list) list.push(key(to));
      else out.set(key(from), [key(to)]);
    }
  }

  // Drop dead ends: a stray tick, a label underline, an arrow.
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const [from, tos] of out) {
      if (tos.length > 1) continue;
      for (const [other, list] of out) {
        const i = list.indexOf(from);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0 && other !== from) out.delete(other);
      }
      out.delete(from);
      pruned = true;
      break;
    }
  }

  const angle = (from: string, to: string) => {
    const a = at.get(from)!;
    const b = at.get(to)!;
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  for (const [from, tos] of out) {
    tos.sort((p, q) => angle(from, p) - angle(from, q));
  }

  const used = new Set<string>();
  const loops: Vec2[][] = [];
  for (const [from, tos] of out) {
    for (const to of tos) {
      if (used.has(`${from}>${to}`)) continue;
      const loop: string[] = [];
      let a = from;
      let b = to;
      for (let guard = 0; guard < 4000; guard++) {
        used.add(`${a}>${b}`);
        loop.push(a);
        const around = out.get(b);
        if (!around || around.length === 0) break;
        // The clockwise-most turn from b, coming in from a.
        const back = around.indexOf(a);
        const next = around[(back - 1 + around.length) % around.length];
        a = b;
        b = next;
        if (a === from && b === to) break;
      }
      if (loop.length >= 3) loops.push(loop.map((k) => at.get(k)!));
    }
  }
  // Interior faces are wound one way; the face outside the building is the
  // other, and there is one per connected piece of the drawing.
  return loops.filter((loop) => signedArea(loop) > 0 && area(loop) > 0);
}

export type StrokeOptions = {
  /** Metres per drawing pixel. Supplied by whoever knows the real size. */
  metresPerPixel?: number;
  /**
   * How big the drawing is meant to be, when nobody knows the pixel scale.
   *
   * Weaker than `metresPerPixel` and stronger than the guess below it: the
   * house sheet asks for a floor area, and a number somebody typed beats a
   * number this file made up.
   */
  targetGroundSqft?: number;
  /** How far a wall may be turned to line up with the others. */
  snapDeg?: number;
};

/**
 * Metres per drawing pixel, from the best source there is.
 *
 * Three sources in strict order: a real pixel scale from the building outline,
 * a floor area somebody typed into the house sheet, and failing both, the
 * assumption that a room is about sixteen square metres.
 *
 * Lifted out of the naming pass because the face filter needs it too. Asking
 * "is this space too narrow for a person" is a question about metres, and it
 * has to be answered before it is known which faces are rooms - so it is
 * answered here, against every face, which is if anything the more honest
 * denominator.
 */
function scaleFor(loops: Vec2[][], options: StrokeOptions): number {
  if (options.metresPerPixel) return options.metresPerPixel;
  const drawn = Math.max(
    loops.reduce((sum, l) => sum + area(l), 0),
    1,
  );
  if (options.targetGroundSqft && options.targetGroundSqft > 0) {
    return Math.sqrt(sqftToM2(options.targetGroundSqft) / drawn);
  }
  return Math.sqrt((16 * Math.max(loops.length, 1)) / drawn);
}

/** What the strokes make, before anything is asked about names or size. */
export type StrokeRead = {
  /** The closed spaces the walls enclose, in paper coordinates. */
  faces: Vec2[][];
  /**
   * The walls those spaces came from, after every repair.
   *
   * Carried out so folding a space into its neighbour can delete the wall
   * between them and walk the faces again. Merging the two polygons instead
   * would mean a general polygon union - `outlineOf` only takes rectangles, and
   * a drawn room is not one; the angled sunroom in `strokes-test` is there
   * precisely to stop rooms being squared up.
   */
  segments: Segment[];
  /** What had to be tidied, in words, so a surprise is a told surprise. */
  adjustments: string[];
  /** Wall ends that met nothing. Somewhere to point when a room will not close. */
  gaps: Vec2[];
  /** Why there is nothing to show, when that is worth saying. */
  why: string | null;
};

/**
 * Strokes to spaces, and no further.
 *
 * The front half of `strokesToRooms`, split out because the drawing board needs
 * it on every stroke and not only when somebody presses the button. Showing the
 * spaces as they close is what makes naming one possible: until the faces are on
 * screen, "click inside the room" asks somebody to aim at something they cannot
 * see, and the first they hear of a miss is a refusal afterwards.
 *
 * It is the same pipeline, in the same order, with the same constants - so what
 * the board draws and what the reader accepts cannot drift apart.
 */
export function readStrokes(strokes: Stroke[], options: StrokeOptions = {}): StrokeRead {
  const adjustments: string[] = [];
  const nothing = (why: string): StrokeRead => ({
    faces: [],
    segments: [],
    adjustments,
    gaps: [],
    why,
  });

  const inked = applyErasers(strokes);
  if (inked.length === 0) return nothing("Nothing is drawn yet.");

  /**
   * How big the drawing is, taken from the ink before anything is done to it.
   *
   * Measured here rather than from the segments because the shortest-wall test
   * happens while the segments are being made - there is nothing else yet to
   * take a fraction of.
   */
  const inkSpan = spanOfPoints(inked);
  const shortest = Math.max(MIN_STROKE_FLOOR_PX, inkSpan * MIN_STROKE_FRACTION);

  let segments = inked.flatMap((points) => segmentsOf(resample(points), shortest));
  if (segments.length < 3) return nothing("That is not enough wall to make a room.");

  // --- straighten, keeping genuine angles ---
  const family: AngleFamily = dominantAngles(segments);
  let snapped = 0;
  segments = segments.map((segment) => {
    const result = snapToFamily(segment, family, options.snapDeg ?? 12);
    if (result.snapped) snapped++;
    return result.segment;
  });
  if (snapped > 0) {
    adjustments.push(
      `Straightened ${snapped} wall${snapped === 1 ? "" : "s"} onto ${family.modes.length} direction${family.modes.length === 1 ? "" : "s"}.`,
    );
  }

  /**
   * Every tolerance from here on is a fraction of how big the drawing is.
   *
   * Measured after the segments exist and before anything is welded, so it
   * describes what was drawn rather than what has been done to it.
   */
  const span = spanOf(segments);
  const join = Math.max(JOIN_FLOOR_PX, span * JOIN_FRACTION);

  // --- one wall drawn twice is one wall ---
  const doubled = mergeDoubles(segments, Math.max(JOIN_FLOOR_PX, span * DOUBLE_FRACTION));
  segments = doubled.segments;
  if (doubled.merged > 0) {
    adjustments.push(
      `Welded ${doubled.merged} wall${doubled.merged === 1 ? "" : "s"} that ${doubled.merged === 1 ? "was" : "were"} drawn twice.`,
    );
  }

  // --- close what was meant to meet ---
  const joined = weld(segments, join);
  segments = joined.segments;
  if (joined.moved > 0) {
    adjustments.push(`Closed ${joined.moved} corner${joined.moved === 1 ? "" : "s"}.`);
  }
  /**
   * A dangling end is not evidence of anything on its own.
   *
   * This used to refuse outright when a wall stopped without meeting one, which
   * caught the deliberate gap it was written for and also caught a stray tick,
   * a hyphen under a label and everything left behind by rubbing a wall out -
   * all of which the face walk discards without complaint. The question that
   * actually matters is not whether something dangles but whether a room
   * somebody *named* failed to close, and that is answered by the caller, where
   * the labels are. Kept only to point at.
   */
  const gaps = joined.gaps;

  // --- a last resort, when the walls as drawn enclose nothing at all ---
  //
  // A drawing that already makes rooms is left exactly as it is.
  if (faces(planarise(segments)).length === 0) {
    const bridged = closeGaps(segments);
    if (bridged.closed > 0) {
      segments = bridged.segments;
      adjustments.push(
        `Joined ${bridged.closed} loose wall end${bridged.closed === 1 ? "" : "s"} so the room would close.`,
      );
    }
  }

  // --- rooms ---
  const loops = faces(planarise(segments));

  /**
   * What is left over from the walls, rather than enclosed by them.
   *
   * Two tests, because they catch different things. The relative one catches
   * arithmetic - the triangle where two lines cross - and cannot catch a wall
   * cavity, because a drawing whose walls were all doubled is *made* of
   * cavities and they are the total it is measured against. The absolute one
   * catches the cavity, by asking the only question that distinguishes it from
   * a room: could a person stand in it.
   */
  const total = loops.reduce((sum, l) => sum + area(l), 0);
  const scale = scaleFor(loops, options);
  const kept: Vec2[][] = [];
  let slivers = 0;
  let thin = 0;
  for (const loop of loops) {
    if (area(loop) < total * SLIVER_FRACTION) {
      slivers++;
      continue;
    }
    if (minWidth(loop) * scale < MIN_ROOM_WIDTH_M) {
      thin++;
      continue;
    }
    kept.push(loop);
  }
  if (slivers > 0) {
    adjustments.push(`Ignored ${slivers} sliver${slivers === 1 ? "" : "s"} where walls crossed.`);
  }
  if (thin > 0) {
    adjustments.push(
      `Took ${thin} space${thin === 1 ? "" : "s"} too narrow to stand in as wall thickness.`,
    );
  }

  return { faces: kept, segments, adjustments, gaps, why: null };
}

/**
 * The room a label most likely meant, when it is not inside one.
 *
 * Only ever a short reach - a label a long way from every room was not written
 * for any of them, and guessing would put the kitchen wherever somebody had
 * scribbled. The reach is a fraction of the drawing, so it means the same thing
 * whatever size the house was drawn at.
 */
function nearestRoom(point: Vec2, rooms: Vec2[][], segments: Segment[]): Vec2[] | null {
  const reach = Math.max(JOIN_FLOOR_PX, spanOf(segments) * JOIN_FRACTION) * 2;
  let best: { room: Vec2[]; away: number } | null = null;

  for (const room of rooms) {
    let away = Infinity;
    for (let i = 0; i < room.length; i++) {
      const { offset, t } = project(point, room[i], room[(i + 1) % room.length]);
      // Off the end of a wall, the corner is the nearest part of it.
      const gap =
        t < 0 ? dist(point, room[i]) : t > 1 ? dist(point, room[(i + 1) % room.length]) : offset;
      if (gap < away) away = gap;
    }
    if (away <= reach && (!best || away < best.away)) best = { room, away };
  }
  return best?.room ?? null;
}

/** A wall, keyed so the two faces either side of it agree on which one it is. */
const edgeKey = (a: Vec2, b: Vec2) => {
  const [p, q] = key(a) < key(b) ? [a, b] : [b, a];
  return `${key(p)}|${key(q)}`;
};

/**
 * Give a space with no name to the room next door.
 *
 * The last thing standing between a drawing and a house. A space nobody named
 * is usually not a space: it is what is left between two lines drawn for one
 * wall, or in the corner where a redrawn wall missed its old self. The thin
 * ones are already gone by here. What survives is big enough to be real, and
 * the honest thing to do with it is to give it to whichever named room it
 * shares the most wall with - which is almost always the room it was part of
 * before somebody drew over the line.
 *
 * Done by deleting the wall between them and walking the faces again, rather
 * than by merging two polygons. The faces come from a planar subdivision, so
 * the wall they share is the *same* wall in both - identical coordinates, no
 * tolerance, and the result is a real face by construction rather than by
 * arithmetic that has to be trusted.
 *
 * One space per pass, because deleting a wall changes every face around it.
 */
function foldUnnamed(
  segments: Segment[],
  labels: Label[],
): { faces: Vec2[][]; folded: number } {
  /**
   * Split at every crossing once, up front.
   *
   * The faces are walked from the planarised walls, so a face's edge is a
   * *piece* of a wall rather than the wall somebody drew. Matching those pieces
   * against the undivided segments finds nothing - which is how the first
   * version of this silently folded nothing at all while reporting that it had.
   */
  let working = planarise(segments);
  let folded = 0;

  // Each fold removes at least one wall, so this cannot run longer than there
  // are walls. The cap is here to bound a bug, not the work.
  for (let pass = 0; pass < working.length + 8; pass++) {
    const loops = faces(working);
    const named = loops.filter((loop) =>
      labels.some((l) => pointInPolygon([l.x, l.y], loop)),
    );
    const nameless = loops.filter((loop) => !named.includes(loop));
    if (nameless.length === 0 || named.length === 0) {
      return { faces: loops, folded };
    }

    // The biggest orphan first: it has the most wall to be sure about, and
    // absorbing it may well take its smaller neighbours with it.
    const orphan = nameless.reduce((big, l) => (area(l) > area(big) ? l : big));
    const orphanEdges = new Set<string>();
    for (let i = 0; i < orphan.length; i++) {
      orphanEdges.add(edgeKey(orphan[i], orphan[(i + 1) % orphan.length]));
    }

    // Which named room does it share the most wall with?
    let best: { shared: Set<string>; length: number } | null = null;
    for (const room of named) {
      const shared = new Set<string>();
      let length = 0;
      for (let i = 0; i < room.length; i++) {
        const a = room[i];
        const b = room[(i + 1) % room.length];
        const k = edgeKey(a, b);
        if (!orphanEdges.has(k)) continue;
        shared.add(k);
        length += dist(a, b);
      }
      if (shared.size > 0 && (!best || length > best.length)) best = { shared, length };
    }

    // Touching no named room at all. Nothing to give it to; it stays, and gets
    // a name of its own further down.
    if (!best) return { faces: loops, folded };

    working = working.filter((wall) => !best!.shared.has(edgeKey(wall.a, wall.b)));
    folded++;
  }

  return { faces: faces(working), folded };
}

export function strokesToRooms(
  strokes: Stroke[],
  labels: Label[],
  options: StrokeOptions = {},
): StrokeResult {
  const read = readStrokes(strokes, options);
  if (read.why) return { ok: false, why: read.why, at: read.gaps };

  const adjustments = [...read.adjustments];
  const dangling = read.gaps;

  /**
   * Nothing closed, and nothing was written. There is no drawing to read.
   *
   * The only refusal left in the naming half, and it survives because it is the
   * one case where proceeding would invent a house out of nothing at all.
   */
  if (read.faces.length === 0 && labels.length === 0) {
    return { ok: false, why: "Nothing here closes into a room.", at: dangling };
  }

  // --- fold away the spaces nobody named ---
  const folding = foldUnnamed(read.segments, labels);
  const rooms = folding.faces.length > 0 ? folding.faces : read.faces;
  if (folding.folded > 0) {
    adjustments.push(
      `Folded ${folding.folded} unnamed space${folding.folded === 1 ? "" : "s"} into the room next door.`,
    );
  }

  // --- names ---
  /**
   * A name with no room round it, kept rather than refused.
   *
   * This used to stop everything and say "Kitchen is not closed - one of its
   * walls does not reach the others". Sometimes that is exactly what happened.
   * Just as often the wall does reach and the word sits a pixel outside it, or
   * the space it named was folded into a neighbour a moment ago. Refusing on a
   * point-in-polygon test with no tolerance made the pad's answer depend on
   * where a label happened to land.
   *
   * So it is a repair: the label goes to the nearest room whose centre is
   * within reach, and is otherwise dropped and reported. Neither outcome stops
   * the house being built.
   */
  const placed = new Map<Vec2[], Label[]>();
  const lost: string[] = [];
  for (const label of labels) {
    const home =
      rooms.find((polygon) => pointInPolygon([label.x, label.y], polygon)) ??
      nearestRoom([label.x, label.y], rooms, read.segments);
    if (!home) {
      const text = label.text.trim();
      if (text) lost.push(text);
      continue;
    }
    const list = placed.get(home);
    if (list) list.push(label);
    else placed.set(home, [label]);
  }
  if (lost.length > 0) {
    adjustments.push(
      `Could not find a room for ${lost.join(" or ")} - ${lost.length === 1 ? "its walls do" : "their walls do"} not close.`,
    );
  }

  /**
   * Two names in one space, and the first one wins.
   *
   * Still worth saying: it usually does mean a wall is missing between them,
   * and that is a thing the drawing can be corrected for. It is not worth
   * stopping for, because the house built from the first name is a house.
   */
  const named: Array<{ polygon: Vec2[]; label: string }> = [];
  let spare = 0;
  for (const polygon of rooms) {
    const inside = placed.get(polygon) ?? [];
    if (inside.length > 1) {
      adjustments.push(
        `${inside[0].text} and ${inside[1].text} are in the same space - built as ${inside[0].text}. Is there a wall missing between them?`,
      );
    }
    // Anything still nameless here touched no named room at all, so there was
    // nothing to fold it into. It is a room; it just has not been told what
    // kind. Naming it is better than losing it.
    const label = inside[0]?.text.trim() || `Room ${++spare}`;
    named.push({ polygon, label });
  }
  if (spare > 0) {
    adjustments.push(
      `${spare} space${spare === 1 ? "" : "s"} had no name and ${spare === 1 ? "was" : "were"} not beside a room that did, so ${spare === 1 ? "it is" : "they are"} built unnamed.`,
    );
  }
  if (named.length === 0) {
    return { ok: false, why: "Nothing here closes into a room.", at: dangling };
  }

  // --- into metres ---
  //
  // A drawing has no scale of its own, so one is supplied or assumed. The
  // assumption is deliberately stated in the adjustments rather than hidden: a
  // house of the wrong size is a thing somebody should be told about.
  const scale = scaleFor(
    named.map((r) => r.polygon),
    options,
  );
  if (!options.metresPerPixel) {
    if (options.targetGroundSqft && options.targetGroundSqft > 0) {
      // A floor area somebody typed into the house sheet. Weaker than a real
      // pixel scale and stronger than the guess below, which is the whole point
      // of having it: the sheet already asks for this number.
      adjustments.push(
        `Scaled to the ${Math.round(options.targetGroundSqft)} sq ft you gave for this floor.`,
      );
    } else {
      // A typical room is about 16 square metres, so the whole drawing is about
      // that many times the number of rooms.
      adjustments.push("No size was given, so this is scaled to rooms of a usual size.");
    }
  }

  const built: Room[] = named.map((r, i) => ({
    id: `s${i + 1}`,
    label: r.label,
    polygon: (signedArea(r.polygon) >= 0 ? r.polygon : [...r.polygon].reverse()).map(
      ([x, y]) => [x * scale, y * scale] as Vec2,
    ),
    ceilingHeight: 2.7,
    level: 0,
  }));

  /**
   * A room whose outline cannot be triangulated cannot be built.
   *
   * Worth finding here rather than in the renderer, but not worth losing the
   * house over: one unbuildable shape used to refuse the whole drawing, so a
   * single bad corner cost every other room somebody had drawn. Dropped and
   * reported instead.
   */
  const out = built.filter((room) => triangulate(room.polygon).length > 0);
  const broken = built.filter((room) => !out.includes(room));
  if (broken.length > 0) {
    adjustments.push(
      `Left out ${broken.map((r) => r.label).join(" and ")} - ${broken.length === 1 ? "it came" : "they came"} out as a shape that cannot be built.`,
    );
  }
  if (out.length === 0) {
    return {
      ok: false,
      why: "Nothing here came out as a shape that can be built. Try drawing it again more simply.",
      at: built.map((room) => centroid(room.polygon)),
    };
  }

  return { ok: true, rooms: out, adjustments };
}
