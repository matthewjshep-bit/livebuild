import type { Wall } from "@/lib/model/furniture";
import { type Part, alongOf } from "@/lib/model/parts";
import type { WallSolid } from "@/lib/model/walls";

/**
 * What a clad house has that a box with cladding on it does not: a board up
 * every outside corner, a band of foundation showing under the cladding, and
 * a chimney where the fireplace is.
 */

const CORNER = 0.1;
const FOUNDATION = 0.3;
const CHIMNEY_W = 1.2;
const CHIMNEY_D = 0.6;
const CHIMNEY_ABOVE_RIDGE = 0.8;

/**
 * Corner boards: one where two exterior walls at different angles meet.
 *
 * A wall run is several solids - the pieces round a window, the header over
 * a door - whose ends meet collinearly; those are not corners. An end that
 * another wall at a different angle also reaches is.
 */
export function cornerBoards(walls: WallSolid[], baseY: number, colour: string): Part[] {
  const ends: Array<{ at: [number, number]; angle: number; height: number }> = [];
  for (const w of walls) {
    if (!w.exterior || w.header) continue;
    const along = alongOf(w.angleDeg);
    for (const s of [-1, 1]) {
      ends.push({
        at: [w.center[0] + (along[0] * w.length * s) / 2, w.center[1] + (along[1] * w.length * s) / 2],
        angle: ((w.angleDeg % 180) + 180) % 180,
        height: w.base + w.height,
      });
    }
  }
  const parts: Part[] = [];
  // Each wall reaches a little past the corner, so the two ends that meet
  // there are a hand apart; the cluster is the corner, and one board goes
  // at its middle.
  const done = new Set<number>();
  for (let i = 0; i < ends.length; i++) {
    if (done.has(i)) continue;
    const e = ends[i];
    const near = ends.map((o, j) => [o, j] as const).filter(([o]) => Math.hypot(o.at[0] - e.at[0], o.at[1] - e.at[1]) < 0.3);
    const angles = new Set(near.map(([o]) => Math.round(o.angle)));
    if (angles.size < 2) continue;
    for (const [, j] of near) done.add(j);
    const height = Math.max(...near.map(([o]) => o.height));
    const cx = near.reduce((s, [o]) => s + o.at[0], 0) / near.length;
    const cy = near.reduce((s, [o]) => s + o.at[1], 0) / near.length;
    parts.push({
      center: [cx, baseY + height / 2, cy],
      size: [CORNER + 0.04, height, CORNER + 0.04],
      angleDeg: 0,
      colour,
      part: "corner-board",
    });
  }
  return parts;
}

/** A band under the ground-floor cladding, the height of a real foundation showing. */
export function foundationBand(walls: WallSolid[], colour: string): Part[] {
  return walls
    .filter((w) => w.exterior && !w.header && w.base < 1e-6)
    .map((w) => ({
      center: [w.center[0], -FOUNDATION / 2 + 0.01, w.center[1]] as [number, number, number],
      size: [w.length + w.thickness, FOUNDATION, w.thickness + 0.05] as [number, number, number],
      angleDeg: w.angleDeg,
      colour,
      part: "foundation",
    }));
}

/**
 * A chimney on the fireplace's wall, outside, from the ground to above the ridge.
 *
 * Centred along the wall, which is where `fixtures.ts` puts the fireplace.
 */
export function chimney(
  bounds: { x0: number; y0: number; x1: number; y1: number },
  wall: Wall,
  ridgeY: number,
  colour: string,
): Part {
  const height = ridgeY + CHIMNEY_ABOVE_RIDGE;
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cy = (bounds.y0 + bounds.y1) / 2;
  // Outside the wall: the exterior wall is 0.2 thick and stands outside the
  // room, so the breast starts a wall's thickness out and goes further.
  const off = 0.2 + CHIMNEY_D / 2 - 0.05;
  const [x, y, w, d] =
    wall === "north"
      ? [cx, bounds.y0 - off, CHIMNEY_W, CHIMNEY_D]
      : wall === "south"
        ? [cx, bounds.y1 + off, CHIMNEY_W, CHIMNEY_D]
        : wall === "west"
          ? [bounds.x0 - off, cy, CHIMNEY_D, CHIMNEY_W]
          : [bounds.x1 + off, cy, CHIMNEY_D, CHIMNEY_W];
  return { center: [x, height / 2, y], size: [w, height, d], angleDeg: 0, colour, part: "chimney" };
}
