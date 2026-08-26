import type { Site, Vec2 } from "@/lib/schema";

/**
 * Where the sun is, for a real place and a real time.
 *
 * A fixed key light is a studio, not a house. Which rooms get morning light,
 * whether the kitchen is dark by four in December, how deep the sun reaches
 * through a south window in June - those are questions about a property that a
 * buyer actually asks, and they have real answers as soon as the model knows
 * where it is.
 *
 * It knows because the address lookup already found out: the parcel's own
 * coordinates from the listing, and the bearing from the angle the building had
 * to be turned through to square it up against the map. So the answer here is
 * not a plausible-looking sweep, it is the sun over that roof.
 */

const RAD = Math.PI / 180;

/** A compass bearing (0 = north, clockwise) as a unit vector in plan space. */
export function planFromBearing(site: Site, bearingDeg: number): Vec2 {
  const b = (bearingDeg - site.planXBearing) * RAD;
  return [Math.cos(b), Math.cos(b - Math.PI / 2)];
}

/**
 * Solar altitude and azimuth for a day of the year and a local clock hour.
 *
 * The standard NOAA-style approximation. It is good to a fraction of a degree,
 * which is far finer than anything visible in a render - the reason to use the
 * real formula rather than a sine wave is not precision, it is that a sine wave
 * gets the *asymmetries* wrong: sunrise and sunset are not symmetric about
 * noon, and the difference between June and December at a given latitude is the
 * entire point.
 */
export function solarPosition(
  site: Site,
  dayOfYear: number,
  hour: number,
): { altitudeDeg: number; azimuthDeg: number } {
  // Longitude is the best timezone estimate available without a lookup table,
  // and it is what the equation of time wants anyway. Half-hour zones and
  // daylight saving shift the clock, not the sun; being an hour out moves the
  // shadows by fifteen degrees, which is wrong but not misleading.
  const timezone = Math.round(site.lon / 15);

  const b = (360 / 365) * (dayOfYear - 81) * RAD;
  const equationOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
  const declination = 23.45 * Math.sin(b);

  const standardMeridian = timezone * 15;
  const solarTime = hour + (4 * (site.lon - standardMeridian) + equationOfTime) / 60;
  const hourAngle = 15 * (solarTime - 12);

  const latR = site.lat * RAD;
  const decR = declination * RAD;
  const haR = hourAngle * RAD;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));

  const sinAlt = clamp(
    Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR),
  );
  const altitude = Math.asin(sinAlt);

  const cosAz = clamp(
    (Math.sin(decR) - Math.sin(altitude) * Math.sin(latR)) /
      (Math.cos(altitude) * Math.cos(latR) || 1e-9),
  );
  let azimuth = Math.acos(cosAz) / RAD;
  // Before solar noon the sun is in the east, after it the west. `acos` cannot
  // tell them apart, so the hour angle decides.
  if (hourAngle > 0) azimuth = 360 - azimuth;

  return { altitudeDeg: altitude / RAD, azimuthDeg: azimuth };
}

export type SunState = {
  /** Direction to the sun in world space, already scaled out to a distance. */
  direction: [number, number, number];
  /** 0 at night, 1 in full day. Everything else ramps off this. */
  day: number;
  /** Warm near the horizon, white overhead - the whole look of a time of day. */
  colour: [number, number, number];
  sky: [number, number, number];
  intensity: number;
  altitudeDeg: number;
  azimuthDeg: number;
};

/** Day of year for a date, which is all the solar model needs of a calendar. */
export function dayOfYear(month: number, day: number): number {
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return cumulative[Math.max(0, Math.min(11, month - 1))] + day;
}

const DISTANCE = 60;

/** Everything the scene needs to light itself at a given time. */
export function sunState(site: Site, dayOfYearValue: number, hour: number): SunState {
  const { altitudeDeg, azimuthDeg } = solarPosition(site, dayOfYearValue, hour);
  const [px, py] = planFromBearing(site, azimuthDeg);

  const altR = altitudeDeg * RAD;
  const horizontal = Math.cos(altR) * DISTANCE;

  // Brightness ramps in over the first thirty degrees, as it does in life -
  // a sun just above the horizon lights very little.
  const day = Math.max(0, Math.min(1, altitudeDeg / 30));
  const warmth = 1 - Math.min(1, Math.max(0, altitudeDeg) / 28);

  return {
    direction: [px * horizontal, Math.sin(altR) * DISTANCE, py * horizontal],
    day,
    colour: [1, 0.93 - 0.24 * warmth, 0.84 - 0.42 * warmth],
    sky: hslToRgb(0.58, 0.45, day < 0.03 ? 0.07 : 0.14 + 0.45 * day),
    intensity: 2.7 * day + 0.05,
    altitudeDeg,
    azimuthDeg,
  };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

/**
 * A coarse sample of the sky dome.
 *
 * Five directions, each casting a shadow, is enough to tell "under a window"
 * from "deep in the plan" without a shadow map per degree. This is what makes
 * an interior read as lit by the sky rather than by a lamp in the ceiling -
 * flat ambient gives every surface the same tone and nothing has form.
 */
export const SKY_RAYS: Array<{ direction: [number, number, number]; weight: number }> = [
  { direction: [0, 1, 0], weight: 0.3 },
  { direction: [0.283, 0.743, 0.606], weight: 0.15 },
  { direction: [0.606, 0.743, -0.283], weight: 0.15 },
  { direction: [-0.283, 0.743, -0.606], weight: 0.15 },
  { direction: [-0.606, 0.743, 0.283], weight: 0.15 },
];
