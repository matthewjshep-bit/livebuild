import type { Footprint } from "@/lib/plan/footprint";
import type { Vec2 } from "@/lib/schema";

/**
 * Getting the map and the drawing into the same coordinates.
 *
 * A plan is the building's outline projected about its own centroid, rotated
 * until its walls are straight, moved so its corner sits at zero, and sometimes
 * scaled to agree with the listing's floor area. Four steps, all of them
 * happening inside `prepareFootprint`, and until now only the rotation survived
 * - which is why the satellite image the app already fetches could never be put
 * behind the layout it describes.
 *
 * All of it is written down here rather than re-derived at the call site,
 * because this is the arithmetic most likely to be silently wrong. Two sign
 * conventions meet: latitude increases northwards and screen y increases
 * downwards, and a plan that is flipped or turned the wrong way looks entirely
 * plausible on a house that is roughly symmetrical. So the inverse is written
 * too, and the test round-trips through both - a transform that is its own
 * inverse's inverse cannot be off by a sign.
 */

/** Metres per degree of latitude. A house is small enough for plate-carrée. */
const M_PER_DEG_LAT = 111_320;

export type PlanFrame = NonNullable<Footprint["frame"]>;

const metresPerDegLon = (lat: number) => Math.cos((lat * Math.PI) / 180) * M_PER_DEG_LAT;

/**
 * Rotate about the origin, matching `footprint.ts`'s own convention.
 *
 * Deliberately the same negation: `rotate(points, d)` there turns by `-d`
 * radians, and a frame that disagreed with the packer by a sign would put the
 * house neatly beside its own photograph.
 */
function turn([x, y]: Vec2, degrees: number): Vec2 {
  const r = (-degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [x * cos - y * sin, x * sin + y * cos];
}

/** Where a point on the map lands on the plan, in plan metres. */
export function latLonToPlan(frame: PlanFrame, lat: number, lon: number): Vec2 {
  const local: Vec2 = [
    (lon - frame.centre.lon) * metresPerDegLon(frame.centre.lat),
    -(lat - frame.centre.lat) * M_PER_DEG_LAT,
  ];
  const [x, y] = turn(local, frame.rotationDeg);
  return [(x - frame.offset[0]) * frame.scale, (y - frame.offset[1]) * frame.scale];
}

/** Where a point on the plan sits on the map. */
export function planToLatLon(frame: PlanFrame, point: Vec2): [number, number] {
  const rotated: Vec2 = [
    point[0] / frame.scale + frame.offset[0],
    point[1] / frame.scale + frame.offset[1],
  ];
  const [x, y] = turn(rotated, -frame.rotationDeg);
  return [
    frame.centre.lat - y / M_PER_DEG_LAT,
    frame.centre.lon + x / metresPerDegLon(frame.centre.lat),
  ];
}

export type TilePlacement = {
  /** Applied to the group, outermost first, exactly as SVG composes them. */
  transform: string;
  /** Where to put the image inside that group, and how big, in metres. */
  x: number;
  y: number;
  size: number;
};

/**
 * Put a north-up satellite tile behind a plan-space drawing.
 *
 * The tile's axes are the *unrotated* local ones - east is right, south is down
 * - which is exactly the space the plan is derived from, so the whole placement
 * is the same three steps in the same order rather than anything new. The image
 * therefore goes in local metres and the group carries the rotation, the corner
 * shift and the area nudge.
 *
 * Composed as scale ∘ translate ∘ rotate, matching `latLonToPlan` term for
 * term. The rotation is negated because SVG turns clockwise on a downward y
 * while `footprint.ts` counts the other way.
 */
export function tilePlacement(
  frame: PlanFrame,
  tile: { lat: number; lon: number; sizePx: number; metresPerPixel: number },
): TilePlacement {
  const metres = tile.sizePx * tile.metresPerPixel;

  // The tile's centre in unrotated local metres, which is where the image sits
  // before the group transform turns it onto the plan.
  const centreLocal: Vec2 = [
    (tile.lon - frame.centre.lon) * metresPerDegLon(frame.centre.lat),
    -(tile.lat - frame.centre.lat) * M_PER_DEG_LAT,
  ];

  return {
    transform: `scale(${frame.scale}) translate(${-frame.offset[0]} ${-frame.offset[1]}) rotate(${-frame.rotationDeg})`,
    x: centreLocal[0] - metres / 2,
    y: centreLocal[1] - metres / 2,
    size: metres,
  };
}

/**
 * How wide a tile has to be to cover the whole plan, in metres.
 *
 * Asked for generously and then some: a tile that stops short of the outline
 * leaves the user drawing part of the house against a black background, which
 * reads as a missing wing rather than as a missing tile.
 */
export function tileExtentFor(footprint: Footprint): number {
  const xs = footprint.outline.map((p) => p[0]);
  const ys = footprint.outline.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return Math.max(30, Math.ceil((span * 1.6) / 5) * 5);
}
