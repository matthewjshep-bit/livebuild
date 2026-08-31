import { TILE_PX, TILE_SCALE } from "@/lib/site/geo";

/**
 * A building's outline, recovered from the satellite frame.
 *
 * The map is the first place to ask and usually answers. When it does not -
 * newer subdivisions and most of the rural map have no building drawn at all -
 * the alternative until now was packing rooms into a rectangle invented from
 * nothing, which produces a grid rather than a house.
 *
 * This is the half of the old objection that no longer holds. `listing/
 * footprint.ts` rejected satellite tracing for two reasons, and the second was
 * that "tracing an outline out of a JPEG means recovering vectors that somebody
 * already has". Nobody has these. The first reason - Google's terms - stands,
 * and was reversed deliberately, against the operator's own key.
 *
 * Kept pure and away from the fetching so the arithmetic can be checked without
 * a network. Every failure here is silent: a mirrored building still tiles, a
 * transposed one still packs, and both look plausible on a house that happens
 * to be symmetric.
 */

/** Metres per degree of latitude - `toLocalMetres`' own constant, matched on
 *  purpose so a ring lands in exactly the frame it will be re-projected from. */
const M_PER_DEG_LAT = 111_320;

/** The satellite file is `size=640x640` at `scale=2`. */
export const TRACE_FRAME_PX = TILE_PX * TILE_SCALE;

export type Pixel = [number, number];

/**
 * Pixels in the satellite tile to a `[lat, lon]` ring.
 *
 * The output is the same shape OpenStreetMap returns, so `prepareFootprint` and
 * everything after it cannot tell where the ring came from - which is the whole
 * point, and why nothing downstream needs to change.
 *
 * Three things to get right, all of which fail quietly:
 *
 * - **Latitude first.** A `[lon, lat]` ring still produces a polygon; it is
 *   simply rotated and squashed, and looks like a badly traced house rather
 *   than a coordinate bug.
 * - **The y sign is negated exactly once, here.** Image rows run south and
 *   `toLocalMetres` also runs y south, so the flip belongs in the latitude term
 *   and nowhere else. `listing/footprint.ts` has a projection that runs y
 *   *north*; reusing it would mirror the building vertically.
 * - **The frame is centred on the point that was searched**, not on the
 *   building. A house sits wherever it sits in the parcel, and it usually is
 *   not the middle.
 */
export function pixelsToRing(
  pixels: Pixel[],
  centre: { lat: number; lon: number },
  metresPerPixel: number,
  framePx: number = TRACE_FRAME_PX,
): Array<[number, number]> {
  const half = framePx / 2;
  const lonScale = Math.cos((centre.lat * Math.PI) / 180) * M_PER_DEG_LAT;

  return pixels.map(([u, v]) => {
    const east = (u - half) * metresPerPixel;
    const north = -(v - half) * metresPerPixel;
    return [centre.lat + north / M_PER_DEG_LAT, centre.lon + east / lonScale] as [number, number];
  });
}

/** Square metres of a `[lat, lon]` ring, near enough at the scale of a house. */
function ringAreaSqm(ring: Array<[number, number]>): number {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lonScale = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG_LAT;
  const local = ring.map(([lat, lon]) => [lon * lonScale, lat * M_PER_DEG_LAT] as [number, number]);

  let sum = 0;
  for (let i = 0; i < local.length; i++) {
    const a = local[i];
    const b = local[(i + 1) % local.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

/** Longest and shortest side of the ring's bounding box, in metres. */
function ringExtent(ring: Array<[number, number]>): { long: number; short: number } {
  const lat0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lonScale = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG_LAT;
  const xs = ring.map(([, lon]) => lon * lonScale);
  const ys = ring.map(([lat]) => lat * M_PER_DEG_LAT);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return { long: Math.max(w, h), short: Math.min(w, h) };
}

const SQM_PER_SQFT = 0.092903;

/**
 * Is this outline worth building a house on.
 *
 * A traced shape is only useful if it is the right building, and the two ways
 * it goes wrong are picking the garage and picking the whole parcel. Neither
 * announces itself, so the gate is on size and proportion - a dwelling is not
 * 200 square feet and is not eight times longer than it is wide.
 *
 * Refusing is cheap: the caller falls back to a rectangle, which is what would
 * have happened anyway. Accepting a bad trace is not, because every room in the
 * house is then packed into the wrong shape.
 */
export function outlineIsPlausible(
  ring: Array<[number, number]>,
): { ok: true } | { ok: false; why: string } {
  if (ring.length < 4) return { ok: false, why: "fewer than four corners" };

  const sqft = ringAreaSqm(ring) / SQM_PER_SQFT;
  if (sqft < 400) return { ok: false, why: `only ${Math.round(sqft)} sqft - probably an outbuilding` };
  if (sqft > 8000) return { ok: false, why: `${Math.round(sqft)} sqft - probably the whole parcel` };

  const { long, short } = ringExtent(ring);
  if (short < 3) return { ok: false, why: "narrower than a corridor" };
  if (long / short > 4) {
    return { ok: false, why: `${(long / short).toFixed(1)}:1 - too long and thin for a house` };
  }

  return { ok: true };
}

/**
 * A rectangle with a house's proportions, when nothing better is known.
 *
 * Not a square. `autoLayout` effectively aims at 1.56:1 and then never enforces
 * it, and a real single-storey house is longer still - so this is deliberately
 * wide and shallow, which is what makes a ranch read as a ranch instead of as a
 * block of flats.
 *
 * Returned as a `[lat, lon]` ring rather than as metres so it goes down exactly
 * the same path as a surveyed outline and a traced one. Three sources, one
 * pipeline, one set of invariants.
 */
export function syntheticRing(
  centre: { lat: number; lon: number },
  groundSqft: number,
  aspect = 1.8,
): Array<[number, number]> {
  const sqm = Math.max(groundSqft, 400) * SQM_PER_SQFT;
  const depth = Math.sqrt(sqm / aspect);
  const width = depth * aspect;

  const lonScale = Math.cos((centre.lat * Math.PI) / 180) * M_PER_DEG_LAT;
  const dLat = depth / 2 / M_PER_DEG_LAT;
  const dLon = width / 2 / lonScale;

  return [
    [centre.lat - dLat, centre.lon - dLon],
    [centre.lat - dLat, centre.lon + dLon],
    [centre.lat + dLat, centre.lon + dLon],
    [centre.lat + dLat, centre.lon - dLon],
  ];
}
