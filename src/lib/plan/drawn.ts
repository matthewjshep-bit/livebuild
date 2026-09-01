import { type Footprint, type Rect, decompose } from "@/lib/plan/footprint";
import { pointInPolygon } from "@/lib/plan/geometry";
import { outlineOf } from "@/lib/plan/outline";
import type { Room, Vec2 } from "@/lib/schema";
import { M_PER_FT } from "@/lib/units";

/**
 * Check a hand-drawn storey against the outline it was drawn inside.
 *
 * The packer holds the exact-fill invariant by construction, and it has to,
 * because it is inventing an arrangement nobody specified. A drawing is not
 * that. **A hand-drawn plan is already a partition** - the user has said where
 * every wall goes - so there is nothing here to invent, only something to
 * verify. Which means this module can do the one thing the packer cannot: hand
 * back the user's own geometry, unchanged, at the sizes they drew.
 *
 * The invariant being protected is the same one either way, and it is worth
 * restating because everything below exists to serve it: room polygons must
 * partition the outline exactly, because doorways are derived from which rooms
 * touch, so a gap inside the building is a room nobody can reach - and unlike a
 * gap at the edge it is invisible until somebody walks the tour and hits a dead
 * end.
 *
 * Deliberately *not* expressed in terms of `footprint.rects`. That
 * decomposition is an arbitrary choice of maximal rectangles, an implementation
 * detail of the packer rather than a fact about the building, and a drawn room
 * that happens to straddle one of its invisible internal boundaries is not
 * wrong. Checking coverage against the outline itself never mentions them, so
 * an L-shaped house is no harder here than a rectangular one.
 *
 * Rejected, never repaired - with one bounded exception, and the location of
 * every complaint, because "invalid layout" is not something a person can act
 * on and "this rectangle here belongs to no room" is.
 */

/** How far a drawn wall may be from another before it is a different wall. */
export const SNAP_M = 0.25;

/**
 * A cell smaller than this in either direction is not a gap, it is arithmetic.
 *
 * Snapping runs first, so anything left is either a real hole or a sliver from
 * two walls that were deliberately drawn a hair apart. Reporting the second as
 * a missing room would make the check unusable.
 */
const SLIVER_M = 0.02;

export type DrawnCheck =
  | {
      ok: true;
      /** The drawn rooms, squared up. Their sizes are the user's own. */
      rooms: Room[];
      /** How many wall coordinates moved during squaring up. */
      snapped: number;
    }
  | {
      ok: false;
      why: string;
      /** Inside the building, belonging to no room. */
      gaps: Rect[];
      /** Claimed by two rooms at once. */
      overlaps: Rect[];
      /** Drawn outside the building's outline. */
      overhangs: Rect[];
    };

/**
 * Pull nearly-equal coordinates onto one line, with the outline winning.
 *
 * Two walls a centimetre apart are one wall drawn twice, and left alone they
 * are a plan full of rooms nobody can walk between. `sketch.ts` solves the same
 * problem for a drawing whose scale is unknown, as a fraction of the page; here
 * the scale is metres and known, so the tolerance is absolute.
 *
 * Anchors are the outline's own coordinates and they do not move. That is what
 * "the footprint wins" means in code: a room drawn a few centimetres over the
 * boundary is pulled back onto it, and never the other way about.
 */
function snapAxis(values: number[], anchors: number[], tolerance: number): Map<number, number> {
  const sorted = [...new Set([...values, ...anchors])].sort((a, b) => a - b);
  const anchored = new Set(anchors);
  const out = new Map<number, number>();

  let cluster: number[] = [];
  const flush = () => {
    if (cluster.length === 0) return;
    // An anchor in the cluster is the answer. Two of them means the outline has
    // detail finer than the tolerance, and the nearest one is still right.
    const fixed = cluster.filter((v) => anchored.has(v));
    for (const value of cluster) {
      out.set(
        value,
        fixed.length > 0
          ? fixed.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best))
          : cluster.reduce((s, v) => s + v, 0) / cluster.length,
      );
    }
    cluster = [];
  };

  for (const value of sorted) {
    if (cluster.length > 0 && value - cluster[cluster.length - 1] > tolerance) flush();
    cluster.push(value);
  }
  flush();
  return out;
}

/** Every distinct coordinate, in order, with duplicates collapsed. */
function gridlines(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > 1e-9) out.push(v);
  }
  return out;
}

/**
 * Glue a set of grid cells into as few rectangles as possible.
 *
 * Only so a complaint reads well. "Three rectangles are unaccounted for" is a
 * thing a person can find on a drawing; forty-one adjacent cells is not.
 */
function merge(cells: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const cell of [...cells].sort((a, z) => a.y0 - z.y0 || a.x0 - z.x0)) {
    const run = out.find(
      (r) =>
        Math.abs(r.y0 - cell.y0) < 1e-9 &&
        Math.abs(r.y1 - cell.y1) < 1e-9 &&
        Math.abs(r.x1 - cell.x0) < 1e-9,
    );
    if (run) run.x1 = cell.x1;
    else out.push({ ...cell });
  }

  const stacked: Rect[] = [];
  for (const row of out.sort((a, z) => a.x0 - z.x0 || a.y0 - z.y0)) {
    const column = stacked.find(
      (r) =>
        Math.abs(r.x0 - row.x0) < 1e-9 &&
        Math.abs(r.x1 - row.x1) < 1e-9 &&
        Math.abs(r.y1 - row.y0) < 1e-9,
    );
    if (column) column.y1 = row.y1;
    else stacked.push({ ...row });
  }
  return stacked;
}

export type Boundary =
  | {
      ok: true;
      /** Draw against this, never `footprint.outline`. */
      outline: Vec2[];
      /** Area the packer discarded as too small to be a room. */
      droppedSqft: number;
      /** Said out loud when something was dropped, so the clipping is explained. */
      note: string | null;
    }
  | { ok: false; why: string };

/**
 * The outline a person may actually draw inside.
 *
 * **Not `footprint.outline`.** `prepareFootprint` keeps the full simplified
 * outline but filters its rectangles to those over `MIN_RECT_SQFT` (25 sqft),
 * so a porch, a chimney breast or a bay bump-out survives in `outline` and is
 * absent from `rects`. Handing the full outline to `checkDrawn` turns that
 * bump-out into a gap belonging to no room - and one that can never be filled,
 * because it is smaller than the smallest room allowed. The Continue button
 * would simply never enable, on any house with a porch.
 *
 * So the boundary is the outline round what the packer actually considers
 * buildable, and the difference is reported rather than hidden: a house drawn
 * slightly clipped is a thing the user should be told about, not left to
 * notice.
 */
export function drawableBoundary(footprint: Footprint): Boundary {
  if (footprint.rects.length === 0) {
    return { ok: false, why: "The building outline has no space big enough for a room." };
  }

  const outline = outlineOf(footprint.rects);
  // Null is a real answer: rectangles meeting only at a corner have no single
  // loop round them, and inventing one would give the house a boundary its
  // floor does not match. The caller falls back to the packer rather than
  // drawing against a lie.
  if (!outline) {
    return { ok: false, why: "This building's shape cannot be drawn as one outline." };
  }

  const covered = footprint.rects.reduce((sum, r) => sum + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  const droppedSqft = Math.max(0, footprint.areaSqft - covered / (M_PER_FT * M_PER_FT));

  return {
    ok: true,
    outline,
    droppedSqft,
    note:
      droppedSqft >= 1
        ? `A ${Math.round(droppedSqft)} sqft bump-out was left out - too small to be a room.`
        : null,
  };
}

export function checkDrawn(drawn: Room[], outline: Vec2[], level: number): DrawnCheck {
  const onLevel = drawn.filter((room) => room.level === level);
  const reject = (why: string): DrawnCheck => ({
    ok: false,
    why,
    gaps: [],
    overlaps: [],
    overhangs: [],
  });

  if (onLevel.length === 0) return reject("Nothing is drawn on this floor yet.");
  if (outline.length < 4) return reject("There is no building outline to draw inside.");

  // --- square it up ---
  const xMap = snapAxis(
    onLevel.flatMap((r) => r.polygon.map((p) => p[0])),
    outline.map((p) => p[0]),
    SNAP_M,
  );
  const yMap = snapAxis(
    onLevel.flatMap((r) => r.polygon.map((p) => p[1])),
    outline.map((p) => p[1]),
    SNAP_M,
  );

  let snapped = 0;
  const rooms: Room[] = onLevel.map((room) => ({
    ...room,
    polygon: room.polygon.map(([x, y]) => {
      const nx = xMap.get(x) ?? x;
      const ny = yMap.get(y) ?? y;
      if (Math.abs(nx - x) > 1e-9) snapped++;
      if (Math.abs(ny - y) > 1e-9) snapped++;
      return [nx, ny] as Vec2;
    }),
  }));

  // Rooms are rectangles today, but `applyShapeEdits` can make an L. Working in
  // rectangles from here means both are the same problem.
  const claimed = rooms.flatMap((room) => decompose(room.polygon));
  if (claimed.length === 0) return reject("The rooms drawn have no area.");

  // --- cover the ground ---
  const xs = gridlines([...claimed.flatMap((r) => [r.x0, r.x1]), ...outline.map((p) => p[0])]);
  const ys = gridlines([...claimed.flatMap((r) => [r.y0, r.y1]), ...outline.map((p) => p[1])]);

  const gaps: Rect[] = [];
  const overlaps: Rect[] = [];
  const overhangs: Rect[] = [];

  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const cell = { x0: xs[i], y0: ys[j], x1: xs[i + 1], y1: ys[j + 1] };
      if (cell.x1 - cell.x0 < SLIVER_M || cell.y1 - cell.y0 < SLIVER_M) continue;

      const cx = (cell.x0 + cell.x1) / 2;
      const cy = (cell.y0 + cell.y1) / 2;
      const inside = pointInPolygon([cx, cy], outline);
      const covers = claimed.filter((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1).length;

      if (inside && covers === 0) gaps.push(cell);
      else if (inside && covers > 1) overlaps.push(cell);
      else if (!inside && covers > 0) overhangs.push(cell);
    }
  }

  if (gaps.length === 0 && overlaps.length === 0 && overhangs.length === 0) {
    return { ok: true, rooms, snapped };
  }

  const said: string[] = [];
  const area = (rects: Rect[]) =>
    rects.reduce((sum, r) => sum + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  if (gaps.length > 0) said.push(`${Math.round(area(gaps))}m² of the house belongs to no room`);
  if (overlaps.length > 0) said.push(`${Math.round(area(overlaps))}m² is claimed by two rooms`);
  if (overhangs.length > 0) said.push(`${Math.round(area(overhangs))}m² is outside the building`);

  return {
    ok: false,
    why: `${said.join(", and ")}.`,
    gaps: merge(gaps),
    overlaps: merge(overlaps),
    overhangs: merge(overhangs),
  };
}
