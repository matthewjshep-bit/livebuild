/** The trim follows the roof: fascia and gutters at the eaves, rakes up the gables, caps on ridge and hips. */
import { roofFor } from "../src/lib/model/roof";
import { roofTrim } from "../src/lib/model/roof-trim";
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
  rooms: [{ id: "a", label: "a", polygon: [[0, 0], [10, 0], [10, 6], [0, 6]], ceilingHeight: 2.7, level: 0 }],
  openings: [],
};

{
  const roof = roofFor(plan, { roof: { shape: "gable" } }, null)!;
  const trim = roofTrim(roof);
  // Two eaves, each a fascia; four rakes, two per gable end; one ridge, capped on both slopes.
  check("a gable has two fascias and four rakes", trim.boards.length === 6, `${trim.boards.length} boards`);
  check("two gutters", trim.gutters.length === 2);
  check("four downpipes, one per corner", trim.downpipes.length === 4, `${trim.downpipes.length}`);
  check("the ridge is capped on both sides", trim.caps.length === 2, `${trim.caps.length}`);
  check("downpipes reach from the gutter to the ground", trim.downpipes.every((p) => Math.abs(p.center[1] * 2 - p.size[1]) < 1e-9 && p.size[1] < roof.eaveY));
  check("the fascias hang at the eave", trim.boards.slice(0, 2).every((b) => b.points.some((p) => Math.abs(p[1] - roof.eaveY - 0.15) < 1e-6)));
  check("the caps sit just above the slopes", trim.caps.every((c) => c.points.every((p) => p[1] <= roof.ridgeY + 0.02 && p[1] > roof.ridgeY - 0.2)));
  check("everything is trim", [...trim.boards, ...trim.gutters, ...trim.caps].every((f) => f.kind === "trim"));
}

{
  const roof = roofFor(plan, { roof: { shape: "hip" } }, null)!;
  const trim = roofTrim(roof);
  check("a hip has four fascias and no rakes", trim.boards.length === 4, `${trim.boards.length} boards`);
  check("four gutters and four downpipes", trim.gutters.length === 4 && trim.downpipes.length === 4);
  // A ridge and four hips, each capped on two faces.
  check("the ridge and four hips are capped", trim.caps.length === 10, `${trim.caps.length}`);
}

console.log(failures === 0 ? "ROOF TRIM OK - fascia, gutters, downpipes, rakes and caps follow the roof" : `ROOF TRIM BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
