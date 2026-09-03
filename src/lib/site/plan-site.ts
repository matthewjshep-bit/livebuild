import { type PlanFrame, latLonToPlan } from "@/lib/site/frame";
import type { Site, Vec2 } from "@/lib/schema";

/**
 * The surroundings, in the plan's own metres.
 *
 * `Property.site` keeps streets and neighbours as the map holds them, in
 * latitude and longitude, beside the frame the building was squared up in.
 * This is the one place they are projected - through `latLonToPlan`, which
 * `frame-test` round-trips to under a millimetre - so the roads land at their
 * true angle and distance to the walls and nothing else in the model has to
 * know that two sign conventions meet in the projection.
 *
 * Null without a frame. A house drawn by hand, or built before the frame was
 * kept, has no surroundings, and everything that draws them draws nothing.
 */

export type PlanStreet = { name: string; kind: string | null; ways: Vec2[][] };
export type PlanBuilding = { outline: Vec2[]; kind: string | null; heightM: number };
export type PlanSite = {
  streets: PlanStreet[];
  buildings: PlanBuilding[];
  attribution: string[];
};

/** Shown wherever the map's data is drawn. ODbL asks for it. */
export const SITE_ATTRIBUTION = "Map data © OpenStreetMap contributors (ODbL)";

export function siteInPlan(site: Site | null | undefined): PlanSite | null {
  if (!site?.frame) return null;
  const frame = site.frame as PlanFrame;
  const to = ([lat, lon]: [number, number]): Vec2 => latLonToPlan(frame, lat, lon);
  return {
    streets: (site.streets ?? []).map((s) => ({
      name: s.name,
      kind: s.kind ?? null,
      ways: s.ways.map((way) => way.map(to)),
    })),
    buildings: (site.buildings ?? []).map((b) => ({
      outline: b.ring.map(to),
      kind: b.kind ?? null,
      heightM: buildingHeight(b),
    })),
    attribution: site.attribution ?? [],
  };
}

const LOW = new Set(["garage", "garages", "shed", "carport", "hut", "roof", "greenhouse", "cabin"]);

/**
 * How tall a neighbour is drawn.
 *
 * Metres when the map says metres, storeys at 3.2 m when it says storeys,
 * and otherwise two storeys for a building and one for a garage or shed -
 * which is what most of them are, and a wrong guess about next door is a
 * grey block a little too tall rather than a wrong claim about this house.
 */
export function buildingHeight(b: { heightM?: number | null; levels?: number | null; kind?: string | null }): number {
  if (b.heightM && b.heightM > 0) return b.heightM;
  if (b.levels && b.levels > 0) return b.levels * 3.2;
  return LOW.has(b.kind ?? "") ? 2.8 : 6;
}

/** Kerb to kerb, by the `highway` tag. Residential is the common case. */
export function roadWidth(kind: string | null | undefined): number {
  switch (kind) {
    case "motorway":
      return 14;
    case "trunk":
    case "primary":
      return 12;
    case "secondary":
      return 10;
    case "tertiary":
      return 9;
    case "living_street":
      return 5.5;
    default:
      return 7;
  }
}

/**
 * Where a road passes a point, and which way it runs there.
 *
 * Lifted from the drawing pad, which labels each street at the point nearest
 * the building: the middle of a road is off the edge of anything that shows a
 * house, and the point nearest the house is on screen by construction. The
 * same point is where a lot's front edge is measured from.
 */
export function closestPointOnWays(
  ways: Vec2[][],
  from: Vec2,
): { point: Vec2; along: Vec2; distance: number } | null {
  let best: { point: Vec2; along: Vec2; distance: number } | null = null;
  for (const way of ways) {
    for (let i = 1; i < way.length; i++) {
      const a = way[i - 1];
      const b = way[i];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t =
        len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((from[0] - a[0]) * dx + (from[1] - a[1]) * dy) / len2));
      const point: Vec2 = [a[0] + dx * t, a[1] + dy * t];
      const distance = Math.hypot(point[0] - from[0], point[1] - from[1]);
      if (!best || distance < best.distance) best = { point, along: [dx, dy], distance };
    }
  }
  return best;
}
