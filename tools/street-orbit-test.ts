/**
 * The street camera stands at the kerb at eye height and looks at the house.
 */
import { orbitPosition, planCenter, streetOrbit } from "../src/components/tour/CameraRig";
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

console.log(failures === 0 ? "STREET ORBIT OK - the street camera stands at the kerb at eye height, or the default distance off without one" : `STREET ORBIT BROKEN - ${failures}`);
process.exit(failures === 0 ? 0 : 1);
