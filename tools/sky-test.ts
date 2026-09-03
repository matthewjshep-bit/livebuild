/**
 * The sky follows the sun: hazier at dawn than at noon, and the sun where the
 * shadows say it is.
 */
import { dayOfYear, sunState } from "../src/lib/model/sun";
import { skyUniformsFor } from "../src/lib/render/sky";
import type { Site } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const seattle: Site = { lat: 47.62, lon: -122.3, planXBearing: 90 };
const june = dayOfYear(6, 21);
const noon = skyUniformsFor(sunState(seattle, june, 12.5));
const dawn = skyUniformsFor(sunState(seattle, june, 5.5));

check("dawn is hazier than noon", dawn.turbidity > noon.turbidity && dawn.mieCoefficient > noon.mieCoefficient,
  `turbidity ${dawn.turbidity.toFixed(2)} vs ${noon.turbidity.toFixed(2)}`);
check("dawn scatters more", dawn.rayleigh > noon.rayleigh);
check("noon is clear", noon.turbidity < 4 && noon.rayleigh < 2, `turbidity ${noon.turbidity.toFixed(2)} rayleigh ${noon.rayleigh.toFixed(2)}`);

const sun = sunState(seattle, june, 12.5);
const len = Math.hypot(...noon.sunPosition);
check("the sun direction is a unit vector", Math.abs(len - 1) < 1e-6, `${len}`);
const dot = (noon.sunPosition[0] * sun.direction[0] + noon.sunPosition[1] * sun.direction[1] + noon.sunPosition[2] * sun.direction[2]) / Math.hypot(...sun.direction);
check("and it is where the light comes from", Math.abs(dot - 1) < 1e-6, `${dot}`);
check("noon sun is high", noon.sunPosition[1] > 0.8, `${noon.sunPosition[1].toFixed(2)}`);
check("dawn sun is low", dawn.sunPosition[1] < 0.3, `${dawn.sunPosition[1].toFixed(2)}`);

console.log(failures === 0 ? "SKY OK - clear at noon, hazy at dawn, the sun where the shadows are" : `SKY BROKEN - ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
