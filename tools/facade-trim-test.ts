/** Corner boards where walls turn, a foundation band under the cladding, a chimney on the fireplace wall. */
import { chimney, cornerBoards, foundationBand } from "../src/lib/model/facade-trim";
import { wallsForLevel } from "../src/lib/model/walls";
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
    { id: "a", label: "Living Room", polygon: [[0, 0], [6, 0], [6, 5], [0, 5]], ceilingHeight: 2.7, level: 0 },
    { id: "b", label: "Kitchen", polygon: [[6, 0], [10, 0], [10, 5], [6, 5]], ceilingHeight: 2.7, level: 0 },
  ],
  openings: [{ id: "d", between: ["a", "b"], at: [6, 2.5], width: 0.9, kind: "door" }],
};
const walls = wallsForLevel(plan, 0);
const corners = cornerBoards(walls, 0, "#fff");
check("a rectangular house has four corner boards", corners.length === 4, `${corners.length}: ${corners.map((c) => `${c.center[0].toFixed(1)},${c.center[2].toFixed(1)}`).join(" ")}`);
check("at the house's corners", corners.every((c) => (Math.abs(c.center[0]) < 0.3 || Math.abs(c.center[0] - 10) < 0.3) && (Math.abs(c.center[2]) < 0.3 || Math.abs(c.center[2] - 5) < 0.3)));
check("full height", corners.every((c) => Math.abs(c.size[1] - 2.7) < 0.01));

const band = foundationBand(walls, "#999");
const exteriorRuns = walls.filter((w) => w.exterior && !w.header).length;
check("one band per exterior wall", band.length === exteriorRuns && band.length > 0, `${band.length} vs ${exteriorRuns}`);
check("below the floor", band.every((b) => b.center[1] < 0 && b.center[1] + b.size[1] / 2 <= 0.011));

const stack = chimney({ x0: 0, y0: 0, x1: 6, y1: 5 }, "west", 5.2, "#8b4a3a");
check("the chimney is outside the west wall", stack.center[0] < 0 && Math.abs(stack.center[2] - 2.5) < 1e-9, `${stack.center}`);
check("and rises above the ridge", stack.center[1] + stack.size[1] / 2 > 5.2 + 0.5);
check("south puts it past y1", chimney({ x0: 0, y0: 0, x1: 6, y1: 5 }, "south", 5, "#000").center[2] > 5);

console.log(failures === 0 ? "FACADE TRIM OK - corner boards where walls turn, a foundation band, a chimney outside its wall" : `FACADE TRIM BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
