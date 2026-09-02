/**
 * The house comes apart into rooms, and goes back together unchanged.
 *
 * Two claims, and the second matters as much as the first: at rest the model
 * must be exactly the house it was, because an exploded view that leaves a
 * trace in the assembled one has broken the thing it was meant to annotate.
 *
 * The reason each room grows its own walls when pulled out is that assembled,
 * a wall between two rooms is emitted once and belongs to both - which is
 * correct, and which would leave every room arriving as a floating carpet.
 */
import { readFileSync } from "node:fs";

import { explodeLift, explodeOffset, roomShell } from "../src/lib/model/room-shell";

import { boundsOf, dist } from "../src/lib/plan/geometry";
import { type Plan, parseProperty } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const load = (path: string): Plan => parseProperty(JSON.parse(readFileSync(path, "utf8"))).plan;

for (const fixture of ["demo-house", "two-storey"]) {
  const plan = load(`public/properties/${fixture}/property.json`);

  // --- assembled is untouched ---
  for (const room of plan.rooms) {
    const [dx, dy] = explodeOffset(plan, room, 0);
    check(`${fixture}: ${room.label} does not move at rest`, dx === 0 && dy === 0, `${dx}, ${dy}`);
  }
  check(`${fixture}: no storey lifts at rest`,
    plan.rooms.every((r) => explodeLift(r.level, 0) === 0));

  // --- and every room really does separate ---
  const moved = plan.rooms.map((room) => {
    const b = boundsOf(room.polygon);
    const [dx, dy] = explodeOffset(plan, room, 1);
    return {
      room,
      lift: explodeLift(room.level, 1),
      box: { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy },
    };
  });

  let touching = 0;
  for (let i = 0; i < moved.length; i++) {
    for (let j = i + 1; j < moved.length; j++) {
      // Rooms on different storeys are lifted apart vertically, so they are
      // allowed to sit above one another in plan.
      if (moved[i].lift !== moved[j].lift) continue;
      const a = moved[i].box;
      const b = moved[j].box;
      if (a.x0 < b.x1 - 0.05 && b.x0 < a.x1 - 0.05 && a.y0 < b.y1 - 0.05 && b.y0 < a.y1 - 0.05) {
        touching++;
      }
    }
  }
  check(`${fixture}: fully exploded, no two rooms on a storey overlap`, touching === 0,
    `${touching} pairs still overlapping`);

  // A dilation has a fixed point, so at most one room - the one sitting on the
  // centre - stays put and everything opens away from it.
  const stayed = plan.rooms.filter((room) => {
    const [dx, dy] = explodeOffset(plan, room, 1);
    return Math.hypot(dx, dy) < 0.5;
  });
  check(`${fixture}: at most one room is the anchor`, stayed.length <= 1,
    stayed.map((r) => r.label).join(", "));

  // --- each part is complete in itself ---
  for (const room of plan.rooms) {
    const shell = roomShell(plan, room);
    const b = boundsOf(room.polygon);
    const perimeter = 2 * (b.x1 - b.x0 + (b.y1 - b.y0));
    const built = shell.reduce((sum, box) => sum + Math.max(box.size[0], box.size[2]), 0);

    check(`${fixture}: ${room.label} brings walls with it`, shell.length >= 3,
      `${shell.length} pieces`);
    // Less than the full perimeter, because the doorways are cut out of it -
    // and not far less, or the room is missing a side.
    check(`${fixture}: ${room.label}'s walls are most of its perimeter`,
      built > perimeter * 0.6 && built <= perimeter + 0.01,
      `${built.toFixed(1)}m of ${perimeter.toFixed(1)}m`);

    for (const box of shell) {
      const inside =
        box.center[0] >= b.x0 - 0.11 && box.center[0] <= b.x1 + 0.11 &&
        box.center[2] >= b.y0 - 0.11 && box.center[2] <= b.y1 + 0.11;
      check(`${fixture}: ${room.label}'s walls stay on its own outline`, inside,
        `${box.center[0].toFixed(2)}, ${box.center[2].toFixed(2)}`);
      check(`${fixture}: ${room.label}'s walls are full height`,
        Math.abs(box.size[1] - room.ceilingHeight) < 1e-9);
    }
  }
}

// --- the movement itself ---
{
  const plan = load("public/properties/two-storey/property.json");
  const room = plan.rooms[0];

  // Monotonic: halfway out is halfway there. A slider that jumped would read as
  // the house snapping rather than opening.
  const half = explodeOffset(plan, room, 0.5);
  const full = explodeOffset(plan, room, 1);
  check("the offset is proportional to the slider",
    Math.abs(half[0] * 2 - full[0]) < 1e-9 && Math.abs(half[1] * 2 - full[1]) < 1e-9,
    `${half} then ${full}`);

  check("storeys lift apart as well as spreading",
    explodeLift(1, 1) > explodeLift(0, 1), `${explodeLift(1, 1)} vs ${explodeLift(0, 1)}`);

  // The same house must come apart the same way twice.
  check("exploding is deterministic",
    JSON.stringify(plan.rooms.map((r) => explodeOffset(plan, r, 0.7))) ===
      JSON.stringify(plan.rooms.map((r) => explodeOffset(plan, r, 0.7))));

  // The fixed point of the dilation is the plan's centre, so a lone room
  // centred on it is the anchor and does not move at all.
  const centred: Plan = {
    ...plan,
    rooms: [
      { ...room, id: "c", label: "Kitchen", polygon: [[-2, -1], [2, -1], [2, 1], [-2, 1]] },
    ],
  };
  check("the room at the centre is the anchor",
    dist([0, 0], explodeOffset(centred, centred.rooms[0], 1)) < 1e-9);
}

console.log(
  failures === 0
    ? "EXPLODE OK - rooms separate with their own walls, and reassemble exactly"
    : `EXPLODE BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
