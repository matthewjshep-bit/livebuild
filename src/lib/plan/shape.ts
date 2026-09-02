import { decompose, type Rect } from "@/lib/plan/footprint";
import { outlineOf } from "@/lib/plan/outline";
import { subtractRects } from "@/lib/model/stairs";
import { area } from "@/lib/plan/geometry";
import type { ShapeEdit } from "@/lib/spec/schema";
import type { Plan } from "@/lib/schema";

/**
 * Changing the shape of a room without changing the shape of the house.
 *
 * A photograph can say a living room is L-shaped. The satellite says how big
 * the building is, and that is survey data - so the only honest way to make one
 * room an L is for the room next to it to give up the corner. Every shape edit
 * here is therefore a **transfer**: one room cedes a rectangle to a neighbour.
 *
 * That framing is what makes the guarantee cheap rather than delicate. Total
 * floor area is conserved because nothing is created or destroyed; the exterior
 * walls are untouched because the rectangle moves between two rooms that are
 * both already inside the building; and `packIntoFootprint`'s exact fill
 * survives, because the partition is rearranged rather than broken. A gap left
 * inside a building is a room nobody can reach, and unlike a gap at the edge it
 * is invisible until somebody walks the tour into a dead end.
 *
 * Every edit is checked and a failing one is dropped with a reason, never
 * repaired. That is the same discipline `validatePackPlan` and
 * `outlineIsPlausible` already follow, and for the same reason: a repaired edit
 * is an edit nobody asked for, applied to a house nobody will check again.
 */

/** Smallest a room may be reduced to, matching the packer's own floor. */
export const MIN_ROOM_M = 2.1;

export type Rejection = { edit: ShapeEdit; reason: string };

export type ShapeResult = {
  plan: Plan;
  applied: number;
  rejections: Rejection[];
};

const rectArea = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

const overlap = (a: Rect, b: Rect): Rect => ({
  x0: Math.max(a.x0, b.x0),
  y0: Math.max(a.y0, b.y0),
  x1: Math.min(a.x1, b.x1),
  y1: Math.min(a.y1, b.y1),
});

/** The smallest dimension of anything a set of rectangles contains. */
function narrowest(rects: Rect[]): number {
  if (rects.length === 0) return 0;
  return Math.min(...rects.map((r) => Math.min(r.x1 - r.x0, r.y1 - r.y0)));
}

export function applyShapeEdits(
  plan: Plan,
  edits: ShapeEdit[] | null | undefined,
): ShapeResult {
  if (!edits?.length) return { plan, applied: 0, rejections: [] };

  const rooms = new Map(plan.rooms.map((r) => [r.id, r]));
  const rejections: Rejection[] = [];
  let applied = 0;

  for (const edit of edits) {
    const from = rooms.get(edit.from);
    const to = rooms.get(edit.to);
    const reject = (reason: string) => rejections.push({ edit, reason });

    if (!from || !to) {
      reject("one of the rooms is no longer in the plan");
      continue;
    }
    if (from.level !== to.level) {
      reject("the two rooms are on different storeys");
      continue;
    }
    if (rectArea(edit.rect) < 0.25) {
      reject("the piece being moved is too small to be a piece of a room");
      continue;
    }

    const fromRects = decompose(from.polygon);
    const toRects = decompose(to.polygon);

    // The rectangle has to come out of the donor entirely. A transfer that
    // reaches beyond it is taking floor from somewhere nobody named - which,
    // if that somewhere is outside the building, silently moves the shell.
    const insideDonor = fromRects.reduce(
      (sum, r) => sum + rectArea(overlap(r, edit.rect)),
      0,
    );
    if (Math.abs(insideDonor - rectArea(edit.rect)) > 1e-6) {
      reject("the piece is not entirely inside the room giving it up");
      continue;
    }

    // And it has to touch the receiver, or the two end up sharing no wall and
    // the receiving room is left in two halves.
    const touches = toRects.some((r) => {
      const gapX = Math.max(r.x0, edit.rect.x0) - Math.min(r.x1, edit.rect.x1);
      const gapY = Math.max(r.y0, edit.rect.y0) - Math.min(r.y1, edit.rect.y1);
      return gapX < 1e-6 && gapY < 1e-6;
    });
    if (!touches) {
      reject("the piece does not touch the room receiving it");
      continue;
    }

    const nextFrom = fromRects.flatMap((r) => subtractRects(r, [edit.rect]));
    const nextTo = [...toRects, edit.rect];

    if (nextFrom.length === 0) {
      reject("it would take the whole of the room giving it up");
      continue;
    }
    if (narrowest(nextFrom) < MIN_ROOM_M - 1e-6) {
      reject(`it would leave the ${from.label.toLowerCase()} narrower than a room can be`);
      continue;
    }

    const fromOutline = outlineOf(nextFrom);
    const toOutline = outlineOf(nextTo);
    if (!fromOutline || !toOutline) {
      reject("the result would not be one room with one outline");
      continue;
    }

    // Conservation, asserted rather than assumed. Everything above argues that
    // area is preserved; this checks it, because the cost of being wrong is a
    // void inside the building that nothing else in the pipeline looks for.
    const before = area(from.polygon) + area(to.polygon);
    const after = Math.abs(area(fromOutline)) + Math.abs(area(toOutline));
    if (Math.abs(before - after) > 1e-6) {
      reject("it would not conserve the floor area between the two rooms");
      continue;
    }

    rooms.set(from.id, { ...from, polygon: fromOutline });
    rooms.set(to.id, { ...to, polygon: toOutline });
    applied++;
  }

  return {
    plan: { ...plan, rooms: plan.rooms.map((r) => rooms.get(r.id) ?? r) },
    applied,
    rejections,
  };
}

/**
 * The building's own outline on one storey, as a comparable string.
 *
 * The invariant that makes "the footprint wins" true rather than intended:
 * whatever the rooms do among themselves, the outside of the house has to come
 * out identical.
 *
 * Taken as the outline round the union of every room, not by probing each
 * room's rectangles. That distinction is the whole point and it caught this
 * function's first version out: reshaping a room changes how it *decomposes*,
 * so a fingerprint built from rectangle edges differs even when the building is
 * byte-for-byte the same shape. The outline does not care how the inside was
 * cut up, which is exactly the property being asserted.
 */
export function exteriorFingerprint(plan: Plan, level: number): string {
  const covered = plan.rooms.filter((r) => r.level === level).flatMap((r) => decompose(r.polygon));
  const outline = outlineOf(covered);
  if (!outline) return "not-one-outline";
  // Rotated to start at the lowest corner, so the same ring traced from a
  // different cell compares equal.
  const lowest = outline.reduce(
    (best, p, i) =>
      p[0] < outline[best][0] || (p[0] === outline[best][0] && p[1] < outline[best][1]) ? i : best,
    0,
  );
  return [...outline.slice(lowest), ...outline.slice(0, lowest)]
    .map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`)
    .join(" ");
}
