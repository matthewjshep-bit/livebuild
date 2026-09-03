/**
 * Every interior doorway gets a frame, casing on both faces, and a leaf
 * standing open into the first room the opening names.
 */
import { OPEN_DEG, doorwaysOf, interiorDoors } from "../src/lib/model/door-leaves";
import { DOOR_HEIGHT, wallsForLevel } from "../src/lib/model/walls";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// Two rooms side by side, a door in the wall between them at x = 5.
const plan: Plan = {
  scaleRef: { px: 1, meters: 1 },
  rooms: [
    { id: "a", label: "Living Room", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]], ceilingHeight: 2.7, level: 0 },
    { id: "b", label: "Kitchen", polygon: [[5, 0], [10, 0], [10, 5], [5, 5]], ceilingHeight: 2.7, level: 0 },
  ],
  openings: [{ id: "d", between: ["a", "b"], at: [5, 2.5], width: 0.9, kind: "door" }],
};
const walls = wallsForLevel(plan, 0);
const doorways = doorwaysOf(plan, 0, walls);
check("one doorway, from the one header", doorways.length === 1, `${doorways.length}`);
check("it opens into the first room named", doorways[0]?.into[0] === -1, `${doorways[0]?.into}`);

const parts = interiorDoors(plan, 0, walls, 0, { frame: "#fff", leaf: "#eee" });
const of = (part: string) => parts.filter((p) => p.part === part);
check("two jambs and a head", of("jamb").length === 2 && of("head").length === 1);
check("casing on both faces", of("casing").length === 6);
check("a panelled leaf with a handle each side", of("door-leaf").length >= 6 && of("door-panel").length === 6 && of("handle").length === 2);

const leaf = of("door-leaf");
check("the leaf stands open at eighty degrees", leaf.every((p) => Math.abs(Math.abs(p.angleDeg - 90) - OPEN_DEG) < 1e-6), leaf.map((p) => p.angleDeg).join(","));
check("into the living room, not the kitchen", leaf.every((p) => p.center[0] < 5), leaf.map((p) => p.center[0].toFixed(2)).join(","));
check("and hangs on a jamb", leaf.some((p) => Math.abs(p.center[2] - (2.5 - 0.45 + 0.04)) < 0.12));
check("nothing rises above the head casing", parts.every((p) => p.center[1] + p.size[1] / 2 <= DOOR_HEIGHT + 0.071));
check("the jambs fill the reveal", of("jamb").every((p) => Math.abs(p.size[1] - DOOR_HEIGHT) < 1e-6 && p.size[2] === walls.find((w) => w.header)!.thickness));

// Two storeys: the upper storey's doorway is not fitted from the ground's walls.
const two: Plan = {
  ...plan,
  rooms: [...plan.rooms, { id: "u", label: "Bedroom", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]], ceilingHeight: 2.5, level: 1 }, { id: "v", label: "Bath", polygon: [[5, 0], [10, 0], [10, 5], [5, 5]], ceilingHeight: 2.5, level: 1 }],
  openings: [...plan.openings, { id: "e", between: ["u", "v"], at: [5, 1.5], width: 0.8, kind: "door" }],
};
check("a storey fits only its own doorways", doorwaysOf(two, 0, wallsForLevel(two, 0)).length === 1 && doorwaysOf(two, 1, wallsForLevel(two, 1)).length === 1);

console.log(failures === 0 ? "DOOR LEAVES OK - a frame, casing both sides, and a leaf open into the room" : `DOOR LEAVES BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
