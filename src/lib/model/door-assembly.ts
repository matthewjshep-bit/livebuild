import { type Part, placed } from "@/lib/model/parts";
import type { Vec2 } from "@/lib/schema";

/**
 * A door as fitted: a frame, a leaf with panels, a threshold, a handle, and
 * casing round the outside.
 *
 * The front door was one box, 0.9 by 2.05 by 0.06, in a colour. A real door
 * is mostly the shadow lines round its panels and the frame it hangs in, and
 * from the kerb those are what say "door". Six panels, which is the door most
 * houses in a photograph have; a glazed or flush leaf is a later style.
 */

const FRAME = 0.06;
const FRAME_DEPTH = 0.12;
const LEAF = 0.045;
const PANEL_IN = 0.008;
const STILE = 0.11;
const TOP_RAIL = 0.12;
const MID_RAIL = 0.09;
const BOTTOM_RAIL = 0.2;
const CASING = 0.09;
const CASING_THICK = 0.02;

export function doorAssembly(
  /** The door's centre on the wall's outer face, in plan. */
  at: Vec2,
  /** Out of the building. */
  outward: Vec2,
  width: number,
  height: number,
  colours: { leaf: string; frame: string; casing: string },
  /** Which side the handle is on, seen from outside. */
  hinge: "left" | "right" = "left",
  baseY = 0,
): Part[] {
  const along: Vec2 = [-outward[1], outward[0]];
  const angleDeg = (Math.atan2(along[1], along[0]) * 180) / Math.PI;
  const parts: Part[] = [];
  const put = (al: number, out: number, y: number, size: [number, number, number], colour: string, part: string) =>
    parts.push(placed(at, along, outward, al, out, baseY + y, size, angleDeg, colour, part));

  // The frame the leaf hangs in, set into the wall.
  put(-(width / 2 + FRAME / 2), -FRAME_DEPTH / 2, height / 2, [FRAME, height, FRAME_DEPTH], colours.frame, "door-frame");
  put(width / 2 + FRAME / 2, -FRAME_DEPTH / 2, height / 2, [FRAME, height, FRAME_DEPTH], colours.frame, "door-frame");
  put(0, -FRAME_DEPTH / 2, height + FRAME / 2, [width + FRAME * 2, FRAME, FRAME_DEPTH], colours.frame, "door-frame");
  put(0, -FRAME_DEPTH / 2, 0.015, [width + FRAME * 2, 0.03, FRAME_DEPTH + 0.08], colours.frame, "threshold");

  // The leaf: stiles and rails at full thickness, panels set back on both faces.
  const leafOut = -FRAME_DEPTH / 2;
  put(-(width / 2 - STILE / 2), leafOut, height / 2, [STILE, height, LEAF], colours.leaf, "door-leaf");
  put(width / 2 - STILE / 2, leafOut, height / 2, [STILE, height, LEAF], colours.leaf, "door-leaf");
  const inner = width - STILE * 2;
  put(0, leafOut, height - TOP_RAIL / 2, [inner, TOP_RAIL, LEAF], colours.leaf, "door-leaf");
  put(0, leafOut, BOTTOM_RAIL / 2, [inner, BOTTOM_RAIL, LEAF], colours.leaf, "door-leaf");
  // Three rows of two panels, with a rail between each row and a muntin down the middle.
  const field = height - TOP_RAIL - BOTTOM_RAIL;
  const rows = 3;
  const rowH = (field - MID_RAIL * (rows - 1)) / rows;
  for (let r = 1; r < rows; r++) {
    put(0, leafOut, BOTTOM_RAIL + rowH * r + MID_RAIL * (r - 0.5), [inner, MID_RAIL, LEAF], colours.leaf, "door-leaf");
  }
  put(0, leafOut, height / 2, [STILE * 0.8, field, LEAF], colours.leaf, "door-leaf");
  const panelW = (inner - STILE * 0.8) / 2;
  for (let r = 0; r < rows; r++) {
    const y = BOTTOM_RAIL + rowH * (r + 0.5) + MID_RAIL * r;
    for (const side of [-1, 1]) {
      put(side * (STILE * 0.4 + panelW / 2), leafOut, y, [panelW, rowH, LEAF - PANEL_IN * 2], colours.leaf, "door-panel");
    }
  }

  // The handle, on the side away from the hinge, a metre up.
  const handleSide = hinge === "left" ? 1 : -1;
  put(handleSide * (width / 2 - 0.08), leafOut + LEAF / 2 + 0.03, 1.0, [0.03, 0.14, 0.06], "#b8b6ae", "handle");

  // Casing round the outside, proud of the cladding.
  const face = 0.02 + CASING_THICK / 2;
  put(-(width / 2 + FRAME + CASING / 2), face, (height + FRAME) / 2, [CASING, height + FRAME + CASING, CASING_THICK], colours.casing, "casing");
  put(width / 2 + FRAME + CASING / 2, face, (height + FRAME) / 2, [CASING, height + FRAME + CASING, CASING_THICK], colours.casing, "casing");
  put(0, face, height + FRAME + CASING / 2, [width + FRAME * 2 + CASING * 2, CASING, CASING_THICK], colours.casing, "casing");

  return parts;
}
