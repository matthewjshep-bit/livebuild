import { DOOR_HEIGHT } from "@/lib/model/walls";
import { HEAD_HEIGHT, SILL_HEIGHT, windowsForLevel } from "@/lib/model/windows";

import { area, boundsOf, dist, wallSegmentsForRoom } from "@/lib/plan/geometry";
import { type RoomKind, roomKind } from "@/lib/plan/room-kind";
import type { Plan, Room } from "@/lib/schema";
import { M_PER_FT } from "@/lib/units";

/**
 * Quantity takeoff, per room, from the model.
 *
 * This is the step that makes a bill of materials possible at all. A PLM tool
 * derives its quantities from CAD; there is no CAD here, but the model built
 * from the plan carries the same information - how much floor, how much wall,
 * how many doors - and that is what turns a rate card into money.
 *
 * Everything here is derived. Nothing is stored, so a plan edited in the
 * builder retotals immediately, and a better plan produces a better takeoff
 * without anyone re-entering anything.
 *
 * A caveat worth carrying into the UI rather than hiding: a generated layout
 * has approximate room sizes, so the quantities inherit that. They are a real
 * takeoff of an approximate building, not a survey.
 */

const SQFT_PER_SQM = 1 / (M_PER_FT * M_PER_FT);
const FT_PER_M = 1 / M_PER_FT;

export type RoomTakeoff = {
  roomId: string;
  label: string;
  kind: RoomKind;
  level: number;

  floorSqft: number;
  ceilingSqft: number;
  /** Wall area with door and window openings removed. */
  wallSqft: number;
  /** Wall area before openings, kept because some trades price on gross. */
  wallGrossSqft: number;
  /** Skirting run: the perimeter, less the doorways. */
  baseboardLf: number;
  perimeterLf: number;

  doorCount: number;
  windowCount: number;

  /**
   * Length of wall a kitchen's cabinet run would occupy, or a vanity's.
   *
   * Cabinetry is priced per linear foot and does not run the whole perimeter -
   * it follows one or two walls. Two thirds of the longest wall is a rough but
   * stable proxy, and stable matters more than exact here: it is the number a
   * user will sanity-check against, and it should not swing when a room is
   * nudged by an inch.
   */
  cabinetRunLf: number;
  ceilingHeightFt: number;
};

/** Doors opening onto a room, ignoring stairs - a stairwell is not a doorway. */
function doorsFor(plan: Plan, room: Room) {
  return plan.openings.filter((o) => o.kind !== "stairs" && o.between.includes(room.id));
}

function windowsFor(plan: Plan, room: Room) {
  const b = boundsOf(room.polygon);
  // Exterior walls sit half their thickness outside the room, so a window
  // centred on one lands just beyond the room's own bounds.
  const slack = 0.3;
  return windowsForLevel(plan, room.level).filter(
    (w) =>
      w.center[0] > b.x0 - slack &&
      w.center[0] < b.x1 + slack &&
      w.center[1] > b.y0 - slack &&
      w.center[1] < b.y1 + slack,
  );
}

export function takeoffForRoom(plan: Plan, room: Room): RoomTakeoff {
  const b = boundsOf(room.polygon);
  const width = b.x1 - b.x0;
  const depth = b.y1 - b.y0;

  const floorSqm = area(room.polygon);
  const doors = doorsFor(plan, room);
  const windows = windowsFor(plan, room);

  // Reusing the wall runs the renderer uses. They already have doorways
  // subtracted, which is exactly the skirting run - and means the BOM and the
  // model can never disagree about where a door is.
  const runs = wallSegmentsForRoom(room, plan.openings);
  const baseboardM = runs.reduce((sum, seg) => sum + dist(seg.a, seg.b), 0);
  // Walked off the outline, not off the bounding box.
  //
  // They agree on a rectangle. On an L-shaped room the bounding box is shorter
  // than the real perimeter, which understated the wall area and every price
  // that hangs off it - and did so silently, because a plausible number came
  // back either way.
  const perimeterM = room.polygon.reduce((sum, a, i) => {
    const b = room.polygon[(i + 1) % room.polygon.length];
    return sum + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }, 0);

  const grossWallSqm = perimeterM * room.ceilingHeight;
  const doorAreaSqm = doors.reduce((sum, d) => sum + d.width * DOOR_HEIGHT, 0);
  const windowAreaSqm = windows.reduce(
    (sum, w) => sum + w.width * (HEAD_HEIGHT - SILL_HEIGHT),
    0,
  );

  const longestWallM = Math.max(width, depth);

  return {
    roomId: room.id,
    label: room.label,
    kind: roomKind(room.label),
    level: room.level,

    floorSqft: floorSqm * SQFT_PER_SQM,
    ceilingSqft: floorSqm * SQFT_PER_SQM,
    wallGrossSqft: grossWallSqm * SQFT_PER_SQM,
    // Openings can only ever remove wall, never more than there is of it.
    wallSqft: Math.max(grossWallSqm - doorAreaSqm - windowAreaSqm, 0) * SQFT_PER_SQM,
    baseboardLf: baseboardM * FT_PER_M,
    perimeterLf: perimeterM * FT_PER_M,

    doorCount: doors.length,
    windowCount: windows.length,

    cabinetRunLf: longestWallM * 0.66 * FT_PER_M,
    ceilingHeightFt: room.ceilingHeight * FT_PER_M,
  };
}

export function takeoffForPlan(plan: Plan): RoomTakeoff[] {
  return plan.rooms.map((room) => takeoffForRoom(plan, room));
}

/**
 * Finished area of the whole house, for the flat whole-house estimate.
 *
 * Excludes the garage and anything outdoors, the same way a listing's square
 * footage does - counting them would inflate every size-scaled line.
 */
export function livingAreaSqft(plan: Plan): number {
  return takeoffForPlan(plan)
    .filter((t) => t.kind !== "garage" && t.kind !== "outside")
    .reduce((sum, t) => sum + t.floorSqft, 0);
}
