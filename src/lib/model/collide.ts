import { boundsOf } from "@/lib/plan/autolayout";
import { levelBase, pointInPolygon } from "@/lib/plan/geometry";
import { roomKind } from "@/lib/plan/room-kind";
import type { Plan, Vec2 } from "@/lib/schema";
import { heightAt, levelForHeight, runsAtLevel } from "@/lib/model/stairs";
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

/**
 * A wall to bump into, as a box that knows which way it is turned.
 *
 * This used to be an axis-aligned rectangle, which is exact for a wall running
 * along x or y and badly wrong for one at any other angle: the bounding box of a
 * four-metre wall at 45 degrees is nearly three metres square, so it seals the
 * doorways either side of it and blocks open floor a metre away. Storing the
 * turn instead costs two numbers and a rotation in the test.
 */
export type Collider = {
  center: Vec2;
  /** Half its length along the wall, and half its thickness across. */
  halfLength: number;
  halfThickness: number;
  /** The wall's own direction, precomputed so the test does no trigonometry. */
  cos: number;
  sin: number;
};

/**
 * Blocking boxes for a storey, in plan space.
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

    // The same convention the renderer uses: a box built along its local +x and
    // turned by `angleDeg`, which sends +x to (cos, -sin) in plan.
    const r = (wall.angleDeg * Math.PI) / 180;
    out.push({
      center: wall.center,
      halfLength: wall.length / 2,
      halfThickness: wall.thickness / 2,
      cos: Math.cos(r),
      sin: -Math.sin(r),
    });
  }
  return out;
}

/**
 * Would a walker of the given radius overlap anything solid here?
 *
 * The point is moved into each wall's own frame and tested against two
 * intervals - which for an axis-aligned wall is arithmetically the same test as
 * before, and for any other wall is the one that was meant all along.
 */
export function blocked(colliders: Collider[], x: number, y: number, radius = WALKER_RADIUS): boolean {
  for (const c of colliders) {
    const dx = x - c.center[0];
    const dy = y - c.center[1];
    const along = dx * c.cos + dy * c.sin;
    const across = -dx * c.sin + dy * c.cos;
    if (
      Math.abs(along) < c.halfLength + radius &&
      Math.abs(across) < c.halfThickness + radius
    ) {
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
  // Point-in-polygon rather than a bounds test. On a rectangle the two agree
  // exactly; on an L-shaped room the bounds test says you are in the room while
  // you are standing in its neighbour's half of the notch, which is the sort of
  // wrong that shows up as the scope rail naming the room next door.
  return plan.rooms.find(
    (room) => room.level === level && pointInPolygon([x, y], room.polygon),
  );
}

/**
 * Height underfoot, and which storey that puts you on.
 *
 * All of the geometry now lives in `stairs.ts`; this only asks it. That matters
 * more than it looks: this function used to interpolate a ramp of its own, so
 * the moment real treads were drawn there were two descriptions of the same
 * staircase and nothing to keep them in step. The failure that produces is
 * invisible - the stair looks right and your feet are somewhere else.
 *
 * `fromHeight` is where the walker's feet are now. With one staircase it
 * changes nothing; on the middle storey of a three-storey house, where the
 * flight up and the flight down share a footprint, it is what tells climbing
 * from descending without keeping any extra state.
 */
export function groundAt(
  plan: Plan,
  level: number,
  x: number,
  y: number,
  fromHeight?: number,
): { height: number; level: number } {
  const here = roomAt(plan, level, x, y);
  const base = levelBase(plan, level);
  if (!here || roomKind(here.label) !== "stairs") return { height: base, level };

  const { up, down } = runsAtLevel(plan, level);
  const candidates: number[] = [];
  for (const run of [up, down]) {
    if (!run) continue;
    const h = heightAt(run, x, y);
    if (h !== null) candidates.push(h);
  }

  // A stairwell with nothing stacked on it is simply a landing.
  if (candidates.length === 0) return { height: base, level };

  const feet = fromHeight ?? base;
  const height = candidates.reduce((best, h) =>
    Math.abs(h - feet) < Math.abs(best - feet) ? h : best,
  );

  return { height, level: levelForHeight(plan, height) };
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
