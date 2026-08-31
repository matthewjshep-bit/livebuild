import { decompose, type Rect } from "@/lib/plan/footprint";
import { subtractRects } from "@/lib/model/stairs";
import type { CeilingSpec } from "@/lib/spec/schema";
import type { Room } from "@/lib/schema";

/**
 * What is over your head.
 *
 * The ceiling was one flat slab, drawn only when somebody was standing under
 * it. That is the right first approximation and it is wrong about the ceilings
 * people actually remember: the beams in a cottage, the tray over a dining
 * table, the coffers in a study. Those are the reason a room is described as
 * having "a lovely ceiling", and a replica that renders all of them as the same
 * flat plane has thrown away the thing the room was known for.
 *
 * Everything here is rectangles, and that is not a compromise. `decompose`
 * turns the room's outline into rectangles and `subtractRects` takes pieces out
 * of them - so a coffered ceiling is a grid of sunken panels, and the rails
 * between them are simply what is left when you subtract the panels from the
 * room. The complement comes out for free, which is the whole reason to work
 * this way rather than laying out rails directly and hoping they meet.
 *
 * A vault and a slope are deliberately not here. They change the wall envelope
 * - a gable has to be built where a rectangle of wall used to stop - and that
 * belongs with the wall graph rather than with the surface underneath it. The
 * schema records them so a reading is not thrown away, and the editor can say
 * the model has not caught up yet.
 */

export type CeilingPart = {
  /**
   * `panel` is the ceiling surface itself and only exists indoors.
   *
   * A beam is different in kind: it is structure, it reads as structure, and
   * the dollhouse is where a house is judged. Drawing beams only when somebody
   * is standing underneath them would hide the one ceiling feature anybody
   * notices from outside.
   */
  kind: "panel" | "beam" | "rail" | "side";
  center: [number, number, number];
  size: [number, number, number];
};

/** Thickness of the ceiling surface itself. */
const SLAB = 0.02;

/** How much of a tray's lift the step around it takes. */
const SIDE_INSET = 0.02;

export function ceilingParts(
  room: Room,
  spec: CeilingSpec | null | undefined,
  holes: Rect[],
  height: number,
): CeilingPart[] {
  const rects = decompose(room.polygon).flatMap((rect) => subtractRects(rect, holes));
  if (rects.length === 0) return [];

  const kind = spec?.kind ?? "flat";
  const lift = spec?.liftM ?? 0.15;
  const margin = spec?.marginM ?? 0.5;

  const slab = (r: Rect, y: number, k: CeilingPart["kind"] = "panel"): CeilingPart => ({
    kind: k,
    center: [(r.x0 + r.x1) / 2, y + SLAB / 2, (r.y0 + r.y1) / 2],
    size: [r.x1 - r.x0, SLAB, r.y1 - r.y0],
  });

  const parts: CeilingPart[] = [];

  /**
   * The one rectangle a tray or a coffer grid is set out from.
   *
   * Not the whole decomposition: an L-shaped room's tray sits in its main body,
   * and a tray that followed the L round its corner would be a very strange
   * thing to build. The largest rectangle is the room as anyone would describe
   * it, and the rest keeps its flat ceiling.
   */
  const main = rects.reduce((best, r) =>
    (r.x1 - r.x0) * (r.y1 - r.y0) > (best.x1 - best.x0) * (best.y1 - best.y0) ? r : best,
  );

  if (kind === "tray" || kind === "coffered") {
    const inner: Rect = {
      x0: main.x0 + margin,
      y0: main.y0 + margin,
      x1: main.x1 - margin,
      y1: main.y1 - margin,
    };
    const fits = inner.x1 - inner.x0 > 0.6 && inner.y1 - inner.y0 > 0.6;

    if (!fits) {
      // Too small to set anything out in. A tray in a cupboard is a flat
      // ceiling with a story attached.
      for (const r of rects) parts.push(slab(r, height));
      return parts;
    }

    // The border, which is every part of the room that is not the inner panel.
    for (const r of rects) {
      for (const piece of subtractRects(r, [inner])) parts.push(slab(piece, height));
    }

    if (kind === "tray") {
      parts.push(slab(inner, height + lift));
      parts.push(...stepSides(inner, height, lift));
      return parts;
    }

    // Coffers: a grid of sunken panels, and the rails between them are the
    // complement. Sized to land near 1.2m a bay, which is what a coffer is.
    const across = Math.max(2, Math.min(6, Math.round((inner.x1 - inner.x0) / 1.2)));
    const down = Math.max(2, Math.min(6, Math.round((inner.y1 - inner.y0) / 1.2)));
    const railW = 0.12;
    const panels: Rect[] = [];
    for (let i = 0; i < across; i++) {
      for (let j = 0; j < down; j++) {
        const w = (inner.x1 - inner.x0) / across;
        const d = (inner.y1 - inner.y0) / down;
        panels.push({
          x0: inner.x0 + i * w + railW,
          y0: inner.y0 + j * d + railW,
          x1: inner.x0 + (i + 1) * w - railW,
          y1: inner.y0 + (j + 1) * d - railW,
        });
      }
    }
    for (const panel of panels) {
      parts.push(slab(panel, height + lift));
      parts.push(...stepSides(panel, height, lift));
    }
    for (const rail of subtractRects(inner, panels)) parts.push(slab(rail, height, "rail"));
    return parts;
  }

  // Flat, and beamed - which is a flat ceiling with something hanging below it.
  for (const r of rects) parts.push(slab(r, height));

  const beams = spec?.beams;
  if (kind === "beamed" && beams && beams.count > 0) {
    // Defaulted here as well as in the schema, because a reading arrives as a
    // count and an axis - those are the two things a photograph can actually
    // tell you - and is written straight into the spec without going back
    // through a parse. Without this a read beam is NaN wide and disappears.
    const widthM = beams.widthM || 0.14;
    const dropM = beams.dropM || 0.18;
    const width = main.x1 - main.x0;
    const depth = main.y1 - main.y0;
    // Beams run across the shorter span, because that is the direction a joist
    // spans. `axis` says which way they *run*, so they are spaced along the
    // other one.
    const alongX = beams.axis === "x";
    const span = alongX ? depth : width;
    const count = Math.max(1, Math.min(beams.count, Math.floor(span / 0.5)));
    const step = span / (count + 1);

    for (let i = 1; i <= count; i++) {
      const at = (alongX ? main.y0 : main.x0) + step * i;
      parts.push({
        kind: "beam",
        center: alongX
          ? [(main.x0 + main.x1) / 2, height - dropM / 2, at]
          : [at, height - dropM / 2, (main.y0 + main.y1) / 2],
        size: alongX ? [width, dropM, widthM] : [widthM, dropM, depth],
      });
    }
  }

  return parts;
}

/** The four faces closing the step between a recessed panel and the ceiling. */
function stepSides(inner: Rect, height: number, lift: number): CeilingPart[] {
  const t = SIDE_INSET;
  const y = height + lift / 2;
  return [
    {
      kind: "side",
      center: [(inner.x0 + inner.x1) / 2, y, inner.y0 + t / 2],
      size: [inner.x1 - inner.x0, lift, t],
    },
    {
      kind: "side",
      center: [(inner.x0 + inner.x1) / 2, y, inner.y1 - t / 2],
      size: [inner.x1 - inner.x0, lift, t],
    },
    {
      kind: "side",
      center: [inner.x0 + t / 2, y, (inner.y0 + inner.y1) / 2],
      size: [t, lift, inner.y1 - inner.y0],
    },
    {
      kind: "side",
      center: [inner.x1 - t / 2, y, (inner.y0 + inner.y1) / 2],
      size: [t, lift, inner.y1 - inner.y0],
    },
  ];
}
