import { boundsOf } from "@/lib/plan/autolayout";
import { interiorPoint } from "@/lib/model/tessellate";
import { levelBase } from "@/lib/plan/geometry";
import { blocked, collidersFor, startingPoint } from "@/lib/model/collide";
import { roomCentre } from "@/lib/model/room-shell";
import type { Plan, Room, Vec2 } from "@/lib/schema";

/**
 * One room, looked at on its own.
 *
 * The dollhouse answers "what is this house", which is the right first
 * question and the wrong second one. Standing on a property the question is
 * "what about that room" - and until now the only way to ask it was to squint
 * at a whole-house view and read a highlighted row in a list.
 *
 * Kept pure and apart from the viewer so the two things most likely to be
 * silently wrong - where the camera ends up, and where a walker lands - can be
 * checked without a browser.
 */

/** Where the camera sits and what it looks at, in the dollhouse's own terms. */
export type RoomFraming = {
  /** What to orbit: the middle of the room, a little above its floor. */
  center: [number, number, number];
  /** How far back to stand, and how high. Azimuth is the caller's to keep. */
  distance: number;
  elevation: number;
};

/**
 * Close enough that a small room does not put the camera inside its own walls.
 *
 * A three-foot closet framed proportionally would seat the lens in the
 * plasterboard, and the near clip plane would then eat the room.
 */
const MIN_FRAMING_M = 4.5;

/**
 * Frame a single room.
 *
 * The geometry is lifted from the scripted tour's room beats, which have
 * answered this exact question since the tour could write itself: far enough
 * out that the room fills the frame, high enough to see over its own walls.
 * Worth noting that the elevation that falls out of those beats - about 0.67
 * radians - is within a degree of the dollhouse's own, so flying from the whole
 * house to one room changes distance and centre without tilting, which is what
 * makes it read as moving closer rather than as cutting to another shot.
 */
export function frameRoom(plan: Plan, room: Room): RoomFraming {
  const b = boundsOf(room.polygon);
  const reach = Math.max(b.x1 - b.x0, b.y1 - b.y0, 1);
  const base = levelBase(plan, room.level);
  const inside = interiorPoint(room.polygon);

  return {
    // The room's own centre. A bounding-box centre sits in an L-shaped room's
    // notch, so the camera orbits a point in the room next door.
    center: [inside[0], base + 0.9, inside[1]],
    distance: Math.max(reach * 1.55, MIN_FRAMING_M),
    elevation: 0.67,
  };
}

/** Where a walker dropped into this room should stand, and which way to face. */
export type WalkStart = {
  position: Vec2;
  level: number;
  /** Three.js camera yaw, radians about Y. */
  yaw: number;
};

/**
 * Yaw that points the camera along a plan-space direction.
 *
 * The camera looks down its own -Z and plan +y is world +z, so a heading of
 * `atan2(-dx, -dy)` is what turns it to face `(dx, dy)`. Written out because
 * getting it half a turn wrong puts the walker's back to the room and looks
 * like the drop point is inside a wall.
 */
function yawTowards(dx: number, dy: number): number {
  return Math.atan2(-dx, -dy);
}

/**
 * Stand in the middle of a room, looking down its length.
 *
 * Along the longest axis rather than at the centroid, because arriving nose-to
 * -wall in a narrow room is the one outcome that reads as a bug. A room is a
 * rectangle in practice, but the schema allows any polygon and its bounding-box
 * centre can then fall outside the room or inside a wall - so the centre is
 * tested against the same colliders the walker uses, and a blocked one gives
 * way to the storey's ordinary starting point rather than dropping somebody
 * into masonry.
 */
export function walkStartFor(plan: Plan, room: Room): WalkStart {
  const b = boundsOf(room.polygon);
  const centre = roomCentre(room);
  const wide = b.x1 - b.x0 >= b.y1 - b.y0;
  const yaw = wide ? yawTowards(1, 0) : yawTowards(0, 1);

  const colliders = collidersFor(plan, room.level);
  const position = blocked(colliders, centre[0], centre[1])
    ? startingPoint(plan, room.level)
    : centre;

  return { position, level: room.level, yaw };
}
