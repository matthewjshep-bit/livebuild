import { type Part, alongOf, placed } from "@/lib/model/parts";
import type { ModelWindow } from "@/lib/model/windows";
import type { Vec2 } from "@/lib/schema";

/**
 * A window as the thing a joiner would fit, not as a box with a paler box in it.
 *
 * What was drawn: one frame-coloured box the size of the opening and one
 * glass-coloured box a little smaller, flush with the wall. What is missing is
 * everything that tells the eye a window has depth - the reveal, the sill
 * standing out from the wall, the casing round the outside, the bars dividing
 * it into lights, the sash rail across the middle - and their absence is most
 * of why a facade read as a drawing.
 *
 * All of it is boxes, oriented along the wall, in world metres. The opening
 * itself is already there: `wallPiecesAround` rebuilds the wall as the pieces
 * round the window, so this fills the hole and dresses both faces of it.
 */

/** The frame's members, and how deep the reveal is: the wall's own thickness. */
const FRAME = 0.05;
/** One light is about this wide; wider windows are divided. */
const LIGHT = 0.55;
const BAR = 0.035;
const RAIL = 0.05;
/** The outside casing: boards this wide, this thick, proud of the cladding. */
const CASING = 0.09;
const CASING_THICK = 0.02;
/** How far outside the wall face the cladding sits - the siding skin. */
const CLADDING = 0.02;
const PANE = 0.006;

export type WindowAssembly = { trim: Part[]; glass: Part[] };

export function windowAssembly(
  window: ModelWindow,
  /** Which way is out of the building, in plan. */
  outward: Vec2,
  /** The storey's floor height. */
  baseY: number,
  colours: { frame: string; casing: string; glass: string },
): WindowAssembly {
  const along = alongOf(window.angleDeg);
  const a = window.angleDeg;
  const at = window.center;
  const t = window.thickness;
  const w = window.width;
  const h = window.head - window.sill;
  const sillY = baseY + window.sill;
  const headY = baseY + window.head;
  const midY = (sillY + headY) / 2;
  const trim: Part[] = [];
  const glass: Part[] = [];
  const put = (al: number, out: number, y: number, size: [number, number, number], colour: string, part: string) =>
    trim.push(placed(at, along, outward, al, out, y, size, a, colour, part));

  // The frame, filling the reveal: two jambs, a head, a sill member.
  put(-(w / 2 - FRAME / 2), 0, midY, [FRAME, h, t], colours.frame, "frame");
  put(w / 2 - FRAME / 2, 0, midY, [FRAME, h, t], colours.frame, "frame");
  put(0, 0, headY - FRAME / 2, [w - FRAME * 2, FRAME, t], colours.frame, "frame");
  put(0, 0, sillY + FRAME / 2, [w - FRAME * 2, FRAME, t], colours.frame, "frame");

  // The sill outside, standing out from the wall and sloped in spirit; the
  // stool inside, a shelf.
  put(0, t / 2 + CLADDING + 0.04, sillY - 0.02, [w + 0.12, 0.05, 0.12], colours.casing, "sill");
  put(0, -(t / 2 + 0.03), sillY + 0.015, [w + 0.1, 0.03, 0.08], colours.frame, "stool");

  // The casing round the outside, proud of the cladding.
  const face = t / 2 + CLADDING + CASING_THICK / 2;
  put(-(w / 2 + CASING / 2), face, midY, [CASING, h + CASING, CASING_THICK], colours.casing, "casing");
  put(w / 2 + CASING / 2, face, midY, [CASING, h + CASING, CASING_THICK], colours.casing, "casing");
  put(0, face, headY + CASING / 2, [w + CASING * 2, CASING, CASING_THICK], colours.casing, "casing");

  // Lights: bars between them, a meeting rail across, one pane each.
  const inner = w - FRAME * 2;
  const lights = Math.max(1, Math.round(inner / LIGHT));
  const lightW = inner / lights;
  for (let i = 1; i < lights; i++) {
    put(-inner / 2 + lightW * i, 0, midY, [BAR, h - FRAME * 2, BAR], colours.frame, "bar");
  }
  put(0, 0, midY, [inner, RAIL, BAR], colours.frame, "rail");
  for (let i = 0; i < lights; i++) {
    glass.push(
      placed(at, along, outward, -inner / 2 + lightW * (i + 0.5), 0, midY, [lightW - BAR, h - FRAME * 2, PANE], a, colours.glass, "pane"),
    );
  }

  return { trim, glass };
}
