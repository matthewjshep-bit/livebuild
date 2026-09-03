import type { Box } from "@/lib/model/furniture";
import { boundsOf, pointInPolygon } from "@/lib/plan/geometry";
import type { Lot, Rect, Side } from "@/lib/site/lot";
import type { LandscapeFeature } from "@/lib/spec/schema";
import type { Vec2 } from "@/lib/schema";

/**
 * The garden, from what the photographs said is in it.
 *
 * The reader returns a list - a tree left of the door, a fence along the
 * street, an asphalt drive on the right - and this puts each thing where
 * that kind of thing goes on the lot the map gave us. Deterministic: the
 * same read on the same lot plants the same garden, and every rule can be
 * checked on its own. Nothing here is stored; it is worked out from the spec
 * and the lot each time, so a better rule replants every house.
 *
 * Without a read, the house still gets a door, a path to the street and a
 * driveway, because a house has those. Nothing else is invented.
 */

export type Landscape = {
  /** The front door, on the front wall. */
  door: Box | null;
  /** From the door to the front lot line, a metre wide. */
  path: Vec2[] | null;
  driveway: { polygon: Vec2[]; material: "concrete" | "asphalt" | "gravel" } | null;
  porch: Box[];
  steps: Box[];
  fence: Array<{ a: Vec2; b: Vec2; heightM: number; colour: string }>;
  trees: Array<{ at: Vec2; heightM: number; trunkR: number; canopyR: number; shape: "round" | "cone"; colour: string }>;
  shrubs: Array<{ at: Vec2; r: number; colour: string }>;
  hedges: Array<{ a: Vec2; b: Vec2; heightM: number; depthM: number; colour: string }>;
  outbuildings: Array<{ rect: Rect; eaveM: number; kind: "garage" | "shed" }>;
};

const NORMAL: Record<Side, Vec2> = { "-y": [0, -1], "+y": [0, 1], "-x": [-1, 0], "+x": [1, 0] };

const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
/** 0 dark to 1 light, for a hex; 0 for anything else. */
function luminance(hex: string | null | undefined): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
const add = (a: Vec2, b: Vec2, k = 1): Vec2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const corners = (r: Rect): Vec2[] => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
const extent = (points: Vec2[], axis: Vec2) => points.reduce((m, p) => Math.max(m, dot(p, axis)), -Infinity);

const TREE_SIZE = { s: { h: 4, canopy: 1.5, trunk: 0.12 }, m: { h: 6, canopy: 2.5, trunk: 0.2 }, l: { h: 9, canopy: 3.5, trunk: 0.3 } };
const CANOPY = "#4f6b3f";
const CONIFER = "#3b5a3a";
const SHRUB = "#3f5a34";
const HEDGE = "#3a5a32";
const TIMBER = "#8a6a45";
const WHITE = "#f0ede6";
const CONCRETE = "#b9b5ad";

/** A box in plan metres: centre on the ground plane, y up. */
function box(at: Vec2, y: number, along: Vec2, w: number, h: number, d: number, colour: string): Box {
  // `along` is the box's width axis; it is always one of the plan's axes here.
  const horizontal = Math.abs(along[0]) > Math.abs(along[1]);
  return { center: [at[0], y, at[1]], size: horizontal ? [w, h, d] : [d, h, w], colour };
}

export function landscapeFor(input: {
  lot: Lot;
  house: Rect;
  features: LandscapeFeature[];
  /** Buildings the map placed on this lot. */
  outbuildings: Array<{ outline: Vec2[]; kind: string | null }>;
  garageBays?: number | null;
  doorColour?: string | null;
}): Landscape {
  const { lot, house, features } = input;
  const f = NORMAL[lot.front.side];
  const left: Vec2 = [-f[1], f[0]];
  const right: Vec2 = [f[1], -f[0]];
  const has = (kind: LandscapeFeature["kind"]) => features.filter((x) => x.kind === kind);
  const inLot = (p: Vec2) => pointInPolygon(p, lot.polygon);
  const houseCorners = corners(house);
  const houseFront = extent(houseCorners, f);
  const houseRear = -extent(houseCorners, [-f[0], -f[1]]);
  const frontLine = extent(lot.polygon, f);

  // --- the door: where the lot put it, which is already off any window ---
  const door = lot.frontDoor;
  // Proud of the cladding. An exterior wall stands wholly outside the room's
  // polygon - the full twenty centimetres of it - and the siding a hand
  // outside that; the first door was sixteen centimetres out, inside the
  // wall, and rendered faithfully where nobody could see it.
  const doorBox = box(add(door, f, 0.26), 1.025, left, 0.9, 2.05, 0.06, input.doorColour ?? "#3c3f42");

  // --- the path: door to the front lot line ---
  const reach = frontLine - dot(door, f);
  const path: Vec2[] | null =
    reach > 0.5
      ? [add(add(door, left, 0.5), f, 0.05), add(add(door, right, 0.5), f, 0.05), add(add(door, right, 0.5), f, reach), add(add(door, left, 0.5), f, reach)]
      : null;

  // --- outbuildings: the map's, then a read garage or shed without a ring ---
  const outbuildings: Landscape["outbuildings"] = input.outbuildings.map((b) => ({
    rect: boundsOf(b.outline),
    eaveM: /shed|hut|cabin/.test(b.kind ?? "") ? 2.2 : 2.6,
    kind: /shed|hut|cabin/.test(b.kind ?? "") ? "shed" : "garage",
  }));
  const driveAxis = lot.drivewaySide === "left" ? left : right;
  const houseEdge = extent(houseCorners, driveAxis);
  const lotEdgeOnDriveSide = extent(lot.polygon, driveAxis);
  const garageRing = outbuildings.find((o) => o.kind === "garage");
  let driveWidth = (input.garageBays ?? 0) >= 2 ? 5.5 : 3;
  if (garageRing) {
    const across = extent(corners(garageRing.rect), left) + extent(corners(garageRing.rect), right);
    if (across >= 5.5) driveWidth = 5.5;
  }
  for (const kind of ["garage", "shed"] as const) {
    if (has(kind).length === 0 || outbuildings.some((o) => o.kind === kind)) continue;
    const w = kind === "garage" ? 6 : 2.4;
    const d = kind === "garage" ? 6 : 3;
    // A garage beside the house on the drive's side, its front face level
    // with the house's rear; when the side strip is too narrow for one, as
    // it is on most lots, behind the house at the drive-side corner, where
    // the drive can still reach it past the house. A shed goes in the far
    // corner. Either way, only if it stands on the lot.
    const placements: Array<[number, number]> =
      kind === "garage"
        ? [
            [houseEdge + 0.6 + w / 2, houseRear],
            [lotEdgeOnDriveSide - 0.5 - w / 2, houseRear],
          ]
        : [[lotEdgeOnDriveSide - 1 - w / 2, houseRear - 4]];
    for (const [centreAcross, frontFace] of placements) {
      const a = add(add([0, 0], driveAxis, centreAcross - w / 2), f, frontFace - d);
      const b = add(add([0, 0], driveAxis, centreAcross + w / 2), f, frontFace);
      const rect: Rect = { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
      if (corners(rect).every(inLot)) {
        outbuildings.push({ rect, eaveM: kind === "garage" ? 2.6 : 2.2, kind });
        break;
      }
    }
  }

  // --- the driveway: from the street to the house, or to the garage behind it ---
  const garage = outbuildings.find((o) => o.kind === "garage");
  const driveGap = lotEdgeOnDriveSide - houseEdge;
  const width = Math.min(driveWidth, Math.max(2.4, driveGap - 0.6));
  let driveway: Landscape["driveway"] = null;
  if (driveGap >= 3) {
    // Beside the house. Centred on the garage only when the garage itself
    // stands beside the house; a garage behind it is reached past the house.
    const garageAcross = garage
      ? [dot([garage.rect.x0, garage.rect.y0], driveAxis), dot([garage.rect.x1, garage.rect.y1], driveAxis)]
      : null;
    const across =
      garageAcross && Math.min(...garageAcross) >= houseEdge - 0.5
        ? (garageAcross[0] + garageAcross[1]) / 2
        : houseEdge + 0.3 + width / 2;
    const back = garage ? extent(corners(garage.rect), f) : houseFront;
    const start = Math.min(back, houseFront);
    const p = (a: number, l: number): Vec2 => add(add([0, 0], driveAxis, a), f, l);
    driveway = {
      polygon: [p(across - width / 2, start), p(across + width / 2, start), p(across + width / 2, frontLine), p(across - width / 2, frontLine)],
      material: /asphalt|tarmac|bitumen/i.test(has("driveway")[0]?.material ?? "")
        ? "asphalt"
        : /gravel|stone/i.test(has("driveway")[0]?.material ?? "")
          ? "gravel"
          : "concrete",
    };
  }
  const onHardstanding = (p: Vec2, margin: number) => {
    const hit = (poly: Vec2[] | null) => poly !== null && (pointInPolygon(p, poly) || poly.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < margin));
    return hit(path) || hit(driveway?.polygon ?? null);
  };

  // --- porch and steps ---
  const porch: Box[] = [];
  const steps: Box[] = [];
  const hasPorch = has("porch").length > 0;
  if (hasPorch) porch.push(box(add(door, f, 0.75), 0.075, left, 2.4, 0.15, 1.5, CONCRETE));
  if (hasPorch || has("steps").length > 0) {
    const from = hasPorch ? 1.5 : 0;
    steps.push(box(add(door, f, from + 0.15), 0.05, left, 1.2, 0.1, 0.3, CONCRETE));
    steps.push(box(add(door, f, from + 0.45), 0.025, left, 1.2, 0.05, 0.3, CONCRETE));
  }

  // --- the fence: the sides and the back, and the front only along the street ---
  const fence: Landscape["fence"] = [];
  const fenceRead = has("fence")[0];
  if (fenceRead) {
    const pale = /white|cream|pale/i.test(`${fenceRead.colour ?? ""} ${fenceRead.material ?? ""}`) || luminance(fenceRead.colour) > 0.6;
    const colour = fenceRead.colour ?? (pale ? WHITE : TIMBER);
    for (let i = 0; i < lot.polygon.length; i++) {
      const a = lot.polygon[i];
      const b = lot.polygon[(i + 1) % lot.polygon.length];
      const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const isFront = dot(mid, f) > frontLine - 0.5;
      if (isFront && !fenceRead.alongStreet) continue;
      fence.push({ a, b, heightM: isFront ? 0.9 : 1.2, colour });
    }
  }

  // --- trees ---
  const trees: Landscape["trees"] = [];
  const counts = { left: 0, right: 0, front: 0, back: 0, street: 0 };
  // The trunk needs a metre from a wall and a little from the paving; the
  // canopy may overhang both, as canopies do.
  const reject = (p: Vec2) =>
    !inLot(p) ||
    (p[0] > house.x0 - 1 && p[0] < house.x1 + 1 && p[1] > house.y0 - 1 && p[1] < house.y1 + 1) ||
    onHardstanding(p, 0.6) ||
    outbuildings.some((o) => p[0] > o.rect.x0 - 1 && p[0] < o.rect.x1 + 1 && p[1] > o.rect.y0 - 1 && p[1] < o.rect.y1 + 1);
  const lotAcross = { left: extent(lot.polygon, left), right: extent(lot.polygon, right) };
  for (const t of has("tree").slice(0, 8)) {
    const size = TREE_SIZE[t.size ?? "m"];
    const conifer = /pine|fir|cedar|spruce|evergreen|conifer|cypress/i.test(`${t.material ?? ""} ${t.colour ?? ""}`);
    let side: "left" | "right" | "front" | "back" | "street" = t.alongStreet
      ? "street"
      : t.side === "both"
        ? counts.left <= counts.right
          ? "left"
          : "right"
        : (t.side ?? "front");
    if (side === "front" && counts.front >= 4) side = counts.left <= counts.right ? "left" : "right";
    const k = counts[side]++;
    const candidates: Vec2[] = [];
    // The requested side first; if nothing there will take a tree - a garage
    // fills the strip, say - the front lawn, then the back, rather than
    // nowhere. The photograph did show a tree.
    const fallback = (where: "front" | "back", n: number): Vec2[] => {
      const out: Vec2[] = [];
      for (let j = 0; j < 4; j++) {
        const axis = (n + j) % 2 === 0 ? left : right;
        out.push(
          where === "front"
            ? add(add(door, axis, 3 + Math.floor((n + j) / 2) * 3), f, (houseFront + frontLine) / 2 - dot(door, f))
            : add(add(door, axis, 1.5 + Math.floor((n + j) / 2) * 3), f, houseRear - dot(door, f) - 2.5 - j),
        );
      }
      return out;
    };
    if (side === "left" || side === "right") {
      const axis = side === "left" ? left : right;
      const edge = extent(houseCorners, axis);
      const strip = (lotAcross[side] - edge) / 2;
      for (let j = 0; j < 4; j++) candidates.push(add(add([0, 0], axis, edge + strip), f, houseFront - 1 - k * 4 - j * 2));
    } else if (side === "front") {
      const axis = k % 2 === 0 ? left : right;
      const along = (houseFront + frontLine) / 2;
      for (let j = 0; j < 4; j++) candidates.push(add(add(door, axis, 3 + Math.floor(k / 2) * 3 + j * 1.5), f, along - dot(door, f)));
    } else if (side === "back") {
      const axis = k % 2 === 0 ? left : right;
      for (let j = 0; j < 4; j++) candidates.push(add(add(door, axis, 1.5 + Math.floor(k / 2) * 3), f, houseRear - dot(door, f) - 2.5 - j * 1.5));
    } else {
      const span = lotAcross.left + lotAcross.right;
      const n = has("tree").filter((x) => x.alongStreet).length;
      const at = -lotAcross.left + (span * (k + 1)) / (n + 1);
      // Along the front edge, stepping sideways off the path or the drive.
      for (const shift of [0, 2.5, -2.5, 5, -5]) {
        candidates.push(add(add([0, 0], right, at + shift), f, frontLine - 1.5));
      }
    }
    const at =
      candidates.find((p) => !reject(p)) ??
      fallback("front", counts.front + 4).find((p) => !reject(p)) ??
      fallback("back", counts.back + 4).find((p) => !reject(p));
    if (!at) continue;
    trees.push({ at, heightM: size.h, trunkR: size.trunk, canopyR: size.canopy, shape: conifer ? "cone" : "round", colour: t.colour ?? (conifer ? CONIFER : CANOPY) });
  }

  // --- shrubs: foundation planting either side of the door ---
  const shrubs: Landscape["shrubs"] = [];
  const shrubsRead = has("shrub");
  if (shrubsRead.length > 0) {
    const clear = hasPorch ? 1.8 : 1.2;
    const n = Math.min(12, Math.max(2, shrubsRead.length * 2));
    for (let i = 0; i < n; i++) {
      const axis = i % 2 === 0 ? left : right;
      const at = add(add(door, axis, clear + Math.floor(i / 2) * 1.2), f, 0.7);
      if (!inLot(at) || onHardstanding(at, 0.5)) continue;
      shrubs.push({ at, r: 0.6, colour: shrubsRead[Math.floor(i / 2) % shrubsRead.length].colour ?? SHRUB });
    }
  }

  // --- hedges: along the front, or along the sides when the read says so ---
  const hedges: Landscape["hedges"] = [];
  for (const h of has("hedge")) {
    const colour = h.colour ?? HEDGE;
    for (let i = 0; i < lot.polygon.length; i++) {
      const a = lot.polygon[i];
      const b = lot.polygon[(i + 1) % lot.polygon.length];
      const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const isFront = dot(mid, f) > frontLine - 0.5;
      const isLeft = dot(mid, left) > lotAcross.left - 0.5;
      const isRight = dot(mid, right) > lotAcross.right - 0.5;
      const wanted = h.side === "left" ? isLeft : h.side === "right" ? isRight : h.side === "both" ? isLeft || isRight : isFront;
      if (!wanted) continue;
      // Set in from the front edge, so it stands on the lawn and not the verge.
      const inset = isFront ? -0.6 : 0;
      hedges.push({ a: add(a, f, inset), b: add(b, f, inset), heightM: 1.2, depthM: 0.8, colour });
    }
  }

  return { door: doorBox, path, driveway, porch, steps, fence, trees, shrubs, hedges, outbuildings };
}
