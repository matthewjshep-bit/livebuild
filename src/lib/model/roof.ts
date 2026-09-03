import * as THREE from "three";

import { SLAB_M, boundsOf, levelBase, levelsOf } from "@/lib/plan/geometry";
import type { Plan } from "@/lib/schema";

/**
 * The parts of the site read a roof is made from - structural, as
 * `houseScheme` takes its exterior, so a caller with only a shape can ask.
 */
export type RoofRead = {
  roof?: { shape?: string | null; ridgeBearing?: number | null; pitchDeg?: number | null } | null;
} | null | undefined;
export type SiteRead = { planXBearing?: number | null } | null | undefined;

/**
 * A roof over the house, from what the site read said the roof is.
 *
 * There was none. The exterior was an untextured box with its top open, and
 * the site read's `roof.shape`, `ridgeBearing` and `pitchDeg` - the three
 * things a roof is - were stored and consumed by nothing. A house is judged
 * from the street before it is judged from inside, and a house with no roof
 * is a diagram.
 *
 * Nothing stores the building's outline, so the footprint is the top storey's
 * rooms: their bounding boxes, swept into the fewest axis-aligned rectangles
 * that cover them - a rectangle, an L, a T - and one roof per rectangle. Two
 * gables meeting in an L intersect rather than valley; at the scale a roof is
 * looked at that is a roof, and a straight skeleton is the follow-on for the
 * houses where it is not.
 *
 * Faces, not boxes: a slope is a quad in space, and a gable end is a triangle.
 * `roofGeometry` turns them into a mesh with the normals the light needs.
 */

export type RoofFace = {
  /** Corners, wound counter-clockwise seen from outside. Three to five, convex. */
  points: Array<[number, number, number]>;
  /** What it is, which decides what it is made of. */
  kind: "slope" | "gable" | "flat";
};

export type RoofModel = {
  faces: RoofFace[];
  eaveY: number;
  ridgeY: number;
};

type Rect = { x0: number; y0: number; x1: number; y1: number };

const OVERHANG = 0.4;
const DEFAULT_PITCH = 30;
const PARAPET = 0.35;

/** The fewest axis-aligned rectangles that cover every room on a storey. */
export function coverRects(rects: Rect[]): Rect[] {
  if (rects.length === 0) return [];
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b);
  const inside = (x: number, y: number) => rects.some((r) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1);

  // Row by row: runs of kept cells, then runs on consecutive rows with the
  // same extent merged into one rectangle - the same sweep `decompose` does.
  const out: Rect[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    const cy = (ys[j] + ys[j + 1]) / 2;
    let i = 0;
    while (i < xs.length - 1) {
      if (!inside((xs[i] + xs[i + 1]) / 2, cy)) {
        i++;
        continue;
      }
      let k = i;
      while (k < xs.length - 1 && inside((xs[k] + xs[k + 1]) / 2, cy)) k++;
      const run = { x0: xs[i], y0: ys[j], x1: xs[k], y1: ys[j + 1] };
      const above = out.find((r) => r.x0 === run.x0 && r.x1 === run.x1 && Math.abs(r.y1 - run.y0) < 1e-9);
      if (above) above.y1 = run.y1;
      else out.push(run);
      i = k;
    }
  }
  return out;
}

/**
 * Which way the ridge runs, in the plan: along x or along y.
 *
 * The read gives a compass bearing; the plan's own +x axis has one too, so
 * the difference says which plan axis the ridge is nearest. Without a bearing
 * the ridge takes the rectangle's long axis, which is where it nearly always
 * is.
 */
function ridgeAlongX(rect: Rect, exterior: RoofRead, site: SiteRead): boolean {
  const bearing = exterior?.roof?.ridgeBearing;
  if (typeof bearing === "number" && Number.isFinite(bearing)) {
    const planX = site?.planXBearing ?? 90;
    const relative = (((bearing - planX) % 180) + 180) % 180;
    return relative < 45 || relative > 135;
  }
  return rect.x1 - rect.x0 >= rect.y1 - rect.y0;
}

/** A face, wound so its normal points the way `outward` does. */
function face(points: Array<[number, number, number]>, kind: RoofFace["kind"], outward: [number, number, number]): RoofFace {
  const [a, b, c] = points;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const dot = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2];
  return { points: dot >= 0 ? points : [...points].reverse(), kind };
}

/**
 * One rectangle's roof. Written for a ridge along x; a ridge along y is the
 * same roof with the axes swapped, done by `swapped` below.
 */
function roofOverRect(
  rect: Rect,
  shape: string,
  eaveY: number,
  pitchDeg: number,
  alongX: boolean,
): RoofFace[] {
  const r = alongX ? rect : { x0: rect.y0, y0: rect.x0, x1: rect.y1, y1: rect.x1 };
  const x0 = r.x0 - OVERHANG;
  const x1 = r.x1 + OVERHANG;
  const y0 = r.y0 - OVERHANG;
  const y1 = r.y1 + OVERHANG;
  const half = (y1 - y0) / 2;
  const ym = (y0 + y1) / 2;
  const rise = half * Math.tan((pitchDeg * Math.PI) / 180);
  const top = eaveY + rise;
  const faces: RoofFace[] = [];

  const P = (x: number, y: number, z: number): [number, number, number] =>
    alongX ? [x, y, z] : [z, y, x];

  if (shape === "flat") {
    faces.push(face([P(x0, eaveY, y0), P(x1, eaveY, y0), P(x1, eaveY, y1), P(x0, eaveY, y1)], "flat", [0, 1, 0]));
    // A parapet round the edge, which is what makes a flat roof read as one
    // rather than as a house with its lid off.
    const t = 0.2;
    const wall = (ax: number, az: number, bx: number, bz: number, out: [number, number, number]) =>
      faces.push(face([P(ax, eaveY, az), P(bx, eaveY, bz), P(bx, eaveY + PARAPET, bz), P(ax, eaveY + PARAPET, az)], "gable", out));
    wall(x0, y0, x1, y0, alongX ? [0, 0, -1] : [-1, 0, 0]);
    wall(x1, y1, x0, y1, alongX ? [0, 0, 1] : [1, 0, 0]);
    wall(x1, y0, x1, y1, alongX ? [1, 0, 0] : [0, 0, 1]);
    wall(x0, y1, x0, y0, alongX ? [-1, 0, 0] : [0, 0, -1]);
    void t;
    return faces;
  }

  if (shape === "shed") {
    faces.push(face([P(x0, eaveY, y1), P(x1, eaveY, y1), P(x1, eaveY + 2 * rise, y0), P(x0, eaveY + 2 * rise, y0)], "slope", [0, 1, 0]));
    // The ends, in the wall plane, up to where the slope crosses it.
    const grade = (2 * rise) / (y1 - y0);
    const low = eaveY + OVERHANG * grade;
    const high = eaveY + 2 * rise - OVERHANG * grade;
    faces.push(face([P(r.x0, eaveY, r.y0), P(r.x0, eaveY, r.y1), P(r.x0, low, r.y1), P(r.x0, high, r.y0)], "gable", alongX ? [-1, 0, 0] : [0, 0, -1]));
    faces.push(face([P(r.x1, eaveY, r.y1), P(r.x1, eaveY, r.y0), P(r.x1, high, r.y0), P(r.x1, low, r.y1)], "gable", alongX ? [1, 0, 0] : [0, 0, 1]));
    return faces;
  }

  const hip = shape === "hip" || shape === "pyramidal" || shape === "mansard" || shape === "gambrel" || shape === "complex" || shape === "round";
  if (hip) {
    // The ridge pulled in from each end by the same run the sides have, so
    // the end faces pitch at the same angle.
    const inset = Math.min(half, (x1 - x0) / 2);
    const rx0 = x0 + inset;
    const rx1 = x1 - inset;
    faces.push(face([P(x0, eaveY, y0), P(x1, eaveY, y0), P(rx1, top, ym), P(rx0, top, ym)], "slope", [0, 1, -1]));
    faces.push(face([P(x1, eaveY, y1), P(x0, eaveY, y1), P(rx0, top, ym), P(rx1, top, ym)], "slope", [0, 1, 1]));
    faces.push(face([P(x0, eaveY, y1), P(x0, eaveY, y0), P(rx0, top, ym)], "slope", [-1, 1, 0]));
    faces.push(face([P(x1, eaveY, y0), P(x1, eaveY, y1), P(rx1, top, ym)], "slope", [1, 1, 0]));
    return faces;
  }

  // Gable: two slopes to a ridge, and a face closing each end in the wall
  // plane - a gable end is wall, not roof. It spans the wall, not the
  // overhang: the first version reached the eaves' corners and stood out from
  // the house as a wedge at each end. It runs from the eave up to where the
  // slopes cross the wall line, then to the ridge, so no sky shows under the
  // rake.
  const atWall = eaveY + OVERHANG * Math.tan((pitchDeg * Math.PI) / 180);
  faces.push(face([P(x0, eaveY, y0), P(x1, eaveY, y0), P(x1, top, ym), P(x0, top, ym)], "slope", [0, 1, -1]));
  faces.push(face([P(x1, eaveY, y1), P(x0, eaveY, y1), P(x0, top, ym), P(x1, top, ym)], "slope", [0, 1, 1]));
  faces.push(
    face([P(r.x0, eaveY, r.y0), P(r.x0, eaveY, r.y1), P(r.x0, atWall, r.y1), P(r.x0, top, ym), P(r.x0, atWall, r.y0)], "gable", alongX ? [-1, 0, 0] : [0, 0, -1]),
  );
  faces.push(
    face([P(r.x1, eaveY, r.y1), P(r.x1, eaveY, r.y0), P(r.x1, atWall, r.y0), P(r.x1, top, ym), P(r.x1, atWall, r.y1)], "gable", alongX ? [1, 0, 0] : [0, 0, 1]),
  );
  return faces;
}

export function roofFor(plan: Plan, exterior: RoofRead, site: SiteRead): RoofModel | null {
  const levels = levelsOf(plan);
  if (levels.length === 0) return null;
  const top = levels[levels.length - 1];
  const rooms = plan.rooms.filter((r) => r.level === top);
  if (rooms.length === 0) return null;

  const rects = coverRects(rooms.map((r) => boundsOf(r.polygon)));
  const tallest = rooms.reduce((m, r) => Math.max(m, r.ceilingHeight), 0) || 2.7;
  const eaveY = levelBase(plan, top) + tallest + SLAB_M;

  const shape = exterior?.roof?.shape ?? "gable";
  const pitch = Math.max(12, Math.min(55, exterior?.roof?.pitchDeg ?? DEFAULT_PITCH));

  const faces = rects.flatMap((rect) => roofOverRect(rect, shape, eaveY, pitch, ridgeAlongX(rect, exterior, site)));
  const ridgeY = faces.reduce((m, f) => f.points.reduce((mm, p) => Math.max(mm, p[1]), m), eaveY);
  return { faces, eaveY, ridgeY };
}

/** The faces of one kind as a mesh, with flat normals for the light. */
export function roofGeometry(faces: RoofFace[], kind: RoofFace["kind"] | RoofFace["kind"][]): THREE.BufferGeometry | null {
  const kinds = new Set(Array.isArray(kind) ? kind : [kind]);
  const positions: number[] = [];
  for (const f of faces) {
    if (!kinds.has(f.kind)) continue;
    // Fan from the first corner: a quad is two triangles, a triangle is one.
    for (let i = 1; i + 1 < f.points.length; i++) {
      positions.push(...f.points[0], ...f.points[i], ...f.points[i + 1]);
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
