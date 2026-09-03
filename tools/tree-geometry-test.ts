/**
 * A tree is several lobes and not one ball, darker underneath, the same tree
 * every time and a different tree next door.
 */
import * as THREE from "three";
import { canopyGeometry, seedAt, shrubGeometry, trunkGeometry, trunkHeight } from "../src/lib/model/tree-geometry";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const bounds = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!;
};

const oak = { at: [4, 6] as [number, number], heightM: 6, trunkR: 0.2, canopyR: 2.5, shape: "round" as const };
const fir = { at: [-3, 2] as [number, number], heightM: 9, trunkR: 0.3, canopyR: 2, shape: "cone" as const };

{
  const canopy = canopyGeometry(oak);
  const b = bounds(canopy);
  check("the crown stands over the trunk", b.min.y > trunkHeight(oak) - oak.canopyR * 0.6 && b.max.y <= oak.heightM + oak.canopyR * 0.6, `${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)}`);
  check("and is about as wide as asked", b.max.x - b.min.x > oak.canopyR * 1.8 && b.max.x - b.min.x < oak.canopyR * 3.2, `${(b.max.x - b.min.x).toFixed(2)}`);
  check("it is several lobes, not one ball", canopy.getAttribute("position").count > 5 * 40 * 3, `${canopy.getAttribute("position").count} vertices`);
  const colour = canopy.getAttribute("color");
  check("it carries a vertex colour", Boolean(colour) && colour.count === canopy.getAttribute("position").count);
  // Darker below than above.
  const pos = canopy.getAttribute("position");
  let low = 0, lowN = 0, high = 0, highN = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < b.min.y + (b.max.y - b.min.y) * 0.2) { low += colour.getX(i); lowN++; }
    if (y > b.max.y - (b.max.y - b.min.y) * 0.2) { high += colour.getX(i); highN++; }
  }
  check("darker underneath than on top", low / lowN < high / highN - 0.2, `${(low / lowN).toFixed(2)} below, ${(high / highN).toFixed(2)} above`);
}
{
  const a = canopyGeometry(oak);
  const b = canopyGeometry(oak);
  const c = canopyGeometry({ ...oak, at: [9, 1] });
  const sum = (g: THREE.BufferGeometry) => { const p = g.getAttribute("position"); let s = 0; for (let i = 0; i < p.count; i++) s += p.getX(i) - (g === c ? 5 : 0) + p.getZ(i) + (g === c ? 5 : 0); return s; };
  check("the same tree every time", Math.abs(sum(a) - sum(b)) < 1e-6);
  check("a different tree next door", Math.abs(sum(a) - sum(c)) > 1e-3);
  check("seeds are in [0, 1) and differ by salt", seedAt([1, 2]) >= 0 && seedAt([1, 2]) < 1 && seedAt([1, 2]) !== seedAt([1, 2], 1));
}
{
  const canopy = canopyGeometry(fir);
  const pos = canopy.getAttribute("position");
  // Narrower at the top: the widest vertices are in the lower half.
  let lowMax = 0, highMax = 0;
  const b = bounds(canopy);
  const mid = (b.min.y + b.max.y) / 2;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i) - fir.at[0], pos.getZ(i) - fir.at[1]);
    if (pos.getY(i) < mid) lowMax = Math.max(lowMax, r); else highMax = Math.max(highMax, r);
  }
  check("a conifer narrows going up", highMax < lowMax * 0.8, `${lowMax.toFixed(2)} below, ${highMax.toFixed(2)} above`);
  check("and reaches its height", b.max.y > fir.heightM * 0.95 && b.max.y < fir.heightM * 1.15, `${b.max.y.toFixed(2)}`);
}
{
  const trunk = trunkGeometry(oak);
  const b = bounds(trunk);
  check("the trunk starts at the ground and reaches into the crown", b.min.y < 0.01 && b.max.y > trunkHeight(oak));
  check("with branches leaning out", b.max.x - b.min.x > oak.trunkR * 4, `${(b.max.x - b.min.x).toFixed(2)} across`);
  const firTrunk = bounds(trunkGeometry(fir));
  check("a conifer has a bare trunk", firTrunk.max.x - firTrunk.min.x < fir.trunkR * 2.6);
}
{
  const shrub = shrubGeometry({ at: [1, 1], r: 0.6 });
  const b = bounds(shrub);
  check("a shrub sits on the ground", b.min.y < 0.05 && b.max.y > 0.9 && b.max.y < 1.3, `${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)}`);
  check("and is a clump", shrub.getAttribute("position").count > 3 * 40 * 3);
}

console.log(failures === 0 ? "TREE GEOMETRY OK - lobed crowns darker underneath, tiered conifers, clumped shrubs, the same tree every time" : `TREE GEOMETRY BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
