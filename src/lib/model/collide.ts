import { boundsOf } from "@/lib/plan/autolayout";
import { levelBase } from "@/lib/plan/geometry";
import { roomKind } from "@/lib/plan/room-kind";
import type { Plan, Vec2 } from "@/lib/schema";
import { wallsForLevel } from "@/lib/model/walls";

/**
 * What stops you walking through a wall.
 *
 * Derived from the same wall solids the renderer draws, which is the point: a
 * collider built from a second description of the house would drift from it,
 * and the failure - walking through a wall that is visibly there - is the most
 * obviously broken thing a first-person view can do.
 */

/** Shoulder radius, so you stop a little short of a surface rather than in it. */
export const WALKER_RADIUS = 0.28;

/** Eye height for an average adult. */
export const EYE_HEIGHT = 1.62;

export type Collider = { x0: number; y0: number; x1: number; y1: number };

/**
 * Blocking rectangles for a storey, in plan space.
 *
 * Headers are skipped: the piece above a doorway is a wall in the model and a
 * gap to walk through in practice, and treating it as solid would seal every
 * door in the house.
 */
export function collidersFor(plan: Plan, level: number): Collider[] {
  const out: Collider[] = [];

  for (const wall of wallsForLevel(plan, level)) {
    // Anything starting above knee height is something you walk under.
    if (wall.header || wall.base > 0.4) continue;

    const alongX = Math.abs(wall.angleDeg) < 45;
    const halfW = (alongX ? wall.length : wall.thickness) / 2;
    const halfD = (alongX ? wall.thickness : wall.length) / 2;

    out.push({
      x0: wall.center[0] - halfW,
      y0: wall.center[1] - halfD,
      x1: wall.center[0] + halfW,
      y1: wall.center[1] + halfD,
    });
  }
  return out;
}

/** Would a walker of the given radius overlap anything solid here? */
export function blocked(colliders: Collider[], x: number, y: number, radius = WALKER_RADIUS): boolean {
  for (const c of colliders) {
    if (x > c.x0 - radius && x < c.x1 + radius && y > c.y0 - radius && y < c.y1 + radius) {
      return true;
    }
  }
  return false;
}

/**
 * Slide along a wall rather than stopping dead against it.
 *
 * Walking into a wall at an angle and halting completely is the thing that
 * makes a first-person view feel like a prototype. Trying each axis separately
 * means a glancing approach keeps whichever component of the movement is still
 * legal, which reads as sliding along the surface.
 */
export function moveWithSliding(
  colliders: Collider[],
  from: Vec2,
  dx: number,
  dy: number,
  radius = WALKER_RADIUS,
): Vec2 {
  let [x, y] = from;
  if (!blocked(colliders, x + dx, y, radius)) x += dx;
  if (!blocked(colliders, x, y + dy, radius)) y += dy;
  return [x, y];
}

/** The room containing a point on a storey, if any. */
export function roomAt(plan: Plan, level: number, x: number, y: number) {
  return plan.rooms.find((room) => {
    if (room.level !== level) return false;
    const b = boundsOf(room.polygon);
    return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  });
}

/**
 * Height underfoot, and which storey that puts you on.
 *
 * Standing in a stairwell the floor is a ramp, so the height is interpolated
 * along the stair room's longer axis and the storey flips at the halfway
 * point. It is not a staircase with treads - it is a slope where a staircase
 * is - but it climbs continuously, which is what stops the transition between
 * floors reading as a teleport.
 */
export function groundAt(
  plan: Plan,
  level: number,
  x: number,
  y: number,
): { height: number; level: number } {
  const here = roomAt(plan, level, x, y);
  const base = levelBase(plan, level);

  if (!here || roomKind(here.label) !== "stairs") return { height: base, level };

  // Is there a stairwell directly above this one? If not, there is nowhere to
  // climb to and the floor is flat.
  const above = plan.rooms.find(
    (r) => r.level === level + 1 && roomKind(r.label) === "stairs" && overlaps(r, here),
  );
  if (!above) return { height: base, level };

  const b = boundsOf(here.polygon);
  const alongX = b.x1 - b.x0 >= b.y1 - b.y0;
  const t = alongX ? (x - b.x0) / (b.x1 - b.x0) : (y - b.y0) / (b.y1 - b.y0);
  const clamped = Math.max(0, Math.min(1, t));

  const upper = levelBase(plan, level + 1);
  return {
    height: base + (upper - base) * clamped,
    // Past halfway you are on the storey above, so its walls start blocking
    // and its rooms are what you are standing in.
    level: clamped > 0.5 ? level + 1 : level,
  };
}

function overlaps(a: { polygon: Vec2[] }, b: { polygon: Vec2[] }): boolean {
  const p = boundsOf(a.polygon);
  const q = boundsOf(b.polygon);
  return p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;
}

/** A sensible place to start walking: the middle of the largest ground room. */
export function startingPoint(plan: Plan, level: number): Vec2 {
  const rooms = plan.rooms.filter((r) => r.level === level);
  if (rooms.length === 0) return [0, 0];

  const best = rooms
    .filter((r) => roomKind(r.label) !== "outside" && roomKind(r.label) !== "garage")
    .concat(rooms)
    .map((room) => {
      const b = boundsOf(room.polygon);
      return { room, area: (b.x1 - b.x0) * (b.y1 - b.y0), b };
    })
    .sort((a, z) => z.area - a.area)[0];

  return [(best.b.x0 + best.b.x1) / 2, (best.b.y0 + best.b.y1) / 2];
}
