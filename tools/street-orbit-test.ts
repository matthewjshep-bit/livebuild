/**
 * The street camera stands at the kerb at eye height and looks at the house.
 */
import { defaultOrbit, defaultViewFor, orbitPosition, planCenter, streetOrbit, streetTarget } from "../src/components/tour/CameraRig";
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
    { id: "a", label: "Living Room", polygon: [[0, 0], [10, 0], [10, 8], [0, 8]], ceilingHeight: 2.7, level: 0 },
  ],
  openings: [],
};

{
  const orbit = streetOrbit(plan, [5, -8.5]);
  const centre = planCenter(plan);
  centre.y = 1.2;
  const at = orbitPosition(centre, orbit);
  check("the camera stands at eye height", Math.abs(at.y - 1.62) < 0.05, `${at.y.toFixed(2)}`);
  check("on the kerb's side of the house", at.z < 0, `${at.z.toFixed(2)}`);
  check("in line with the kerb", Math.abs(at.x - 5) < 0.05, `${at.x.toFixed(2)}`);
  check("a little behind it, so the whole front is in frame", at.z < -8.5 && at.z > -16, `${at.z.toFixed(2)}`);
}
{
  const orbit = streetOrbit(plan, null);
  const centre = planCenter(plan);
  centre.y = 1.2;
  const at = orbitPosition(centre, orbit);
  check("without a kerb it still stands at eye height", Math.abs(at.y - 1.62) < 0.05, `${at.y.toFixed(2)}`);
  check("on the side the dollhouse opens on", at.z > 8, `${at.z.toFixed(2)}`);
  check("never closer than the lot line", orbit.distance >= 6);
}

// --- facing the door ---
//
// A door two metres off-centre: the camera stands opposite it and looks at
// it, not at the middle of the house.
{
  const door: [number, number] = [3, 0];
  const kerb: [number, number] = [3, -8.5];
  const orbit = streetOrbit(plan, kerb, door, "-y");
  const target = streetTarget(plan, door);
  check("the street camera looks at the door", Math.abs(target.x - 3) < 1e-9 && Math.abs(target.z - 0) < 1e-9, `${target.x},${target.z}`);
  check("a little above the ground", Math.abs(target.y - 1.2) < 1e-9);
  const at = orbitPosition(target, orbit);
  check("and stands opposite it", Math.abs(at.x - 3) < 0.05 && at.z < -8.5, `${at.x.toFixed(2)},${at.z.toFixed(2)}`);
  check("at eye height", Math.abs(at.y - 1.62) < 0.05, `${at.y.toFixed(2)}`);
}

// --- the dollhouse opens from the front, and a tour opens where it can ---
{
  const north = orbitPosition(planCenter(plan), defaultOrbit(plan, "-y"));
  check("a house fronting -y is seen from -z", north.z < 0, `${north.z.toFixed(2)}`);
  const east = orbitPosition(planCenter(plan), defaultOrbit(plan, "+x"));
  check("and one fronting +x from +x", east.x > 10, `${east.x.toFixed(2)}`);
  check("a house with a kerb opens at the street", defaultViewFor({ kerb: [5, -8.5] }).mode === "street");
  check("and one without opens in the dollhouse", defaultViewFor({ kerb: null }).mode === "dollhouse" && defaultViewFor(null).mode === "dollhouse");
}

console.log(failures === 0 ? "STREET ORBIT OK - the street camera stands opposite the door at eye height and looks at it, the dollhouse opens from the front, and a house without a kerb opens in the dollhouse" : `STREET ORBIT BROKEN - ${failures}`);
process.exit(failures === 0 ? 0 : 1);
