/**
 * The arithmetic that makes a satellite tile measurable.
 *
 * Kept apart from the fetching next door because it is pure, and because
 * `server-only` makes anything that imports it unrunnable outside a request -
 * which would put exactly the numbers most worth checking out of reach of a
 * test. The same split already exists between `plan/footprint.ts` and
 * `listing/footprint.ts`, for the same reason.
 */

/** Web Mercator's ground resolution at the equator, metres per pixel at zoom 0. */
const EQUATOR_MPP = 156_543.03392;

/** The largest image either API will return without a premium plan. */
export const TILE_PX = 640;

/**
 * `scale=2` returns twice the pixels over *the same ground*.
 *
 * This is the parameter most likely to be misread: it buys detail, not framing.
 * Coverage still follows from `zoom` alone, which is why the resolution below
 * divides by it and the zoom choice does not.
 *
 * It also does not exist on the Street View endpoint at all - that one is
 * capped at 640x640 - so it applies only to the overhead tile.
 */
export const TILE_SCALE = 2;

/** How much wider than the building the overhead frame should be. */
export const TILE_MARGIN = 1.8;

/** Compass bearing from one lat/lon to another, degrees clockwise from north. */
export function bearingBetween(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const midLat = ((from.lat + to.lat) / 2) * (Math.PI / 180);
  const east = (to.lon - from.lon) * Math.cos(midLat) * 111_320;
  const north = (to.lat - from.lat) * 111_320;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

/** Metres between two lat/lon points, near enough at the scale of a street. */
export function metresBetween(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const midLat = ((from.lat + to.lat) / 2) * (Math.PI / 180);
  return Math.hypot(
    (to.lon - from.lon) * Math.cos(midLat) * 111_320,
    (to.lat - from.lat) * 111_320,
  );
}

/**
 * A field of view that frames the building rather than its neighbours.
 *
 * The default 90 degrees spends about a third of the frame on whatever is next
 * door. Widening from the building's own angular size means a house set well
 * back gets a tighter shot and a house on the pavement gets a wider one, which
 * is the behaviour you would want from a photographer.
 */
export function fovForBuilding(widthM: number, distanceM: number): number {
  if (!(distanceM > 1) || !(widthM > 0)) return 90;
  const subtended = 2 * Math.atan(widthM / 2 / distanceM) * (180 / Math.PI);
  return Math.min(120, Math.max(60, Math.round(subtended * 1.35)));
}

/**
 * The zoom that fits the building in the frame, with room around it.
 *
 * Zoom is an integer, so framing lands within a factor of two of the ideal and
 * a house typically fills somewhere between a quarter and a half of the tile.
 * That is fine and not worth more machinery. The clamp matters more: above 21
 * Google upsamples silently, which looks sharp and carries no more detail than
 * the level below it.
 */
export function zoomForExtent(lat: number, extentM: number): number {
  if (!(extentM > 1)) return 20;
  const ideal = Math.log2((EQUATOR_MPP * Math.cos((lat * Math.PI) / 180) * TILE_PX) / (TILE_MARGIN * extentM));
  return Math.min(21, Math.max(17, Math.floor(ideal)));
}

/** Ground resolution of a returned tile, metres per pixel of the actual file. */
export function metresPerPixel(lat: number, zoom: number, scale = TILE_SCALE): number {
  return (EQUATOR_MPP * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom / scale;
}
