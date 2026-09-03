import { EXTERIOR_THICKNESS, INTERIOR_THICKNESS } from "@/lib/model/walls";

import { boundsOf, dist, wallSegmentsForRoom, signedArea } from "@/lib/plan/geometry";
import type { Plan, Room, Vec2 } from "@/lib/schema";
import type { ModelWindow } from "@/lib/model/windows";

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
 * One room's walls as it sees them from inside: thin panels, on foot.
 *
 * Assembled, a wall is one merged solid per storey in the house's colour,
 * which is right for nearly every wall in nearly every house and wrong for
 * the one the photograph showed as brick. The reader returns a wall's
 * material and its colour per room; until now both reached a mesh only when
 * the house was pulled apart, because the room's own walls were built only
 * then. So a room whose walls are not the house's paint wears a skin of them:
 * a panel a finger thick, its face just proud of the partition's, following
 * the same door-cut segments the exploded shell uses.
 *
 * Windows are cut out too, or a brick wall would cover its own glass from
 * inside. A panel is split at each window into the band below the sill and
 * the band above the head - the same three pieces `wallPiecesAround` makes
 * for the exterior solid.
 */
export function wallSkins(plan: Plan, room: Room, windows: ModelWindow[]): ShellBox[] {
  const SKIN = 0.012;
  // Just proud of the partition's inner face. The exterior shell sits outside
  // the polygon, so this clears it by construction.
  const INSET = INTERIOR_THICKNESS / 2 + 0.005;
  const height = room.ceilingHeight;
  // Shoelace sign: positive is counter-clockwise, whose interior is to the
  // left of each edge. The left normal of (dx, dy) is (-dy, dx).
  const inward = Math.sign(signedArea(room.polygon)) || 1;
  const out: ShellBox[] = [];

  for (const seg of wallSegmentsForRoom(room, plan.openings)) {
    const length = dist(seg.a, seg.b);
    if (length < 0.05) continue;
    const dx = (seg.b[0] - seg.a[0]) / length;
    const dy = (seg.b[1] - seg.a[1]) / length;
    const nx = -dy * inward;
    const ny = dx * inward;
    const shift = INSET + SKIN / 2;
    const alongX = Math.abs(dx) >= Math.abs(dy);

    const emit = (t0: number, t1: number, y0: number, y1: number) => {
      if (t1 - t0 < 0.02 || y1 - y0 < 0.02) return;
      const mid = (t0 + t1) / 2;
      out.push({
        center: [seg.a[0] + dx * mid + nx * shift, (y0 + y1) / 2, seg.a[1] + dy * mid + ny * shift],
        size: alongX ? [t1 - t0, y1 - y0, SKIN] : [SKIN, y1 - y0, t1 - t0],
      });
    };

    // Windows on this wall, as spans along it.
    const cuts = windows
      .filter((w) => pointToSegment(w.center, seg.a, seg.b) < 0.15)
      .map((w) => {
        const t = (w.center[0] - seg.a[0]) * dx + (w.center[1] - seg.a[1]) * dy;
        return { from: t - w.width / 2, to: t + w.width / 2, sill: w.sill, head: w.head };
      })
      .sort((a, b) => a.from - b.from);

    let cursor = 0;
    for (const cut of cuts) {
      const from = Math.max(cursor, cut.from);
      const to = Math.min(length, cut.to);
      emit(cursor, from, 0, height);
      emit(from, to, 0, cut.sill);
      emit(from, to, cut.head, height);
      cursor = Math.max(cursor, to);
    }
    emit(cursor, length, 0, height);
  }
  return out;
}

function pointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
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
