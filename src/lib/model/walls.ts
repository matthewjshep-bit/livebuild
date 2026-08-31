import { boundsOf } from "@/lib/plan/autolayout";
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

type Edge = {
  roomId: string;
  /** 0 = the edge runs along x (a horizontal wall), 1 = along y. */
  axis: 0 | 1;
  /** Position on the perpendicular axis. */
  at: number;
  /** Span along the edge's own axis. */
  from: number;
  to: number;
  /** Which way is out of the room, as -1 or +1 on the perpendicular axis. */
  outward: -1 | 1;
};

/**
 * The room's own edges, walked rather than assumed.
 *
 * This used to return the four sides of the bounding box, which was right for
 * as long as every room was a rectangle. An L-shaped room built that way gets
 * walls straight across its own notch and a floor spilling out past them, and
 * nothing errors - it just quietly builds the wrong house.
 *
 * Still rectilinear: every edge has to be axis-aligned, because the pairing
 * below groups collinear segments by axis and coordinate rather than solving
 * general intersections. A diagonal edge is dropped rather than mangled, and
 * `roomIsRectilinear` is what stops one being introduced upstream.
 */
function edgesOf(room: Room): Edge[] {
  const poly = orientPositive(room.polygon);
  const edges: Edge[] = [];

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];

    // The outward normal of a→b on a positively-wound polygon is (dy, -dx).
    // On an axis-aligned edge exactly one component survives, which is what
    // `axis` and `outward` between them encode.
    if (Math.abs(dy) < 1e-9 && Math.abs(dx) > 1e-9) {
      edges.push({
        roomId: room.id,
        axis: 0,
        at: a[1],
        from: Math.min(a[0], b[0]),
        to: Math.max(a[0], b[0]),
        outward: dx > 0 ? -1 : 1,
      });
    } else if (Math.abs(dx) < 1e-9 && Math.abs(dy) > 1e-9) {
      edges.push({
        roomId: room.id,
        axis: 1,
        at: a[0],
        from: Math.min(a[1], b[1]),
        to: Math.max(a[1], b[1]),
        outward: dy > 0 ? 1 : -1,
      });
    }
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
  axis: 0 | 1,
  at: number,
  openings: Opening[],
): { solid: Span[]; doors: Span[] } {
  const holes: Span[] = [];

  for (const opening of openings) {
    const across = axis === 0 ? opening.at[1] : opening.at[0];
    const along = axis === 0 ? opening.at[0] : opening.at[1];
    if (Math.abs(across - at) > 0.3) continue;

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
  axis: 0 | 1,
  at: number,
  span: Span,
  thickness: number,
  base: number,
  height: number,
  exterior: boolean,
  header: boolean,
  outward: Vec2 | null,
): WallSolid {
  const mid = (span.from + span.to) / 2;
  return {
    center: axis === 0 ? [mid, at] : [at, mid],
    length: span.to - span.from,
    thickness,
    base,
    height,
    angleDeg: axis === 0 ? 0 : 90,
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
    axis: 0 | 1,
    at: number,
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
    const { solid: raw, doors } = subtractOpenings(span, axis, at, openings);

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
      solids.push(toSolid(axis, at, piece, thickness, 0, ceiling, exterior, false, outward));
    }
    // The wall above each doorway. Cheap, and the single thing that most makes
    // an opening look intentional.
    for (const door of doors) {
      solids.push(
        toSolid(axis, at, door, thickness, DOOR_HEIGHT, ceiling - DOOR_HEIGHT, exterior, true, outward),
      );
    }
  };

  const normalOf = (axis: 0 | 1, outward: -1 | 1): Vec2 =>
    axis === 0 ? [0, outward] : [outward, 0];

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
  const byAxis: Record<0 | 1, Edge[]> = { 0: [], 1: [] };
  for (const edge of edges) byAxis[edge.axis].push(edge);

  for (const axis of [0, 1] as const) {
    // Cluster collinear edges, allowing for the float drift `distribute` leaves
    // behind. Sorting first means a cluster is a run of neighbours rather than
    // a quantised bucket, so two edges a hair either side of a boundary still
    // meet.
    const sorted = [...byAxis[axis]].sort((a, b) => a.at - b.at);
    let cluster: Edge[] = [];

    const flush = () => {
      if (cluster.length === 0) return;
      resolveLine(axis, cluster);
      cluster = [];
    };

    for (const edge of sorted) {
      if (cluster.length > 0 && edge.at - cluster[cluster.length - 1].at > PAIR_TOLERANCE) flush();
      cluster.push(edge);
    }
    flush();
  }

  return solids;

  /** One collinear line's worth of edges, swept end to end. */
  function resolveLine(axis: 0 | 1, line: Edge[]) {
    const cuts = [...new Set(line.flatMap((e) => [e.from, e.to]))].sort((a, b) => a - b);

    type Interval = {
      from: number;
      to: number;
      at: number;
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
        const at = covering.reduce((sum, e) => sum + e.at, 0) / covering.length;
        intervals.push({ from, to, at, thickness: INTERIOR_THICKNESS, exterior: false, outward: null });
        continue;
      }

      // Otherwise every covering edge is a face of the building. Usually one;
      // two only when rooms coincide back to back without facing, which is a
      // genuine pair of exterior walls rather than a partition.
      for (const edge of covering) {
        intervals.push({
          from,
          to,
          at: edge.at + edge.outward * (EXTERIOR_THICKNESS / 2),
          thickness: EXTERIOR_THICKNESS,
          exterior: true,
          outward: normalOf(axis, edge.outward),
        });
      }
    }

    // Merge back into runs before emitting.
    //
    // Not cosmetic: `emit` carries each run past its own ends to fill the
    // corner it turns, so emitting per elementary interval would carry every
    // internal breakpoint as though it were a corner and stud the wall with
    // overlapping stubs.
    const sameRun = (a: Interval, b: Interval) =>
      Math.abs(a.at - b.at) < 1e-6 &&
      a.thickness === b.thickness &&
      a.exterior === b.exterior &&
      ((a.outward === null && b.outward === null) ||
        (a.outward !== null &&
          b.outward !== null &&
          a.outward[0] === b.outward[0] &&
          a.outward[1] === b.outward[1]));

    const runs: Interval[] = [];
    for (const interval of intervals.sort((x, y) => x.at - y.at || x.from - y.from)) {
      const last = runs[runs.length - 1];
      if (last && sameRun(last, interval) && Math.abs(last.to - interval.from) < 1e-6) {
        last.to = interval.to;
      } else {
        runs.push({ ...interval });
      }
    }

    for (const run of runs) {
      emit(axis, run.at, { from: run.from, to: run.to }, run.thickness, run.exterior, run.outward);
    }
  }

}

/** Exterior wall runs, for deciding where windows go. */
export function exteriorRuns(plan: Plan, level: number): WallSolid[] {
  return wallsForLevel(plan, level).filter((w) => w.exterior && !w.header);
}
