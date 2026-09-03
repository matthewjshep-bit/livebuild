/**
 * A broken centre line down every road: three metres of paint, six of gap,
 * carried through the way's corners.
 */
import { DASH_M, GAP_M, centreDashes } from "../src/lib/model/road-marks";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const straight = centreDashes([[0, 0], [90, 0]], 0.01);
check("a ninety-metre road gets ten dashes", straight.length === 10, `${straight.length}`);
for (const g of straight) g.computeBoundingBox();
check("each three metres long and a hand wide", straight.every((g) => Math.abs(g.boundingBox!.max.x - g.boundingBox!.min.x - DASH_M) < 1e-6 && g.boundingBox!.max.z - g.boundingBox!.min.z < 0.2));
check("laid just above the road", straight.every((g) => g.boundingBox!.min.y > 0.005 && g.boundingBox!.max.y < 0.02));
check("with the gap between them", Math.abs(straight[1].boundingBox!.min.x - straight[0].boundingBox!.max.x - GAP_M) < 1e-6);

const bent = centreDashes([[0, 0], [4, 0], [4, 40]], 0.01);
check("the pattern runs through a corner", bent.length === Math.floor(44 / (DASH_M + GAP_M)) + 1 || bent.length === Math.floor(44 / (DASH_M + GAP_M)), `${bent.length}`);
for (const g of bent) g.computeBoundingBox();
check("and turns with the road", bent.slice(1).every((g) => g.boundingBox!.max.z - g.boundingBox!.min.z > 2), bent.map((g) => (g.boundingBox!.max.z - g.boundingBox!.min.z).toFixed(1)).join(","));

check("nothing on a point", centreDashes([[1, 1]], 0).length === 0);

console.log(failures === 0 ? "ROAD MARKS OK - a broken centre line, three on and six off, through the corners" : `ROAD MARKS BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
