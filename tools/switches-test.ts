/**
 * A switch by every door on the side you come in, outlets along the walls,
 * and nothing on the outside of the house.
 */
import { switchesFor } from "../src/lib/model/switches";
import { wallsForLevel } from "../src/lib/model/walls";
import { pointInPolygon } from "../src/lib/plan/geometry";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const plan: Plan = {
  scaleRef: { px: 1, meters: 1 },
  rooms: [
    { id: "a", label: "Living Room", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]], ceilingHeight: 2.7, level: 0 },
    { id: "b", label: "Kitchen", polygon: [[5, 0], [10, 0], [10, 5], [5, 5]], ceilingHeight: 2.7, level: 0 },
  ],
  openings: [{ id: "d", between: ["a", "b"], at: [5, 2.5], width: 0.9, kind: "door" }],
};
const parts = switchesFor(plan, 0, wallsForLevel(plan, 0), 0);
const switches = parts.filter((p) => p.part === "switch");
const outlets = parts.filter((p) => p.part === "outlet");
check("one switch, by the one door", switches.length === 1, `${switches.length}`);
check("at hand height, on the living room side, by the latch", switches.every((s) => Math.abs(s.center[1] - 1.2) < 1e-6 && s.center[0] < 5 && s.center[0] > 4.8 && s.center[2] > 2.5 + 0.45), JSON.stringify(switches.map((s) => s.center)));
check("outlets along the walls", outlets.length >= 6, `${outlets.length}`);
check("at skirting height", outlets.every((o) => Math.abs(o.center[1] - 0.3) < 1e-6));
const house = [[0, 0], [10, 0], [10, 5], [0, 5]] as [number, number][];
const inside = (p: { center: [number, number, number] }) => pointInPolygon([p.center[0], p.center[2]], house);
check("none on the outside of the house", parts.every(inside), JSON.stringify(parts.filter((p) => !inside(p)).map((p) => [p.part, p.center])));
check("the partition has outlets on both faces", outlets.some((o) => Math.abs(o.center[0] - 5) < 0.2 && o.center[0] < 5) && outlets.some((o) => Math.abs(o.center[0] - 5) < 0.2 && o.center[0] > 5));

console.log(failures === 0 ? "SWITCHES OK - a switch by the door, outlets along the walls, nothing outside" : `SWITCHES BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
