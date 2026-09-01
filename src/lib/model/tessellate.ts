import { area, signedArea } from "@/lib/plan/geometry";
import type { Vec2 } from "@/lib/schema";

/**
 * Cutting a room's floor into triangles.
 *
 * Everything that draws a floor or a ceiling has gone through `decompose` until
 * now - the rectilinear sweep that cuts a polygon into axis-aligned rectangles.
 * That is the right tool for the packer, which is *choosing* where rectangles
 * go, and the wrong one for the model, which has to draw whatever the document
 * says. Worse, it fails silently: handed a square rotated by seven degrees, it
 * uses only the polygon's own x and y values as gridlines and returns a coarse
 * staircase that does not cover the shape. No error, no warning, a floor with
 * bites out of it.
 *
 * So this is the other half: given any simple polygon, convex or concave, at any
 * angle, return triangles that exactly cover it. Ear clipping rather than a fan
 * from the centroid, because a fan is only correct for convex shapes and rooms
 * are L-shaped often enough to matter.
 *
 * Deliberately imports nothing from three. The geometry is the part that can be
 * wrong in ways nobody sees until they walk into a room, and keeping it free of
 * the renderer is what lets `npx tsx` prove it - no browser, no canvas, no
 * WebGL context.
 */

/** Points closer than this are the same point. */
const EPS = 1e-9;

/**
 * Drop vertices that carry no shape.
 *
 * Duplicates and collinear runs are what make ear clipping produce
 * zero-area triangles, and a zero-area triangle is a NaN normal a few steps
 * later. Cleaning first is cheaper than defending against it everywhere after.
 */
export function cleanPolygon(poly: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > EPS) out.push(p);
  }
  // The ring may close on itself.
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= EPS) out.pop();
    else break;
  }

  // Collinear vertices, removed in one pass round the ring.
  const kept: Vec2[] = [];
  for (let i = 0; i < out.length; i++) {
    const prev = out[(i - 1 + out.length) % out.length];
    const here = out[i];
    const next = out[(i + 1) % out.length];
    const cross =
      (here[0] - prev[0]) * (next[1] - here[1]) - (here[1] - prev[1]) * (next[0] - here[0]);
    if (Math.abs(cross) > EPS) kept.push(here);
  }
  return kept.length >= 3 ? kept : out;
}

const cross = (o: Vec2, a: Vec2, b: Vec2) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Whether p is inside triangle abc, edges included. */
function inTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const neg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const pos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(neg && pos);
}

/**
 * Triangles covering a simple polygon, as index triples into it.
 *
 * The polygon is normalised to positive winding first, so a caller does not
 * have to know which way round its own rooms are - and every triangle comes back
 * wound the same way, which is what a renderer needs to face them all one way.
 *
 * Returns an empty array for anything degenerate rather than throwing: a
 * zero-area room is a data problem for somebody else to report, and a floor that
 * fails to draw is better than a build that stops.
 */
export function triangulate(polygon: Vec2[]): Array<[number, number, number]> {
  const clean = cleanPolygon(polygon);
  if (clean.length < 3) return [];

  // Work on indices into the cleaned ring, wound positive.
  const positive = signedArea(clean) >= 0 ? clean : [...clean].reverse();
  const flipped = signedArea(clean) < 0;
  const n = positive.length;
  const remaining = Array.from({ length: n }, (_, i) => i);
  const out: Array<[number, number, number]> = [];

  // Bounded: every successful clip removes a vertex, and the guard stops a
  // pathological polygon from spinning rather than failing.
  let guard = n * n;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;

    for (let i = 0; i < remaining.length; i++) {
      const ia = remaining[(i - 1 + remaining.length) % remaining.length];
      const ib = remaining[i];
      const ic = remaining[(i + 1) % remaining.length];
      const a = positive[ia];
      const b = positive[ib];
      const c = positive[ic];

      // A reflex vertex is not an ear.
      if (cross(a, b, c) <= EPS) continue;

      // Nor is one with another vertex inside it.
      let clear = true;
      for (const j of remaining) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTriangle(positive[j], a, b, c)) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;

      out.push([ia, ib, ic]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }

    // No ear found on a polygon with more than three vertices means the input
    // is not simple - it crosses itself. Refuse rather than emit nonsense.
    if (!clipped) return [];
  }

  if (remaining.length === 3) {
    out.push([remaining[0], remaining[1], remaining[2]]);
  } else if (remaining.length > 3) {
    // The guard ran out. Whatever this shape is, it is not one ear clipping
    // can finish, and half a floor is worse than none.
    return [];
  }

  /**
   * Mark its own homework.
   *
   * Ear clipping has a long tail of inputs that produce *plausible* triangles
   * covering the wrong ground - a polygon that crosses itself, a ring that is
   * really a line, a shape whose vertices repeat. None of them throw, and a
   * floor that is quietly the wrong shape is exactly the failure `decompose`
   * already had. The triangles either add up to the polygon or they do not, and
   * that one comparison catches every case at no cost worth counting.
   */
  const want = area(positive);
  const got = out.reduce(
    (sum, [a, b, c]) => sum + Math.abs(cross(positive[a], positive[b], positive[c])) / 2,
    0,
  );
  if (want <= EPS || Math.abs(got - want) > 1e-6 * Math.max(1, want)) return [];

  // Indices are into `positive`; map them back to the caller's own ring.
  const toClean = (i: number) => (flipped ? clean.length - 1 - i : i);
  const cleanToInput = new Map<string, number>();
  polygon.forEach((p, i) => {
    const key = `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
    if (!cleanToInput.has(key)) cleanToInput.set(key, i);
  });
  const toInput = (i: number) => {
    const p = clean[toClean(i)];
    return cleanToInput.get(`${p[0].toFixed(9)},${p[1].toFixed(9)}`) ?? toClean(i);
  };

  return out.map(([a, b, c]) => [toInput(a), toInput(b), toInput(c)] as [number, number, number]);
}

/**
 * The triangles themselves, as points.
 *
 * Most callers want the geometry rather than the indices, and going through the
 * index form means the two can never disagree.
 */
export function triangles(polygon: Vec2[]): Array<[Vec2, Vec2, Vec2]> {
  return triangulate(polygon).map(
    ([a, b, c]) => [polygon[a], polygon[b], polygon[c]] as [Vec2, Vec2, Vec2],
  );
}

/**
 * Whether a triangulation actually covers what it was given.
 *
 * The single honest guard against every ear-clipping edge case, and it is free:
 * the triangles either add up to the polygon's own area or they do not. Called
 * by the tests, and cheap enough to call anywhere a wrong floor would be worse
 * than a slow one.
 */
export function covers(polygon: Vec2[], tolerance = 1e-6): boolean {
  const want = area(polygon);
  if (want <= tolerance) return false;
  const got = triangles(polygon).reduce((sum, [a, b, c]) => sum + Math.abs(cross(a, b, c)) / 2, 0);
  return Math.abs(got - want) <= tolerance * Math.max(1, want);
}

/**
 * A point guaranteed to be inside a room, unlike the centre of its bounds.
 *
 * An L-shaped room's bounding-box centre sits in the notch, outside the room.
 * Everything that drops a walker, hangs a lamp or stands a camera has used that
 * centre until now, which is a bug today for concave rooms and becomes a much
 * more visible one at an angle. The centroid of the largest triangle is inside
 * by construction.
 */
export function interiorPoint(polygon: Vec2[]): Vec2 {
  const tris = triangles(polygon);
  if (tris.length === 0) {
    // Nothing to work with; the average of the vertices is as good as it gets.
    const n = Math.max(1, polygon.length);
    return [
      polygon.reduce((s, p) => s + p[0], 0) / n,
      polygon.reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  let best = tris[0];
  let bestArea = -1;
  for (const t of tris) {
    const size = Math.abs(cross(t[0], t[1], t[2])) / 2;
    if (size > bestArea) {
      bestArea = size;
      best = t;
    }
  }
  return [
    (best[0][0] + best[1][0] + best[2][0]) / 3,
    (best[0][1] + best[1][1] + best[2][1]) / 3,
  ];
}
