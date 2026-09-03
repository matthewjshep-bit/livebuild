import { planFromBearing } from "@/lib/model/sun";
import { boundsOf, centroid } from "@/lib/plan/geometry";
import { roomKind } from "@/lib/plan/room-kind";
import { type PlanSite, closestPointOnWays, roadWidth } from "@/lib/site/plan-site";
import type { Plan, Vec2 } from "@/lib/schema";

/**
 * The lot, worked out from what the map does know.
 *
 * No data source has the parcel. OpenStreetMap has the building and the
 * roads; the county's parcel layer is not on offer. So the lot is derived:
 * the house, the nearest road as its front edge, typical setbacks on the
 * other sides shortened where a neighbour or a second road is closer, and
 * the whole thing cut back from every road edge so a lawn never lies on the
 * asphalt when the road runs at an angle to the house.
 *
 * Derived every time and never stored, so a better rule fixes every house.
 * And labelled as an estimate wherever it is shown, because it is one.
 */

export type Rect = { x0: number; y0: number; x1: number; y1: number };
export type Side = "-y" | "+y" | "-x" | "+x";

export type Lot = {
  polygon: Vec2[];
  front: { side: Side; street: string | null; kerb: Vec2 | null };
  /** Where the front door is, on the front wall. */
  frontDoor: Vec2;
  setbacks: { front: number; rear: number; left: number; right: number };
  /** Facing the house from the street, which side the drive comes in on. */
  drivewaySide: "left" | "right";
  estimated: true;
};

const SIDES: Side[] = ["-y", "+y", "-x", "+x"];
const NORMAL: Record<Side, Vec2> = { "-y": [0, -1], "+y": [0, 1], "-x": [-1, 0], "+x": [1, 0] };
const OPPOSITE: Record<Side, Side> = { "-y": "+y", "+y": "-y", "-x": "+x", "+x": "-x" };

/** The verge: kerb to the lot line, which a pavement usually occupies. */
const VERGE = 1.5;

/** The house's footprint on the ground: the lowest storey, indoors only. */
export function houseBounds(plan: Plan): Rect | null {
  const level = Math.min(...plan.rooms.map((r) => r.level));
  const rooms = plan.rooms.filter((r) => r.level === level && roomKind(r.label) !== "outside");
  if (rooms.length === 0) return null;
  return boundsOf(rooms.flatMap((r) => r.polygon));
}

function centreOf(r: Rect): Vec2 {
  return [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
}

/** The midpoint of one side of a rectangle. */
function sideMid(r: Rect, side: Side): Vec2 {
  const c = centreOf(r);
  switch (side) {
    case "-y":
      return [c[0], r.y0];
    case "+y":
      return [c[0], r.y1];
    case "-x":
      return [r.x0, c[1]];
    case "+x":
      return [r.x1, c[1]];
  }
}

/** Which side of the rectangle a direction leaves through. */
function sideFacing(dir: Vec2): Side {
  let best: Side = "+y";
  let score = -Infinity;
  for (const side of SIDES) {
    const n = NORMAL[side];
    const d = n[0] * dir[0] + n[1] * dir[1];
    if (d > score) {
      score = d;
      best = side;
    }
  }
  return best;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Streets first, lanes and slip roads after. */
function roadRank(kind: string | null): number {
  return kind === "living_street" || (kind ?? "").endsWith("_link") ? 1 : 0;
}

/**
 * How far from a side the nearest road is, measured outward along its normal,
 * and how wide that road is. Null when no road lies on that side.
 */
function roadBeyond(house: Rect, side: Side, site: PlanSite | null): { distance: number; width: number; name: string } | null {
  if (!site) return null;
  const mid = sideMid(house, side);
  const n = NORMAL[side];
  let best: { distance: number; width: number; name: string } | null = null;
  for (const street of site.streets) {
    const near = closestPointOnWays(street.ways, mid);
    if (!near) continue;
    const outward = (near.point[0] - mid[0]) * n[0] + (near.point[1] - mid[1]) * n[1];
    // A road that is beside rather than beyond this side belongs to another.
    if (outward < 0.5) continue;
    const sideways = Math.abs((near.point[0] - mid[0]) * n[1] - (near.point[1] - mid[1]) * n[0]);
    if (sideways > outward * 1.2 + 8) continue;
    if (!best || outward < best.distance) best = { distance: outward, width: roadWidth(street.kind), name: street.name };
  }
  return best;
}

const OUTBUILDINGS = new Set(["garage", "garages", "shed", "carport", "hut", "roof", "greenhouse", "cabin"]);

/** How far a building's bounds stand from the house's, or zero if they touch. */
function gapBetween(house: Rect, r: Rect): number {
  const dx = Math.max(r.x0 - house.x1, house.x0 - r.x1, 0);
  const dy = Math.max(r.y0 - house.y1, house.y0 - r.y1, 0);
  return Math.hypot(dx, dy);
}

/**
 * A garage or shed within a few metres of the house is this house's.
 *
 * It must not shorten the setbacks - the first version treated it as a
 * neighbour, cut the side to a metre and a half, and so put the garage
 * outside the lot it stands on - and the lot has to reach past it.
 */
export function isOutbuildingOf(house: Rect, b: { outline: Vec2[]; kind: string | null }): boolean {
  return OUTBUILDINGS.has(b.kind ?? "") && gapBetween(house, boundsOf(b.outline)) <= 12;
}

/**
 * The nearest neighbour beyond a side, as the gap between the two buildings,
 * for a neighbour that actually stands across from that side.
 */
function neighbourGap(house: Rect, side: Side, site: PlanSite | null): number | null {
  if (!site) return null;
  const n = NORMAL[side];
  const horizontal = side === "-x" || side === "+x";
  let best: number | null = null;
  for (const b of site.buildings) {
    if (isOutbuildingOf(house, b)) continue;
    const r = boundsOf(b.outline);
    // Overlap along the side's own axis: across from it, not diagonal.
    const overlap = horizontal
      ? Math.min(house.y1, r.y1) - Math.max(house.y0, r.y0)
      : Math.min(house.x1, r.x1) - Math.max(house.x0, r.x0);
    if (overlap <= 0.5) continue;
    const gap =
      side === "-x" ? house.x0 - r.x1 : side === "+x" ? r.x0 - house.x1 : side === "-y" ? house.y0 - r.y1 : r.y0 - house.y1;
    void n;
    if (gap <= 0) continue;
    if (best === null || gap < best) best = gap;
  }
  return best;
}

/** Clip a convex polygon to the half-plane on `inside`'s side of the line a→b. */
function clipToLine(polygon: Vec2[], a: Vec2, b: Vec2, inside: Vec2): Vec2[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const sideOf = (p: Vec2) => dx * (p[1] - a[1]) - dy * (p[0] - a[0]);
  const keep = Math.sign(sideOf(inside)) || 1;
  const out: Vec2[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    const sp = sideOf(p) * keep;
    const sq = sideOf(q) * keep;
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

export function deriveLot(input: {
  house: Rect;
  site: PlanSite | null;
  frontDoorBearing?: number | null;
  garageBearing?: number | null;
  planXBearing?: number | null;
}): Lot {
  const { house, site } = input;
  const c = centreOf(house);
  const bearingSite = { lat: 0, lon: 0, planXBearing: input.planXBearing ?? 90 };
  const toPlan = (bearing: number): Vec2 => planFromBearing(bearingSite, bearing);

  // --- the front: the nearest road, else the door's bearing, else +y ---
  let frontSide: Side = "+y";
  let frontStreet: string | null = null;
  let kerb: Vec2 | null = null;
  // The nearest road fronts the house - among roads of the same standing. A
  // lane behind is nearer than the street in front on half the terraces in
  // the country, and nobody's front door opens onto it.
  const nearest = site?.streets
    .map((s) => ({ street: s, near: closestPointOnWays(s.ways, c), rank: roadRank(s.kind) }))
    .filter((x): x is { street: PlanSite["streets"][number]; near: NonNullable<ReturnType<typeof closestPointOnWays>>; rank: number } => Boolean(x.near))
    .sort((a, b) => a.rank - b.rank || a.near.distance - b.near.distance)[0];
  if (nearest) {
    frontSide = sideFacing([nearest.near.point[0] - c[0], nearest.near.point[1] - c[1]]);
    frontStreet = nearest.street.name;
    // The kerb: the road's centreline point, pulled to its near edge.
    const p = nearest.near.point;
    const back = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1;
    const half = roadWidth(nearest.street.kind) / 2;
    kerb = [p[0] + ((c[0] - p[0]) / back) * half, p[1] + ((c[1] - p[1]) / back) * half];
  } else if (typeof input.frontDoorBearing === "number") {
    frontSide = sideFacing(toPlan(input.frontDoorBearing));
  }
  const rearSide = OPPOSITE[frontSide];
  const f = NORMAL[frontSide];
  // Facing the house from the street you look along -f. In a plan whose y
  // runs down the page, standing north of a house (f = -y) and facing it,
  // your left hand points east (+x): left is (-f.y, f.x).
  const leftAxis: Vec2 = [-f[1], f[0]];
  const leftSide = sideFacing(leftAxis);
  const rightSide = OPPOSITE[leftSide];

  // --- setbacks ---
  const setbackFor = (side: Side): number => {
    const road = roadBeyond(house, side, site);
    const isFront = side === frontSide;
    const isRear = side === rearSide;
    let setback = isFront ? 7.5 : isRear ? 9 : 3;
    if (isFront && road) setback = clamp(road.distance - road.width / 2 - VERGE, 3, 25);
    const gap = neighbourGap(house, side, site);
    if (!isFront && gap !== null) setback = isRear ? clamp(gap / 2, 3, 20) : clamp(gap / 2, 1.5, 12);
    // A road nearer than the setback cuts it, on any side.
    if (road && !isFront) setback = Math.min(setback, Math.max(1.5, road.distance - road.width / 2 - VERGE));
    return setback;
  };
  const setbacks = {
    front: setbackFor(frontSide),
    rear: setbackFor(rearSide),
    left: setbackFor(leftSide),
    right: setbackFor(rightSide),
  };
  const bySide: Record<Side, number> = {
    [frontSide]: setbacks.front,
    [rearSide]: setbacks.rear,
    [leftSide]: setbacks.left,
    [rightSide]: setbacks.right,
  } as Record<Side, number>;

  // The lot reaches past the house's own garage or shed, whichever side it
  // stands on - stopping short of the neighbour beyond it.
  if (site) {
    for (const b of site.buildings) {
      if (!isOutbuildingOf(house, b)) continue;
      const r = boundsOf(b.outline);
      const reach: Record<Side, number> = {
        "-x": house.x0 - r.x0 + 1,
        "+x": r.x1 - house.x1 + 1,
        "-y": house.y0 - r.y0 + 1,
        "+y": r.y1 - house.y1 + 1,
      };
      for (const side of SIDES) {
        if (reach[side] <= bySide[side]) continue;
        const gap = neighbourGap(house, side, site);
        bySide[side] = gap === null ? reach[side] : Math.min(reach[side], Math.max(gap - 0.5, bySide[side]));
      }
    }
    setbacks.front = bySide[frontSide];
    setbacks.rear = bySide[rearSide];
    setbacks.left = bySide[leftSide];
    setbacks.right = bySide[rightSide];
  }

  let polygon: Vec2[] = [
    [house.x0 - bySide["-x"], house.y0 - bySide["-y"]],
    [house.x1 + bySide["+x"], house.y0 - bySide["-y"]],
    [house.x1 + bySide["+x"], house.y1 + bySide["+y"]],
    [house.x0 - bySide["-x"], house.y1 + bySide["+y"]],
  ];

  // --- cut back from every road edge within reach ---
  if (site) {
    for (const street of site.streets) {
      const half = roadWidth(street.kind) / 2 + 0.3;
      for (const way of street.ways) {
        for (let i = 1; i < way.length; i++) {
          const a = way[i - 1];
          const b = way[i];
          const near = closestPointOnWays([[a, b]], c);
          if (!near || near.distance > 60) continue;
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const len = Math.hypot(dx, dy) || 1;
          // The road edge on the house's side of the centreline.
          const towardHouse = Math.sign(dx * (c[1] - a[1]) - dy * (c[0] - a[0])) || 1;
          const nx = (-dy / len) * towardHouse;
          const ny = (dx / len) * towardHouse;
          const ea: Vec2 = [a[0] + nx * half, a[1] + ny * half];
          const eb: Vec2 = [b[0] + nx * half, b[1] + ny * half];
          polygon = clipToLine(polygon, ea, eb, c);
          if (polygon.length < 3) break;
        }
      }
    }
  }
  if (polygon.length < 3) {
    polygon = [
      [house.x0 - 1.5, house.y0 - 1.5],
      [house.x1 + 1.5, house.y0 - 1.5],
      [house.x1 + 1.5, house.y1 + 1.5],
      [house.x0 - 1.5, house.y1 + 1.5],
    ];
  }

  // --- the front door: where the bearing leaves the front wall, else its middle ---
  let frontDoor = sideMid(house, frontSide);
  if (typeof input.frontDoorBearing === "number") {
    const d = toPlan(input.frontDoorBearing);
    const along = d[0] * f[0] + d[1] * f[1];
    if (along > 0.2) {
      const halfDepth = frontSide === "-y" || frontSide === "+y" ? (house.y1 - house.y0) / 2 : (house.x1 - house.x0) / 2;
      const t = halfDepth / along;
      const hit: Vec2 = [c[0] + d[0] * t, c[1] + d[1] * t];
      frontDoor =
        frontSide === "-y" || frontSide === "+y"
          ? [clamp(hit[0], house.x0 + 0.6, house.x1 - 0.6), frontDoor[1]]
          : [frontDoor[0], clamp(hit[1], house.y0 + 0.6, house.y1 - 0.6)];
    }
  }

  // --- the drive: toward the garage - the map's own garage on this lot
  // first, then the read's bearing - else the wider side ---
  let drivewaySide: "left" | "right" = setbacks.left >= setbacks.right ? "left" : "right";
  const garageOnLot = site?.buildings.find((b) => isOutbuildingOf(house, b) && /garage|carport/.test(b.kind ?? ""));
  if (garageOnLot) {
    const gc = centroid(garageOnLot.outline);
    drivewaySide = (gc[0] - c[0]) * leftAxis[0] + (gc[1] - c[1]) * leftAxis[1] >= 0 ? "left" : "right";
  } else if (typeof input.garageBearing === "number") {
    const g = toPlan(input.garageBearing);
    drivewaySide = g[0] * leftAxis[0] + g[1] * leftAxis[1] >= 0 ? "left" : "right";
  }

  return {
    polygon,
    front: { side: frontSide, street: frontStreet, kerb },
    frontDoor,
    setbacks,
    drivewaySide,
    estimated: true,
  };
}
