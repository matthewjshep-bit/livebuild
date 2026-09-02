import { EXTERIOR_THICKNESS } from "@/lib/model/walls";

import { boundsOf, dist, wallSegmentsForRoom } from "@/lib/plan/geometry";
import type { Plan, Room, Vec2 } from "@/lib/schema";

/**
 * One room's own four walls, for the exploded view.
 *
 * Assembled, a wall between two rooms is emitted once and belongs to both -
 * that is what `walls.ts` exists to do, and it is why the dollhouse does not
 * have paper-thin doubled partitions. Pulled apart, that is exactly wrong: a
 * room lifted out of the house has to bring its own enclosure with it, or it
 * leaves its walls behind and arrives as a floating carpet.
 *
 * So an exploded room is built from `wallSegmentsForRoom`, which is per-room by
 * construction and already has the doorways subtracted. This is not a
 * workaround for the wall graph: an exploded assembly drawing shows each part
 * complete in itself, and a room is only a part once it is separable.
 */

export type ShellBox = {
  /** Centre in plan metres, and height above the storey floor. */
  center: [number, number, number];
  size: [number, number, number];
};

/**
 * Wall boxes for one room, in plan coordinates.
 *
 * Segments run along the room's own polygon, so the wall sits inside the room's
 * stated dimensions rather than offset outward as an exterior wall would be.
 * At the scale this is looked at that is invisible, and it keeps every room's
 * shell exactly its own footprint - which is what makes the pieces read as
 * having been lifted out of the whole.
 */
export function roomShell(plan: Plan, room: Room): ShellBox[] {
  const height = room.ceilingHeight;
  const t = EXTERIOR_THICKNESS;

  return wallSegmentsForRoom(room, plan.openings)
    .filter((seg) => dist(seg.a, seg.b) > 0.05)
    .map((seg) => {
      const alongX = Math.abs(seg.b[0] - seg.a[0]) >= Math.abs(seg.b[1] - seg.a[1]);
      const length = dist(seg.a, seg.b);
      return {
        center: [
          (seg.a[0] + seg.b[0]) / 2,
          height / 2,
          (seg.a[1] + seg.b[1]) / 2,
        ] as [number, number, number],
        size: (alongX ? [length, height, t] : [t, height, length]) as [number, number, number],
      };
    });
}

/**
 * How far each room moves when the house comes apart.
 *
 * The house is dilated about its own centre: every room is pushed outward in
 * proportion to how far out it already is. That is what an exploded assembly
 * drawing does, and it is the only version of this that *guarantees* the parts
 * separate - a uniform outward shove does not, because two rooms lying in the
 * same direction from the centre travel together and stay touching. Measured on
 * the demo house, that left two pairs still overlapping at full extension.
 *
 * A scaling has a fixed point, so a room sitting on the centre is the anchor
 * everything else opens away from. That is the honest behaviour rather than a
 * flaw: something has to stay still for the movement to read as opening out.
 */
export function explodeOffset(plan: Plan, room: Room, amount: number): [number, number] {
  if (amount <= 0) return [0, 0];

  const all = boundsOf(plan.rooms.flatMap((r) => r.polygon));
  const cx = (all.x0 + all.x1) / 2;
  const cy = (all.y0 + all.y1) / 2;

  const b = boundsOf(room.polygon);
  const k = 0.9 * amount;
  return [((b.x0 + b.x1) / 2 - cx) * k, ((b.y0 + b.y1) / 2 - cy) * k];
}

/** How far a storey lifts, so the floors separate as the rooms fan out. */
export function explodeLift(level: number, amount: number): number {
  return level * amount * 3;
}

/** The centre of a room, for placing a label that has to travel with it. */
export function roomCentre(room: Room): Vec2 {
  const b = boundsOf(room.polygon);
  return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
}
