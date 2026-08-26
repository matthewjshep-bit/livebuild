/**
 * The sun is where the sun actually is.
 *
 * Unlike most of this codebase, daylight has ground truth: the geometry of the
 * solar system is not a matter of taste, and the numbers below can be checked
 * against a nautical almanac rather than against my own judgement. That makes
 * this one of the few things here worth asserting exactly.
 *
 * The reason it matters is not accuracy for its own sake. A sine wave sweeping
 * across the sky looks fine in isolation and gets the asymmetries wrong - the
 * difference between June and December, and between morning and afternoon, is
 * the entire question a buyer is asking when they ask about light.
 */
import { dayOfYear, planFromBearing, solarPosition, sunState } from "../src/lib/model/sun";
import type { Site } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/**
 * Solar noon, found rather than assumed.
 *
 * The first version of this test compared clock times against textbook noon
 * figures and reported three failures that were all its own. Clock noon is not
 * solar noon - longitude within a timezone and the equation of time move it by
 * up to half an hour - and near the zenith the azimuth swings so fast that
 * being twenty minutes out puts the sun ninety degrees round. Scanning for the
 * highest sun of the day sidesteps every one of those.
 */
function solarNoon(site: Site, doy: number) {
  let best = { altitudeDeg: -90, azimuthDeg: 0, hour: 0 };
  for (let hour = 0; hour < 24; hour += 1 / 60) {
    const p = solarPosition(site, doy, hour);
    if (p.altitudeDeg > best.altitudeDeg) best = { ...p, hour };
  }
  return best;
}

const seattle: Site = { lat: 47.62, lon: -122.30, planXBearing: 90 };
const quito: Site = { lat: -0.18, lon: -78.47, planXBearing: 90 };
const sydney: Site = { lat: -33.87, lon: 151.21, planXBearing: 90 };

const JUN = dayOfYear(6, 21);
const DEC = dayOfYear(12, 21);
const MAR = dayOfYear(3, 20);

// Noon altitude is 90 - |latitude - declination|, and declination is +23.45 at
// the June solstice and -23.45 at the December one. Two degrees of tolerance
// covers the approximation and the fact that clock noon is not solar noon.
{
  const summer = solarNoon(seattle, JUN);
  check("Seattle midsummer sun reaches about 66 degrees",
    near(summer.altitudeDeg, 65.8, 1), `${summer.altitudeDeg.toFixed(1)}`);

  const winter = solarNoon(seattle, DEC);
  check("Seattle midwinter sun barely clears 19 degrees",
    near(winter.altitudeDeg, 18.9, 1), `${winter.altitudeDeg.toFixed(1)}`);

  check("summer sun is far higher than winter",
    summer.altitudeDeg - winter.altitudeDeg > 40,
    `${(summer.altitudeDeg - winter.altitudeDeg).toFixed(1)} degrees apart`);
}

// In the northern hemisphere the midday sun is due south; in the southern it is
// due north. Getting this backwards would light every room from the wrong side
// and look completely plausible.
{
  const north = solarNoon(seattle, JUN);
  check("northern-hemisphere noon sun is due south",
    near(north.azimuthDeg, 180, 2), `bearing ${north.azimuthDeg.toFixed(0)}`);

  const south = solarNoon(sydney, DEC);
  check("southern-hemisphere noon sun is due north",
    south.azimuthDeg < 2 || south.azimuthDeg > 358, `bearing ${south.azimuthDeg.toFixed(0)}`);

  // And solar noon really is near the middle of the day, which is the check
  // that the whole scan is not quietly finding something else.
  check("solar noon falls near midday", north.hour > 11 && north.hour < 14,
    `${north.hour.toFixed(2)}`);
}

// Morning in the east, afternoon in the west. The `acos` used to find the
// azimuth cannot tell them apart on its own.
{
  const morning = solarPosition(seattle, JUN, 8);
  const afternoon = solarPosition(seattle, JUN, 17);
  check("morning sun is in the east", morning.azimuthDeg < 150,
    `bearing ${morning.azimuthDeg.toFixed(0)}`);
  check("afternoon sun is in the west", afternoon.azimuthDeg > 210,
    `bearing ${afternoon.azimuthDeg.toFixed(0)}`);
}

// On the equator at an equinox the noon sun is overhead.
{
  const overhead = solarNoon(quito, MAR);
  check("equatorial equinox noon is nearly overhead", overhead.altitudeDeg > 88,
    `${overhead.altitudeDeg.toFixed(1)}`);
}

// Night is night, and the scene must go dark rather than merely dim.
{
  const midnight = sunState(seattle, DEC, 0);
  check("the midwinter sun is below the horizon at midnight", midnight.altitudeDeg < 0,
    `${midnight.altitudeDeg.toFixed(1)}`);
  check("night contributes no daylight", midnight.day === 0, `${midnight.day}`);
  check("the sun still points somewhere finite at night",
    midnight.direction.every(Number.isFinite));
}

// Warmth near the horizon is what makes a time of day legible at a glance.
{
  const noon = sunState(seattle, JUN, 13);
  const evening = sunState(seattle, JUN, 20);
  check("evening light is warmer than midday", evening.colour[2] < noon.colour[2],
    `blue ${evening.colour[2].toFixed(2)} vs ${noon.colour[2].toFixed(2)}`);
  check("midday is brighter than evening", noon.intensity > evening.intensity);
}

// Bearings map into plan space. Plan +y points south, because the footprint is
// projected that way - so north must come out as -y.
{
  const east = planFromBearing(seattle, 90);
  check("east is plan +x", near(east[0], 1, 0.01) && near(east[1], 0, 0.01),
    `${east.map((v) => v.toFixed(2)).join(", ")}`);

  const north = planFromBearing(seattle, 0);
  check("north is plan -y", near(north[0], 0, 0.01) && near(north[1], -1, 0.01),
    `${north.map((v) => v.toFixed(2)).join(", ")}`);

  // A building turned 30 degrees turns the whole compass with it.
  const turned: Site = { ...seattle, planXBearing: 120 };
  const turnedEast = planFromBearing(turned, 120);
  check("a rotated building rotates its compass",
    near(turnedEast[0], 1, 0.01) && near(turnedEast[1], 0, 0.01),
    `${turnedEast.map((v) => v.toFixed(2)).join(", ")}`);
}

// The calendar helper, since every check above depends on it.
check("day of year is right for the solstices", dayOfYear(1, 1) === 1 && dayOfYear(12, 31) === 365,
  `${dayOfYear(1, 1)} and ${dayOfYear(12, 31)}`);
check("June solstice lands where it should", near(JUN, 172, 1), `${JUN}`);

console.log(
  failures === 0
    ? "SUN OK - solstice altitudes, hemisphere, morning/afternoon and plan bearings all check out"
    : `SUN BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
