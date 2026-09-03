/**
 * A room's wall skin sits inside the room, and stops for its windows and doors.
 *
 * The skin is what puts a read wall material - brick, panelling - on the wall
 * a person is looking at, rather than only on the exploded view. Three things
 * can go wrong with it and each is checked here: it can be pushed the wrong
 * way (into the partition, where nobody sees it - and the sign depends on the
 * polygon's winding, so both are tried); it can cover a window from inside;
 * and it can close a doorway.
 */
import { wallSkins } from "../src/lib/model/room-shell";
import type { ModelWindow } from "../src/lib/model/windows";
import type { Plan, Room } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const roomOf = (polygon: [number, number][]): Room => ({
  id: "r",
  label: "Living Room",
  polygon,
  ceilingHeight: 2.7,
  level: 0,
});
// 6 wide by 5 deep, with a doorway in the east wall.
const ccw: [number, number][] = [[0, 0], [6, 0], [6, 5], [0, 5]];
const cw = [...ccw].reverse() as [number, number][];
const plan = (room: Room): Plan => ({
  scaleRef: { px: 1, meters: 1 },
  rooms: [room, { id: "k", label: "Kitchen", polygon: [[6, 0], [10, 0], [10, 5], [6, 5]], ceilingHeight: 2.7, level: 0 }],
  openings: [{ id: "d", kind: "door", between: ["r", "k"], at: [6, 2.5], width: 0.9 }],
});
// One window in the north wall (y = 0), 1.2m wide, centred at x = 3.
const windows: ModelWindow[] = [{ center: [3, 0], width: 1.2, sill: 0.9, head: 2.1, thickness: 0.2, angleDeg: 0 }];

for (const [name, polygon] of [["counter-clockwise", ccw], ["clockwise", cw]] as const) {
  const room = roomOf(polygon);
  const panels = wallSkins(plan(room), room, windows);
  check(`${name}: there are panels`, panels.length > 0);

  // Inside the room, every one - which is the winding check.
  const inside = panels.every(
    (p) => p.center[0] > 0.03 && p.center[0] < 5.97 && p.center[2] > 0.03 && p.center[2] < 4.97,
  );
  check(`${name}: every panel is inside the room`, inside,
    panels.filter((p) => !(p.center[0] > 0.03 && p.center[0] < 5.97 && p.center[2] > 0.03 && p.center[2] < 4.97))
      .map((p) => p.center.map((v) => v.toFixed(2)).join(",")).join(" | "));
  // And only just: proud of the partition's face, not in the middle of the room.
  const north = panels.filter((p) => p.center[2] < 0.5);
  check(`${name}: the north skin is just proud of the wall`, north.length > 0 && north.every((p) => p.center[2] > 0.05 && p.center[2] < 0.08),
    north.map((p) => p.center[2].toFixed(3)).join(","));

  // The window: nothing covers it, and there is wall below and above it.
  const overWindow = north.filter((p) => p.center[0] + p.size[0] / 2 > 2.4 + 0.01 && p.center[0] - p.size[0] / 2 < 3.6 - 0.01);
  const glassCovered = overWindow.some((p) => p.center[1] + p.size[1] / 2 > 0.9 + 0.01 && p.center[1] - p.size[1] / 2 < 2.1 - 0.01);
  check(`${name}: the window is not covered`, !glassCovered,
    overWindow.map((p) => `y ${(p.center[1] - p.size[1] / 2).toFixed(2)}-${(p.center[1] + p.size[1] / 2).toFixed(2)}`).join(" | "));
  check(`${name}: there is wall below the sill`, overWindow.some((p) => Math.abs(p.center[1] + p.size[1] / 2 - 0.9) < 0.01));
  check(`${name}: and above the head`, overWindow.some((p) => Math.abs(p.center[1] - p.size[1] / 2 - 2.1) < 0.01));

  // The doorway in the east wall stays open.
  const east = panels.filter((p) => p.center[0] > 5.5);
  const doorBlocked = east.some((p) => p.center[2] + p.size[2] / 2 > 2.05 + 0.02 && p.center[2] - p.size[2] / 2 < 2.95 - 0.02);
  check(`${name}: the doorway is not skinned over`, !doorBlocked,
    east.map((p) => `z ${(p.center[2] - p.size[2] / 2).toFixed(2)}-${(p.center[2] + p.size[2] / 2).toFixed(2)}`).join(" | "));
}

console.log(
  failures === 0
    ? "WALL SKINS OK - a read wall's skin sits just inside its room whichever way the polygon winds, and stops for the window and the door"
    : `WALL SKINS BROKEN - ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
