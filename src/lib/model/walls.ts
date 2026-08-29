import { boundsOf } from "@/lib/plan/autolayout";
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

function edgesOf(room: Room): Edge[] {
  const b = boundsOf(room.polygon);
  return [
    { roomId: room.id, axis: 0, at: b.y0, from: b.x0, to: b.x1, outward: -1 },
    { roomId: room.id, axis: 0, at: b.y1, from: b.x0, to: b.x1, outward: 1 },
    { roomId: room.id, axis: 1, at: b.x0, from: b.y0, to: b.y1, outward: -1 },
    { roomId: room.id, axis: 1, at: b.x1, from: b.y0, to: b.y1, outward: 1 },
  ];
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
  const used = new Set<number>();
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

  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    const edge = edges[i];

    // A partner is a collinear edge from another room facing the other way -
    // the two sides of one shared wall.
    let partner = -1;
    for (let j = i + 1; j < edges.length; j++) {
      if (used.has(j)) continue;
      const other = edges[j];
      if (other.axis !== edge.axis) continue;
      if (other.roomId === edge.roomId) continue;
      if (Math.abs(other.at - edge.at) > PAIR_TOLERANCE) continue;
      if (Math.min(edge.to, other.to) - Math.max(edge.from, other.from) < 0.2) continue;
      partner = j;
      break;
    }

    if (partner >= 0) {
      const other = edges[partner];
      used.add(i);
      used.add(partner);
      const at = (edge.at + other.at) / 2;

      // The shared run is emitted once; anything either room has beyond the
      // overlap is still its own exterior wall.
      const overlap: Span = {
        from: Math.max(edge.from, other.from),
        to: Math.min(edge.to, other.to),
      };
      emit(edge.axis, at, overlap, INTERIOR_THICKNESS, false, null);

      for (const side of [edge, other]) {
        if (side.from < overlap.from - 1e-3) {
          emit(side.axis, at + side.outward * (EXTERIOR_THICKNESS / 2),
            { from: side.from, to: overlap.from }, EXTERIOR_THICKNESS, true,
            normalOf(side.axis, side.outward));
        }
        if (side.to > overlap.to + 1e-3) {
          emit(side.axis, at + side.outward * (EXTERIOR_THICKNESS / 2),
            { from: overlap.to, to: side.to }, EXTERIOR_THICKNESS, true,
            normalOf(side.axis, side.outward));
        }
      }
      continue;
    }

    used.add(i);
    emit(
      edge.axis,
      edge.at + edge.outward * (EXTERIOR_THICKNESS / 2),
      { from: edge.from, to: edge.to },
      EXTERIOR_THICKNESS,
      true,
      normalOf(edge.axis, edge.outward),
    );
  }

  return solids;
}

/** Exterior wall runs, for deciding where windows go. */
export function exteriorRuns(plan: Plan, level: number): WallSolid[] {
  return wallsForLevel(plan, level).filter((w) => w.exterior && !w.header);
}
