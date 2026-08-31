import type { Rect } from "@/lib/plan/footprint";
import { signedArea } from "@/lib/plan/geometry";
import type { Vec2 } from "@/lib/schema";

/**
 * The outline round a set of rectangles.
 *
 * `decompose` goes the other way - a rectilinear polygon into the rectangles
 * that fill it - and everything in the model has been able to rely on that.
 * Changing a room's shape needs the inverse: take a room's rectangles, add one
 * or subtract one, and get back the outline that now encloses them.
 *
 * Traced on the grid the rectangles themselves define, rather than by
 * intersecting edges. Every x and y that appears anywhere becomes a gridline,
 * which cuts the plane into cells that are each wholly inside the union or
 * wholly outside it - so "is this cell in?" is a point test, and the boundary
 * is every cell edge with a filled cell on one side and nothing on the other.
 * Chaining those edges gives the outline. No tolerances, no near-misses, and
 * the result is exactly rectilinear because its inputs were.
 */

/** Two coordinates are the same gridline if they are this close. */
const EPS = 1e-7;

const key = (p: Vec2) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

function gridlines(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > EPS) out.push(v);
  }
  return out;
}

/**
 * The outline enclosing every rectangle given, or null when they do not form
 * one simple loop.
 *
 * Null is a real answer and callers must handle it: two rectangles that touch
 * only at a corner, or a set with a hole in the middle, genuinely have no
 * single outline, and inventing one would produce a room whose walls do not
 * describe its floor.
 */
export function outlineOf(rects: Rect[]): Vec2[] | null {
  const solid = rects.filter((r) => r.x1 - r.x0 > EPS && r.y1 - r.y0 > EPS);
  if (solid.length === 0) return null;

  const xs = gridlines(solid.flatMap((r) => [r.x0, r.x1]));
  const ys = gridlines(solid.flatMap((r) => [r.y0, r.y1]));
  if (xs.length < 2 || ys.length < 2) return null;

  const filled = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= xs.length - 1 || j >= ys.length - 1) return false;
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    return solid.some((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1);
  };

  /**
   * Boundary edges, wound so the filled side is consistently on one hand.
   *
   * The four directions are emitted in the same order a rectangle is wound, so
   * a single filled cell produces exactly `rectangle()`'s own four edges and
   * the whole thing degenerates gracefully to what it replaces.
   */
  const edges = new Map<string, Vec2>();
  const push = (a: Vec2, b: Vec2) => {
    // A vertex with two outgoing boundary edges is a pinch point - the union
    // touches itself at a corner - and there is no single loop through it.
    if (edges.has(key(a))) throw new Error("pinch");
    edges.set(key(a), b);
  };

  try {
    for (let i = 0; i < xs.length - 1; i++) {
      for (let j = 0; j < ys.length - 1; j++) {
        if (!filled(i, j)) continue;
        const x0 = xs[i];
        const x1 = xs[i + 1];
        const y0 = ys[j];
        const y1 = ys[j + 1];
        if (!filled(i, j - 1)) push([x0, y0], [x1, y0]);
        if (!filled(i + 1, j)) push([x1, y0], [x1, y1]);
        if (!filled(i, j + 1)) push([x1, y1], [x0, y1]);
        if (!filled(i - 1, j)) push([x0, y1], [x0, y0]);
      }
    }
  } catch {
    // A pinch point: the union touches itself at a corner, so there is no one
    // loop round it. Refusing is the honest answer - a room whose walls do not
    // describe its floor is worse than a room whose shape was left alone.
    return null;
  }

  if (edges.size === 0) return null;

  // Walk the chain from any start. A set that forms one loop consumes every
  // edge; anything left over is a second loop, which means a hole or a
  // detached piece and no single outline.
  const start = edges.keys().next().value as string;
  const [sx, sy] = start.split(",").map(Number);
  const loop: Vec2[] = [[sx, sy]];
  let at: Vec2 = [sx, sy];

  for (let guard = 0; guard <= edges.size; guard++) {
    const next = edges.get(key(at));
    if (!next) return null;
    if (key(next) === start) break;
    loop.push(next);
    at = next;
  }
  if (loop.length !== edges.size) return null;

  return orient(collinear(loop));
}

/** Drop the vertices that only continue a straight run. */
function collinear(loop: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < loop.length; i++) {
    const prev = loop[(i - 1 + loop.length) % loop.length];
    const here = loop[i];
    const next = loop[(i + 1) % loop.length];
    const turns =
      Math.abs((here[0] - prev[0]) * (next[1] - here[1]) - (here[1] - prev[1]) * (next[0] - here[0])) >
      EPS;
    if (turns) out.push(here);
  }
  return out.length >= 4 ? out : loop;
}

/** Wound positive, which is what every producer in the codebase emits. */
function orient(loop: Vec2[]): Vec2[] {
  return signedArea(loop) < 0 ? [...loop].reverse() : loop;
}

/** Whether a set of rectangles covers the same ground as another, exactly. */
export function sameGround(a: Rect[], b: Rect[]): boolean {
  const area = (rects: Rect[]) =>
    rects.reduce((sum, r) => sum + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  return Math.abs(area(a) - area(b)) < 1e-6;
}
