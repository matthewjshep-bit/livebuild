/**
 * A rotated house is the same house.
 *
 * This is the acceptance criterion for building rooms at any angle, and it is
 * written before the work rather than after because it is the only honest way
 * to know when that work is done. Every fact asserted below is one the model
 * already guarantees for an axis-aligned house: walls are built once, doorways
 * get exactly one header, corners are solid, floors have their area, every room
 * can be reached. None of those facts is *about* an axis. If turning the whole
 * plan through seven degrees changes any of them, the axis has been doing work
 * nobody asked it to do.
 *
 * It fails today, and it should. `wallsForLevel` groups collinear edges by axis
 * and coordinate, so at 7 degrees every wall becomes its own group and every
 * shared wall is built twice - once by each room, facing opposite ways, in the
 * same place. That is the bug this whole rebuild exists to fix, and this is what
 * it looks like from the outside.
 *
 * Pure: no browser, no API key, no network.
 */
import { autoOpenings, rectangle } from "../src/lib/plan/autolayout";
import { blocked, collidersFor, startingPoint } from "../src/lib/model/collide";
import { area, roomAdjacency } from "../src/lib/plan/geometry";
import { wallsForLevel } from "../src/lib/model/walls";
import type { Plan, Room, Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

/** A unit vector, or [0,0] for a degenerate one. */
function unit([x, y]: Vec2): Vec2 {
  const len = Math.hypot(x, y);
  return len < 1e-9 ? [0, 0] : [x / len, y / len];
}

const room = (id: string, label: string, x: number, y: number, w: number, h: number): Room => ({
  id,
  label,
  polygon: rectangle(x, y, w, h),
  ceilingHeight: 2.7,
  level: 0,
});

/**
 * A small house with every case that matters: two rooms sharing a full wall,
 * two sharing part of one, and a room touching two others at once.
 */
function house(): Plan {
  const rooms = [
    room("living", "Living Room", 0, 0, 6, 5),
    room("kitchen", "Kitchen", 6, 0, 4, 5),
    room("hall", "Hallway", 0, 5, 10, 2),
    room("bed", "Bedroom", 0, 7, 5, 4),
    room("bath", "Bathroom", 5, 7, 5, 4),
  ];
  return { scaleRef: { px: 1, meters: 1 }, rooms, openings: autoOpenings(rooms) };
}

/** Turn the whole plan about the origin. Rooms, doorways and all. */
function turn(plan: Plan, degrees: number): Plan {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const spin = ([x, y]: Vec2): Vec2 => [x * cos - y * sin, x * sin + y * cos];
  return {
    ...plan,
    rooms: plan.rooms.map((room) => ({ ...room, polygon: room.polygon.map(spin) })),
    openings: plan.openings.map((o) => ({ ...o, at: spin(o.at) })),
  };
}

const ANGLES = [0, 7, 17, 30, 45, 63];
const base = house();
const baseWalls = wallsForLevel(base, 0);
const baseLength = baseWalls.reduce((sum, w) => sum + w.length, 0);
const baseFloor = base.rooms.reduce((sum, r) => sum + area(r.polygon), 0);

for (const degrees of ANGLES) {
  const plan = turn(base, degrees);
  const at = `${degrees}deg`;
  const walls = wallsForLevel(plan, 0);

  // --- the floor is the floor ---
  const floor = plan.rooms.reduce((sum, r) => sum + area(r.polygon), 0);
  check(`${at}: floor area survives the turn`, Math.abs(floor - baseFloor) < 1e-6,
    `${floor.toFixed(3)} vs ${baseFloor.toFixed(3)}`);

  // --- no wall is built twice ---
  //
  // The failure this is really looking for. Two rooms sharing a wall must
  // produce ONE partition between them, not one solid per room in the same
  // place - which is what grouping by axis does the moment nothing is on an
  // axis. Duplicates are found by position rather than by count, because two
  // solids a millimetre apart are the same wall built twice.
  const centres = walls.filter((w) => !w.header).map((w) => w.center);
  let coincident = 0;
  for (let i = 0; i < centres.length; i++) {
    for (let j = i + 1; j < centres.length; j++) {
      if (Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1]) < 0.05) {
        coincident++;
      }
    }
  }
  check(`${at}: no wall is built twice`, coincident === 0, `${coincident} coincident solids`);

  // --- and there is the same amount of wall as before ---
  const length = walls.reduce((sum, w) => sum + w.length, 0);
  check(`${at}: the same length of wall is built`,
    Math.abs(length - baseLength) / baseLength < 0.01,
    `${length.toFixed(2)}m vs ${baseLength.toFixed(2)}m`);
  check(`${at}: the same number of solids`, walls.length === baseWalls.length,
    `${walls.length} vs ${baseWalls.length}`);

  // --- every wall is a wall ---
  for (const w of walls) {
    if (w.length <= 0 || w.thickness <= 0 || !Number.isFinite(w.angleDeg)) {
      check(`${at}: every solid has real dimensions`, false, JSON.stringify(w));
      break;
    }
  }

  // --- one header per doorway ---
  const doors = plan.openings.filter((o) => o.kind !== "stairs").length;
  const headers = walls.filter((w) => w.header).length;
  check(`${at}: one header per doorway`, headers === doors, `${headers} headers, ${doors} doors`);

  // --- corners are solid ---
  //
  // Probed just outside each room's vertices, along the outward bisector, which
  // is the one place a mitre that is only right at 90 degrees leaves a hole.
  const colliders = collidersFor(plan, 0);
  let holes = 0;
  for (const r of plan.rooms) {
    const poly = r.polygon;
    for (let i = 0; i < poly.length; i++) {
      const prev = poly[(i - 1 + poly.length) % poly.length];
      const here = poly[i];
      const next = poly[(i + 1) % poly.length];
      // The outward bisector, averaged as vectors rather than as angles.
      // Averaging two atan2 results wraps at the seam where one is near +pi and
      // the other near -pi, which points the probe into the room at exactly one
      // corner of every polygon - and looks like a hole in the wall.
      const into = unit([here[0] - prev[0], here[1] - prev[1]]);
      const outOf = unit([next[0] - here[0], next[1] - here[1]]);
      const mean = unit([into[0] + outOf[0], into[1] + outOf[1]]);
      // Turned a quarter, which for a positively wound polygon faces out.
      const probe: Vec2 = [here[0] + mean[1] * 0.06, here[1] - mean[0] * 0.06];
      if (!blocked(colliders, probe[0], probe[1], 0)) holes++;
    }
  }
  check(`${at}: corners are solid`, holes === 0, `${holes} corner probes found air`);

  // --- every room can still be walked into ---
  const adjacency = roomAdjacency(plan);
  const seen = new Set<string>(["living"]);
  const queue = ["living"];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const other of adjacency.get(id) ?? []) {
      if (!seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  check(`${at}: every room is reachable`, seen.size === plan.rooms.length,
    `${seen.size} of ${plan.rooms.length}`);

  // --- and the walker does not start inside a wall ---
  const start = startingPoint(plan, 0);
  check(`${at}: the walker starts in open floor`, !blocked(colliders, start[0], start[1]),
    `${start.map((v) => v.toFixed(2)).join(", ")}`);
}

if (failures > 0) {
  console.error(`\nROTATE: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  "ROTATE OK - a house turned through 0, 7, 17, 30, 45 and 63 degrees builds the same walls, the same headers, solid corners and reachable rooms",
);
