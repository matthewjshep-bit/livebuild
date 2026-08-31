import type { HouseSpec } from "@/lib/spec/schema";
import { applyShapeEdits } from "@/lib/plan/shape";
import type { Opening, Plan } from "@/lib/schema";

/**
 * Write the parts of the spec that are geometry into the plan.
 *
 * The spec is the recipe and the plan is the result. That split exists because
 * a re-layout regenerates every room, so a shape refinement baked only into a
 * polygon is destroyed by the next reshape without a word - whereas the
 * observation that produced it survives, and can simply be applied again.
 *
 * Three kinds of thing cross over here: what shape a room is, how tall it is,
 * and how it opens onto the next one. Everything else the spec knows - what the
 * floor is made of, what colour the walls are, what profile the skirting has -
 * is a finish rather than a shape, and the renderer reads it directly. Copying
 * finishes into the plan would put the same fact in two places and guarantee
 * they drift.
 *
 * Applied at build time and after every inference run, so that by the time
 * anything downstream sees a `Plan` it is already the plan the spec describes.
 * `wallsForLevel`, the takeoff, the walk graph and the 2D drawing then need to
 * know nothing about any of this.
 */

/** A doorway's width when the spec does not name one. Matches `Opening`. */
const DOOR_M = 0.9;

/** How wide a cased opening is, absent a measurement. Two doors across. */
const CASED_M = 1.8;

export function applySpec(plan: Plan, spec: HouseSpec | null | undefined): Plan {
  if (!spec) return plan;

  // Shape first, then everything measured against it. A ceiling height is a
  // property of a room, and reshaping the room afterwards would apply it to a
  // room that no longer exists in that form.
  const reshaped = applyShapeEdits(plan, spec.shapeEdits);
  plan = reshaped.plan;

  const rooms = plan.rooms.map((room) => {
    const height = spec.rooms[room.id]?.ceiling?.heightM;
    return height && Math.abs(height - room.ceilingHeight) > 1e-6
      ? { ...room, ceilingHeight: height }
      : room;
  });

  /**
   * Widen, narrow or remove each doorway.
   *
   * An opening is stored on the plan once and named by both its rooms, while
   * the spec records it from each room's side - so the two sides can disagree,
   * and the wider claim wins. That is the right way round: somebody who says
   * two rooms are one space has seen something, and somebody whose photograph
   * merely failed to show the archway has not.
   */
  const openings: Opening[] = [];
  for (const opening of plan.openings) {
    if (opening.kind === "stairs") {
      openings.push(opening);
      continue;
    }

    const [a, b] = opening.between;
    const sides = [spec.rooms[a]?.openings[b], spec.rooms[b]?.openings[a]].filter(Boolean);
    if (sides.length === 0) {
      openings.push(opening);
      continue;
    }

    const kinds = sides.map((side) => side!.kind);
    if (kinds.every((kind) => kind === "none")) continue;

    const widest = Math.max(
      ...sides.map((side) => {
        if (!side) return 0;
        if (side.widthM) return side.widthM;
        return side.kind === "open" || side.kind === "cased" ? CASED_M : DOOR_M;
      }),
      DOOR_M,
    );

    openings.push({
      ...opening,
      width: Math.min(widest, longestSharedRun(plan, a, b)),
    });
  }

  return { ...plan, rooms, openings };
}

/**
 * Whether an opening reaches the ceiling rather than having wall above it.
 *
 * Read by the wall builder to decide if a header belongs over the gap. It is
 * the one line that separates "a door between two rooms" from "these two rooms
 * are one space", and it has to be asked of the spec rather than of the plan,
 * because `Opening` has never had anywhere to record it.
 */
export function isFullHeight(spec: HouseSpec | null | undefined, opening: Opening): boolean {
  if (!spec || opening.kind === "stairs") return false;
  const [a, b] = opening.between;
  return [spec.rooms[a]?.openings[b], spec.rooms[b]?.openings[a]].some(
    (side) => side?.kind === "open",
  );
}

/**
 * How much wall two rooms share, as a ceiling on how wide their opening can be.
 *
 * Without it a spec that claims a four-metre archway between rooms that touch
 * along two metres cuts away more wall than exists, and the wall builder
 * silently produces a run of negative length.
 */
function longestSharedRun(plan: Plan, a: string, b: string): number {
  const bounds = (id: string) => {
    const room = plan.rooms.find((r) => r.id === id);
    if (!room) return null;
    const xs = room.polygon.map((p) => p[0]);
    const ys = room.polygon.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const p = bounds(a);
  const q = bounds(b);
  if (!p || !q) return CASED_M;

  const overlapX = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
  const overlapY = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
  const run = Math.max(overlapX, overlapY);
  // Leave a return at each end. A doorway that consumes its wall entirely
  // leaves nothing for the wall builder to carry round the corner.
  return Math.max(DOOR_M, run - 0.3);
}
