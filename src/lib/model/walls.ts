import { signedArea } from "@/lib/plan/geometry";
import type { Opening, Plan, Room, Vec2 } from "@/lib/schema";

/**
 * Turn a floor plan into wall solids.
 *
 * The old dollhouse drew each room's walls itself, which meant a wall between
 * two rooms was two coincident zero-thickness quads. It read as a diagram
 * because it was one: paper-thin partitions, and doorways that were simply gaps
 * where a wall stopped.
 *
 * Here every storey is resolved into one wall graph first. A wall shared by two
 * rooms is emitted once; walls have real thickness; and a doorway gets a header
 * above it, which is what makes an opening read as a door rather than as a
 * missing piece of wall.
 *
 * Assumes axis-aligned rectangular rooms. That is all `autoLayout` and
 * `sketchToPlan` ever produce, and it is what makes pairing walls tractable -
 * collinear segments can be grouped by axis and coordinate rather than by
 * general geometric intersection.
 */

export const INTERIOR_THICKNESS = 0.1;
export const EXTERIOR_THICKNESS = 0.2;
export const DOOR_HEIGHT = 2.05;

/** Edges closer than this were meant to be the same wall. */
/**
 * How far apart two edge directions can be and still be the same wall.
 *
 * Clustered rather than quantised, and the difference is not academic: a bucket
 * boundary falls somewhere, and rotating a house walks its walls across one.
 * Two edges of a single wall landing in adjacent buckets are then resolved as
 * two lines, which builds the wall twice at slightly different offsets. Sorting
 * and cutting where the gap is large has no boundaries to straddle.
 *
 * A tenth of a degree - far finer than anything drawn by hand, and far coarser
 * than the drift of rotating a polygon.
 */
const DIRECTION_TOLERANCE = (0.1 * Math.PI) / 180;

/**
 * How close two offsets have to be before they are the same line.
 *
 * Named once because three separate comparisons need to agree about it, and
 * because the value is not the interesting part - using the *same* one
 * everywhere is. Two of them disagreeing is how a wall merges by one test and
 * splits by another.
 */
const SAME_LINE = 1e-6;

const PAIR_TOLERANCE = 0.06;

/** Below this a wall piece is a pairing artefact rather than a wall. */
const MIN_WALL_PIECE = 0.08;

export type WallSolid = {
  /** Centre of the wall in plan space. */
  center: Vec2;
  /** Length along the wall, and its thickness across. */
  length: number;
  thickness: number;
  /** Base height above the storey floor, and how tall this piece is. */
  base: number;
  height: number;
  /** 0 for a wall running along +x, 90 for one running along +y. */
  angleDeg: number;
  exterior: boolean;
  /** True for the short piece bridging the top of a doorway. */
  header: boolean;
  /**
   * Which way is out of the building, for exterior walls; null for interior.
   *
   * This is what lets the dollhouse cull the shell nearest the camera. Without
   * it you look straight into the back of the front wall from every angle,
   * which is the single thing that makes an unculled dollhouse useless.
   */
  outward: Vec2 | null;
};

/**
 * The infinite line an edge lies on, in a form two edges can be compared by.
 *
 * A normal and an offset rather than an axis and a coordinate. Every edge on the
 * same wall folds to the *same* normal regardless of which way round its room
 * walked it, so "are these the same wall" becomes an equality test rather than a
 * special case per axis. For an axis-aligned edge this reduces exactly to what
 * `axis` and `at` encoded: a horizontal edge gets N = (0,1) and c = y, a
 * vertical one N = (1,0) and c = x.
 */
type Line = {
  /** Unit normal, folded so anti-parallel edges share it. */
  n: Vec2;
  /** Perpendicular distance from the origin: `n . a`. */
  c: number;
};

type Edge = {
  roomId: string;
  line: Line;
  /** Span along the line's tangent. */
  from: number;
  to: number;
  /** Which way is out of the room, as -1 or +1 along the line's normal. */
  outward: -1 | 1;
};

/**
 * The tangent of a line: its normal turned a quarter.
 *
 * Positions along a wall are measured in this, so every span on one line shares
 * an origin and the sweep can compare them. Which of the two possible tangents
 * is chosen does not matter as long as it is always the same one - the spans are
 * only ever compared with each other and turned back into points by `toSolid`.
 */
const tangentOf = (n: Vec2): Vec2 => [-n[1], n[0]];

const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];

/**
 * Fold a normal so that an edge and the edge facing it across a wall agree.
 *
 * Two rooms sharing a wall walk it in opposite directions, so their outward
 * normals are exactly opposed. Picking a canonical one of each pair - the one
 * pointing up, or right when it points along the horizon - is what lets both
 * edges land in the same group. `outward` remembers which of the two the room
 * actually faced, which is the same thing the old -1/+1 meant.
 */
function canonical(n: Vec2): { n: Vec2; outward: -1 | 1 } {
  const up = n[1] > 1e-9 || (Math.abs(n[1]) <= 1e-9 && n[0] > 0);
  return up ? { n, outward: 1 } : { n: [-n[0], -n[1]], outward: -1 };
}

/**
 * The room's own edges, walked rather than assumed.
 *
 * This used to return the four sides of the bounding box, which was right for
 * as long as every room was a rectangle. An L-shaped room built that way gets
 * walls straight across its own notch and a floor spilling out past them, and
 * nothing errors - it just quietly builds the wrong house.
 *
 * No longer rectilinear. Every edge is kept at whatever angle it was drawn,
 * because the sweep below groups by the infinite line an edge lies on rather
 * than by axis and coordinate. This used to drop any edge that was not axis
 * aligned - which meant a room turned seven degrees produced no walls at all,
 * silently, and stood as a floor with nothing on it.
 */
function edgesOf(room: Room): Edge[] {
  const poly = orientPositive(room.polygon);
  const edges: Edge[] = [];

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;

    // The outward normal of a→b on a positively-wound polygon is (dy, -dx).
    const { n, outward } = canonical([dy / length, -dx / length]);
    const t = tangentOf(n);
    const pa = dot(t, a);
    const pb = dot(t, b);

    edges.push({
      roomId: room.id,
      line: { n, c: dot(n, a) },
      from: Math.min(pa, pb),
      to: Math.max(pa, pb),
      outward,
    });
  }

  return edges;
}

/**
 * The same polygon, wound so its signed area is positive.
 *
 * Every producer in the codebase emits positive winding, and `edgesOf` reads
 * the outward direction straight off it - so a polygon that arrived the other
 * way round would build a house inside out, with every exterior wall offset
 * into the room and every interior pairing looking the wrong way. Cheap to
 * guarantee, and impossible to debug from the symptom.
 */
function orientPositive(polygon: Vec2[]): Vec2[] {
  return signedArea(polygon) < 0 ? [...polygon].reverse() : polygon;
}

/** Whether every edge is axis-aligned, which is what the wall builder needs. */
export function roomIsRectilinear(polygon: Vec2[]): boolean {
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dx > 1e-9 && dy > 1e-9) return false;
  }
  return true;
}

type Span = { from: number; to: number };

/**
 * Remove the doorway spans from a wall run.
 *
 * Openings are stored as a point and a width rather than as a reference to an
 * edge, because in the editor a door is dropped roughly on a wall rather than
 * picked from a list. So each run asks which openings land on it, and
 * overlapping ones are merged before subtracting - two doors close together
 * must leave one gap, not two overlapping ones that cancel out.
 */
function subtractOpenings(
  span: Span,
  normal: Vec2,
  c: number,
  openings: Opening[],
): { solid: Span[]; doors: Span[] } {
  const holes: Span[] = [];
  const t = tangentOf(normal);

  for (const opening of openings) {
    // How far off this line the doorway sits, and where along it - the same two
    // questions as before, asked with a dot product instead of an axis index.
    const across = dot(normal, opening.at) - c;
    const along = dot(t, opening.at);
    if (Math.abs(across) > 0.3) continue;

    const from = Math.max(span.from, along - opening.width / 2);
    const to = Math.min(span.to, along + opening.width / 2);
    if (to > from) holes.push({ from, to });
  }

  if (holes.length === 0) return { solid: [span], doors: [] };

  holes.sort((a, b) => a.from - b.from);
  const merged: Span[] = [holes[0]];
  for (const hole of holes.slice(1)) {
    const last = merged[merged.length - 1];
    if (hole.from <= last.to) last.to = Math.max(last.to, hole.to);
    else merged.push(hole);
  }

  const solid: Span[] = [];
  let cursor = span.from;
  for (const hole of merged) {
    if (hole.from - cursor > 1e-4) solid.push({ from: cursor, to: hole.from });
    cursor = hole.to;
  }
  if (span.to - cursor > 1e-4) solid.push({ from: cursor, to: span.to });

  return { solid, doors: merged };
}

function toSolid(
  normal: Vec2,
  c: number,
  span: Span,
  thickness: number,
  base: number,
  height: number,
  exterior: boolean,
  header: boolean,
  outward: Vec2 | null,
): WallSolid {
  const t = tangentOf(normal);
  const mid = (span.from + span.to) / 2;
  /**
   * Back from line coordinates into the plan.
   *
   * A point on the wall is `c` along the normal plus `mid` along the tangent,
   * which for a horizontal line is exactly `[mid, at]` and for a vertical one
   * exactly `[at, mid]` - the two cases this replaces.
   */
  const center: Vec2 = [normal[0] * c + t[0] * mid, normal[1] * c + t[1] * mid];

  /**
   * The angle the box is turned through, folded into half a turn.
   *
   * `Model.tsx` builds the box along its local +x and rotates by this, which
   * sends +x to (cos, -sin) in plan - so the angle is read off the tangent with
   * y negated. Folding to [0, 180) matters rather than being tidy: `collide`
   * and the 2D plan both ask `abs(angleDeg) < 45` to decide whether a wall runs
   * along x, and an unfolded 180 would answer that wrongly for a wall that is
   * simply horizontal.
   */
  const raw = (Math.atan2(-t[1], t[0]) * 180) / Math.PI;
  const angleDeg = ((raw % 180) + 180) % 180;

  return {
    center,
    length: span.to - span.from,
    thickness,
    base,
    height,
    angleDeg: Math.abs(angleDeg - 180) < 1e-9 ? 0 : angleDeg,
    exterior,
    header,
    outward,
  };
}

/**
 * Wall solids for one storey.
 *
 * Interior walls sit centred on the shared edge; exterior walls are pushed
 * outward by half their thickness so a room keeps the internal dimensions it
 * was given. Without that offset every room would quietly lose 100mm on each
 * outside wall, and a plan scaled to a listing's square footage would no longer
 * match it.
 */
export function wallsForLevel(plan: Plan, level: number): WallSolid[] {
  const rooms = plan.rooms.filter((r) => r.level === level);
  if (rooms.length === 0) return [];

  const ceiling = Math.max(...rooms.map((r) => r.ceilingHeight), 2.4);
  const openings = plan.openings.filter((o) => {
    // Stairs are a way through a floor, not a hole in a wall.
    if (o.kind === "stairs") return false;
    return o.between.some((id) => rooms.some((r) => r.id === id));
  });

  const edges = rooms.flatMap(edgesOf);
  const solids: WallSolid[] = [];

  const emit = (
    normal: Vec2,
    c: number,
    span: Span,
    thickness: number,
    exterior: boolean,
    outward: Vec2 | null,
  ) => {
    if (span.to - span.from < 1e-3) return;

    // Carry each wall past its ends, far enough to fill the corner it turns.
    //
    // Two boxes meeting at a right angle leave the outer quadrant of the
    // corner empty - measured on the demo house, a 200mm square hole at every
    // corner of the building, which is what you see through when you orbit
    // past. A general mitred-polygon solver would fix it too, and would be a
    // great deal of machinery for plans that are axis-aligned rectangles by
    // construction.
    //
    // How far depends on where the wall sits relative to the room edge. An
    // interior wall straddles it, so half its thickness reaches the far face of
    // whatever it meets. An exterior wall is offset wholly outside it, so it
    // needs its full thickness to reach round the corner.
    // Only the outermost pieces are carried, and only after the doorways have
    // been taken out. Stretching the span first was the obvious order and the
    // wrong one: the extension is then something a doorway can be subtracted
    // from, so a door near the end of a wall left a 250mm stub floating beyond
    // it. Doorways keep their exact positions this way.
    const reach = exterior ? thickness : thickness / 2;
    const { solid: raw, doors } = subtractOpenings(span, normal, c, openings);

    // Slivers are dropped before anything is carried anywhere. Pairing at a
    // T-junction leaves fragments a few centimetres long; unextended they were
    // too small to see, and carrying one past its ends turns a 50mm artefact
    // into a 250mm wall standing where it does not belong.
    const solid = raw.filter((piece) => piece.to - piece.from > MIN_WALL_PIECE);

    // Carried at both ends, unconditionally - which is right for every shape
    // the app currently produces and will need revisiting for one it does not
    // yet.
    //
    // A rectangle has only outside corners, and at an outside corner the carry
    // fills a real void. An L-shaped room also has an *inside* corner, where
    // the two walls already meet and the extension reaches 50mm into the room
    // next door. Left as it is deliberately: nothing generates a non-rectangular
    // room yet, and the obvious guard - extend, then check whether the extension
    // landed inside a room - is unreliable exactly where it matters, because an
    // interior wall's centreline lies precisely on the boundary the test would
    // be asking about. Doing it properly means knowing whether the run's end is
    // a reflex vertex, which is a property of the wall graph rather than of a
    // single run, and belongs with the sweep that replaces the pairing loop.
    if (solid.length > 0) {
      solid[0] = { from: solid[0].from - reach, to: solid[0].to };
      const last = solid.length - 1;
      solid[last] = { from: solid[last].from, to: solid[last].to + reach };
    }

    for (const piece of solid) {
      solids.push(toSolid(normal, c, piece, thickness, 0, ceiling, exterior, false, outward));
    }
    // The wall above each doorway. Cheap, and the single thing that most makes
    // an opening look intentional.
    for (const door of doors) {
      solids.push(
        toSolid(normal, c, door, thickness, DOOR_HEIGHT, ceiling - DOOR_HEIGHT, exterior, true, outward),
      );
    }
  };

  /**
   * Resolve each line of the plan by sweeping it, rather than by pairing edges
   * off greedily.
   *
   * The loop this replaces took each edge in turn and matched it against the
   * first unused collinear edge facing the other way. That is correct when
   * walls meet one-to-one and quietly wrong the moment one does not: a long
   * wall facing two stacked rooms paired with the first of them, marked itself
   * used, and left the second with no partner at all. The result was the shared
   * wall emitted twice, as two *exterior* walls at 200mm offset either side of
   * the line - a doubled partition in the middle of the house, z-fighting with
   * itself, at the wrong thickness and carrying an outward normal that made the
   * dollhouse cull it. Nothing errored, and the packer produces this shape
   * whenever a two-room row backs onto a single larger room.
   *
   * Sweeping asks a different question. Every edge on a line contributes its
   * ends as breakpoints; each elementary interval between consecutive
   * breakpoints is then classified by how many rooms cover it and which way
   * they face. One room means outside, two facing each other means a partition,
   * and the answer cannot depend on the order the edges happened to arrive in.
   */
  /**
   * Grouped by direction first, then by offset within it.
   *
   * The direction bucket is quantised to a tenth of a degree, which is far finer
   * than any wall is drawn but coarse enough to absorb the float drift of
   * rotating a polygon. Within a direction, offsets are sorted and cut into runs
   * at `PAIR_TOLERANCE` exactly as before, so two edges a hair either side of a
   * boundary still meet.
   *
   * For an axis-aligned plan this reduces to what it replaced: every horizontal
   * edge folds to the same normal and lands in one bucket, every vertical edge
   * in the other, and the offsets are the old `at`. That equivalence is the
   * check that the generalisation did not change a square house.
   */
  const withBearing = edges
    .map((edge) => ({ edge, bearing: Math.atan2(edge.line.n[1], edge.line.n[0]) }))
    .sort((a, b) => a.bearing - b.bearing);

  const byDirection: Edge[][] = [];
  for (const { edge, bearing } of withBearing) {
    const last = byDirection[byDirection.length - 1];
    const lastBearing = last ? Math.atan2(last[0].line.n[1], last[0].line.n[0]) : 0;
    if (last && Math.abs(bearing - lastBearing) < DIRECTION_TOLERANCE) last.push(edge);
    else byDirection.push([edge]);
  }

  // The fold puts normals in a half turn, so the first and last groups can be a
  // hair either side of the seam and be the same direction. Nothing else joins
  // them, and leaving them apart splits one wall of a rotated house in two.
  if (byDirection.length > 1) {
    const first = byDirection[0];
    const last = byDirection[byDirection.length - 1];
    const a = Math.atan2(first[0].line.n[1], first[0].line.n[0]);
    const z = Math.atan2(last[0].line.n[1], last[0].line.n[0]);
    if (Math.abs(a + Math.PI - z) < DIRECTION_TOLERANCE) {
      // Bring them onto one normal before merging, or their offsets disagree
      // in sign and the run merge cannot see that they line up.
      for (const edge of last) {
        edge.line = { n: [-edge.line.n[0], -edge.line.n[1]], c: -edge.line.c };
        const swapped = -edge.from;
        edge.from = -edge.to;
        edge.to = swapped;
        edge.outward = edge.outward === 1 ? -1 : 1;
      }
      first.push(...last);
      byDirection.pop();
    }
  }

  for (const bucket of byDirection) {
    const sorted = [...bucket].sort((a, b) => a.line.c - b.line.c);
    let cluster: Edge[] = [];

    const flush = () => {
      if (cluster.length === 0) return;
      resolveLine(cluster);
      cluster = [];
    };

    for (const edge of sorted) {
      const last = cluster[cluster.length - 1];
      if (last && edge.line.c - last.line.c > PAIR_TOLERANCE) flush();
      cluster.push(edge);
    }
    flush();
  }

  return solids;

  /** One collinear line's worth of edges, swept end to end. */
  function resolveLine(line: Edge[]) {
    // Every edge in a cluster shares a direction; the normal of the first is
    // the line's, and the offsets are averaged where they are used.
    const normal = line[0].line.n;
    const cuts = [...new Set(line.flatMap((e) => [e.from, e.to]))].sort((a, b) => a - b);

    type Interval = {
      from: number;
      to: number;
      /** Offset of this stretch along the line's normal. */
      c: number;
      thickness: number;
      exterior: boolean;
      outward: Vec2 | null;
    };
    const intervals: Interval[] = [];

    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      if (to - from < 1e-9) continue;
      const mid = (from + to) / 2;

      const covering = line.filter((e) => e.from <= mid && e.to >= mid);
      if (covering.length === 0) continue;

      const facingA = covering.filter((e) => e.outward === 1);
      const facingB = covering.filter((e) => e.outward === -1);
      const rooms = new Set(covering.map((e) => e.roomId));

      // A partition: rooms on both sides of this stretch, facing each other.
      //
      // The length test keeps the old pairing rule's intent. Two rooms that
      // graze each other for a few centimetres are not sharing a wall, and
      // treating them as if they were splits a long exterior run into three
      // pieces, each of which then gets its own corner carry - which is how a
      // 50mm artefact becomes a 250mm wall standing where it does not belong.
      if (facingA.length > 0 && facingB.length > 0 && rooms.size > 1 && to - from >= 0.2) {
        const c = covering.reduce((sum, e) => sum + e.line.c, 0) / covering.length;
        intervals.push({ from, to, c, thickness: INTERIOR_THICKNESS, exterior: false, outward: null });
        continue;
      }

      // Otherwise every covering edge is a face of the building. Usually one;
      // two only when rooms coincide back to back without facing, which is a
      // genuine pair of exterior walls rather than a partition.
      for (const edge of covering) {
        intervals.push({
          from,
          to,
          // Offset wholly outside the room, along the line's own normal, so the
          // room keeps the internal dimensions it was drawn with.
          c: edge.line.c + edge.outward * (EXTERIOR_THICKNESS / 2),
          thickness: EXTERIOR_THICKNESS,
          exterior: true,
          outward: [normal[0] * edge.outward, normal[1] * edge.outward],
        });
      }
    }

    // Merge back into runs before emitting.
    //
    // Not cosmetic: `emit` carries each run past its own ends to fill the
    // corner it turns, so emitting per elementary interval would carry every
    // internal breakpoint as though it were a corner and stud the wall with
    // overlapping stubs.
    /**
     * Whether two stretches are the same wall carrying on.
     *
     * Every comparison here is approximate, and the outward normal is the one
     * that matters. It used to be tested with `===`, which is exactly right for
     * an axis-aligned plan - the normals are literally [0,1] and [1,0] - and
     * wrong for anything else, because each edge normalises its own direction
     * and two collinear edges land a few float bits apart. The wall then failed
     * to merge, split into two runs, and each run took a corner carry it had
     * not earned: a ten-metre wall came back as two five-metre ones totalling
     * ten metres eighty.
     */
    const sameRun = (a: Interval, b: Interval) =>
      Math.abs(a.c - b.c) < SAME_LINE &&
      Math.abs(a.thickness - b.thickness) < 1e-9 &&
      a.exterior === b.exterior &&
      ((a.outward === null && b.outward === null) ||
        (a.outward !== null &&
          b.outward !== null &&
          Math.abs(a.outward[0] - b.outward[0]) < SAME_LINE &&
          Math.abs(a.outward[1] - b.outward[1]) < SAME_LINE));

    const runs: Interval[] = [];
    /**
     * Ordered along the wall, and *then* by offset - with the offset compared
     * to the same tolerance every other test here uses.
     *
     * This was `x.c - y.c || x.from - y.from`, and the `||` is the whole bug. It
     * falls through to position only when two offsets are *exactly* equal,
     * which they are for an axis-aligned plan whose coordinates are whole
     * numbers of feet. Turn the house seven degrees and the same offsets differ
     * in their last few bits, so the comparator sorted by that noise instead -
     * and since the merge below only ever looks at the run immediately before
     * it, stretches that were adjacent arrived out of order and never joined. A
     * ten-metre wall came back as two five-metre ones, each having taken a
     * corner carry it had not earned.
     */
    const order = [...intervals].sort(
      (x, y) => (Math.abs(x.c - y.c) < SAME_LINE ? 0 : x.c - y.c) || x.from - y.from,
    );
    for (const interval of order) {
      const last = runs[runs.length - 1];
      if (last && sameRun(last, interval) && Math.abs(last.to - interval.from) < SAME_LINE) {
        last.to = interval.to;
      } else {
        runs.push({ ...interval });
      }
    }

    for (const run of runs) {
      emit(normal, run.c, { from: run.from, to: run.to }, run.thickness, run.exterior, run.outward);
    }
  }

}

/** Exterior wall runs, for deciding where windows go. */
export function exteriorRuns(plan: Plan, level: number): WallSolid[] {
  return wallsForLevel(plan, level).filter((w) => w.exterior && !w.header);
}
