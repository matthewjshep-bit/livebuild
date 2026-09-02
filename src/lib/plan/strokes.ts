import { type AngleFamily, dominantAngles, snapToFamily } from "@/lib/plan/angles";
import { area, pointInPolygon, signedArea } from "@/lib/plan/geometry";
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
 *   join endpoints → split crossings → walk the faces → name them
 *
 * The whole thing refuses rather than guesses wherever a wrong answer would be
 * indistinguishable from a right one. A drawing with a gap you meant is not the
 * same as a drawing with a gap you did not, and nothing here can tell them
 * apart - so it says where the gap is and stops.
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

/** A stroke shorter than this is a tap or a slip of the hand. */
const MIN_STROKE_PX = 15;

/** How far a corner has to stick out before it is a corner. */
const CORNER_RATIO = 0.93;

/** How far apart two wall ends can be and still be the same corner. */
const JOIN_PX = 14;

/** Beyond this a gap is a gap, and is reported rather than closed. */
const GAP_PX = 40;

/** A face smaller than this is arithmetic left over from two crossing lines. */
const SLIVER_FRACTION = 0.0008;

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
function segmentsOf(points: Vec2[]): Segment[] {
  const cuts = [0, ...corners(points), points.length - 1];
  const out: Segment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = points[cuts[i]];
    const b = points[cuts[i + 1]];
    if (dist(a, b) >= MIN_STROKE_PX) out.push({ a, b });
  }
  return out;
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

/** What the strokes make, before anything is asked about names or size. */
export type StrokeRead = {
  /** The closed spaces the walls enclose, in paper coordinates. */
  faces: Vec2[][];
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
  const nothing = (why: string): StrokeRead => ({ faces: [], adjustments, gaps: [], why });

  const inked = applyErasers(strokes);
  if (inked.length === 0) return nothing("Nothing is drawn yet.");

  let segments = inked.flatMap((points) => segmentsOf(resample(points)));
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

  // --- close what was meant to meet ---
  const joined = weld(segments, JOIN_PX);
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

  // --- rooms ---
  const loops = faces(planarise(segments));

  const total = loops.reduce((sum, l) => sum + area(l), 0);
  const kept: Vec2[][] = [];
  let slivers = 0;
  for (const loop of loops) {
    if (area(loop) < total * SLIVER_FRACTION) {
      slivers++;
      continue;
    }
    kept.push(loop);
  }
  if (slivers > 0) {
    adjustments.push(`Ignored ${slivers} sliver${slivers === 1 ? "" : "s"} where walls crossed.`);
  }

  return { faces: kept, adjustments, gaps, why: null };
}

export function strokesToRooms(
  strokes: Stroke[],
  labels: Label[],
  options: StrokeOptions = {},
): StrokeResult {
  const read = readStrokes(strokes, options);
  if (read.why) return { ok: false, why: read.why, at: read.gaps };

  const adjustments = [...read.adjustments];
  const rooms = read.faces;
  const dangling = read.gaps;

  // --- names ---
  /**
   * A name with no room round it is the one gap worth refusing on.
   *
   * Checked before anything else about the names, because it is the failure a
   * person can actually act on: they wrote "Kitchen" in a space they thought
   * they had enclosed, and one of its walls does not reach. Pointing at the word
   * they wrote is a better answer than pointing at the loose end, which they
   * may not be able to see.
   */
  const homeless = labels.filter(
    (l) => !rooms.some((polygon) => pointInPolygon([l.x, l.y], polygon)),
  );
  if (rooms.length === 0 && labels.length === 0) {
    return { ok: false, why: "Nothing here closes into a room.", at: dangling };
  }
  if (homeless.length > 0) {
    const names = homeless.map((l) => l.text.trim()).filter(Boolean);
    return {
      ok: false,
      why:
        names.length === 1
          ? `${names[0]} is not closed - one of its walls does not reach the others.`
          : `${names.join(" and ")} are not closed - some of their walls do not reach.`,
      // Point at the loose ends when there are any, and at the names otherwise.
      at: dangling.length > 0 ? dangling : homeless.map((l) => [l.x, l.y] as Vec2),
    };
  }

  const named: Array<{ polygon: Vec2[]; label: string }> = [];
  const unnamed: Vec2[] = [];
  for (const polygon of rooms) {
    const inside = labels.filter((l) => pointInPolygon([l.x, l.y], polygon));
    if (inside.length === 0) {
      unnamed.push(polygon[0]);
      continue;
    }
    if (inside.length > 1) {
      return {
        ok: false,
        why: `${inside[0].text} and ${inside[1].text} are in the same space. Is there a wall missing between them?`,
        at: [[inside[0].x, inside[0].y]],
      };
    }
    named.push({ polygon, label: inside[0].text.trim() });
  }
  if (unnamed.length > 0) {
    return {
      ok: false,
      why:
        unnamed.length === 1
          ? "One room has no name. Every room needs one - it is how the rest of the house knows what it is."
          : // Several unnamed spaces at once usually means the walls were drawn
            // as pairs of lines, so each cavity between them came out as a room
            // of its own. Worth saying, because the fix is to draw differently
            // rather than to write more labels.
            `${unnamed.length} spaces have no name. If you drew each wall as two lines, draw one line per wall instead.`,
      at: unnamed,
    };
  }

  // --- into metres ---
  //
  // A drawing has no scale of its own, so one is supplied or assumed. The
  // assumption is deliberately stated in the adjustments rather than hidden: a
  // house of the wrong size is a thing somebody should be told about.
  let scale = options.metresPerPixel;
  if (!scale) {
    const drawn = named.reduce((sum, r) => sum + area(r.polygon), 0);
    if (options.targetGroundSqft && options.targetGroundSqft > 0) {
      // A floor area somebody typed into the house sheet. Weaker than a real
      // pixel scale and stronger than the guess below, which is the whole point
      // of having it: the sheet already asks for this number.
      scale = Math.sqrt(sqftToM2(options.targetGroundSqft) / Math.max(drawn, 1));
      adjustments.push(
        `Scaled to the ${Math.round(options.targetGroundSqft)} sq ft you gave for this floor.`,
      );
    } else {
      // A typical room is about 16 square metres, so the whole drawing is about
      // that many times the number of rooms.
      scale = Math.sqrt((16 * named.length) / Math.max(drawn, 1));
      adjustments.push("No size was given, so this is scaled to rooms of a usual size.");
    }
  }

  const out: Room[] = named.map((r, i) => ({
    id: `s${i + 1}`,
    label: r.label,
    polygon: (signedArea(r.polygon) >= 0 ? r.polygon : [...r.polygon].reverse()).map(
      ([x, y]) => [x * scale!, y * scale!] as Vec2,
    ),
    ceilingHeight: 2.7,
    level: 0,
  }));

  // A room whose outline cannot be triangulated cannot be built, and finding
  // that out here is much cheaper than finding it out in the renderer.
  const broken = out.find((room) => triangulate(room.polygon).length === 0);
  if (broken) {
    return {
      ok: false,
      why: `${broken.label} came out as a shape that cannot be built. Try drawing it again more simply.`,
      at: [broken.polygon[0]],
    };
  }

  return { ok: true, rooms: out, adjustments };
}
