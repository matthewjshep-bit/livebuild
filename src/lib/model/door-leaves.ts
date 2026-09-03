import { DOOR_HEIGHT, type WallSolid } from "@/lib/model/walls";
import { type Part, alongOf, placed } from "@/lib/model/parts";
import { interiorPoint } from "@/lib/model/tessellate";
import type { Opening, Plan, Vec2 } from "@/lib/schema";

/**
 * The doors inside the house: a frame in every doorway, casing on both faces,
 * and a leaf standing open into the room.
 *
 * A doorway was a gap with a header over it. That is a builder's opening,
 * not a door, and on foot it is the single thing that most said "model":
 * every room simply ran into the next. The frame and the casing are what
 * the eye reads as a door from across a room; the leaf, open eighty
 * degrees, is what says the house is lived in and lets you through.
 *
 * Built from the wall solids rather than from the plan alone: the header
 * over each doorway already knows the wall's line, thickness and the
 * opening's width, and pairing it with the plan's opening says which two
 * rooms it joins and so which way the leaf swings.
 */

const JAMB = 0.04;
const CASING = 0.07;
const CASING_THICK = 0.015;
const LEAF = 0.04;
const PANEL_IN = 0.006;
const STILE = 0.11;
const TOP_RAIL = 0.12;
const MID_RAIL = 0.09;
const BOTTOM_RAIL = 0.2;
export const OPEN_DEG = 80;

export type Doorway = {
  header: WallSolid;
  opening: Opening;
  /** Unit vector across the wall toward the room the leaf opens into. */
  into: Vec2;
};

/**
 * The header solids of a storey paired with the plan's door openings.
 *
 * A header sits exactly over its opening, so the pair is the nearest
 * opening to the header's centre within a hand. Exterior headers are the
 * house's outer doors, which the site fits; only interior ones are doors
 * here.
 */
export function doorwaysOf(plan: Plan, level: number, walls: WallSolid[]): Doorway[] {
  const rooms = new Map(plan.rooms.filter((r) => r.level === level).map((r) => [r.id, r]));
  const doorways: Doorway[] = [];
  for (const header of walls) {
    if (!header.header || header.exterior) continue;
    let best: { opening: Opening; d: number } | null = null;
    for (const opening of plan.openings) {
      if (opening.kind !== "door") continue;
      if (!rooms.has(opening.between[0]) || !rooms.has(opening.between[1])) continue;
      const d = Math.hypot(opening.at[0] - header.center[0], opening.at[1] - header.center[1]);
      if (d < 0.3 && (!best || d < best.d)) best = { opening, d };
    }
    if (!best) continue;
    // The leaf opens into the first room named; the normal that points at
    // that room's inside is the way in.
    const along = alongOf(header.angleDeg);
    const normal: Vec2 = [-along[1], along[0]];
    const room = rooms.get(best.opening.between[0])!;
    const inside = interiorPoint(room.polygon);
    const side = (inside[0] - header.center[0]) * normal[0] + (inside[1] - header.center[1]) * normal[1] >= 0 ? 1 : -1;
    doorways.push({ header, opening: best.opening, into: [normal[0] * side, normal[1] * side] });
  }
  return doorways;
}

export function interiorDoors(
  plan: Plan,
  level: number,
  walls: WallSolid[],
  baseY: number,
  colours: { frame: string; leaf: string },
): Part[] {
  const parts: Part[] = [];
  for (const { header, into } of doorwaysOf(plan, level, walls)) {
    const along = alongOf(header.angleDeg);
    const a = header.angleDeg;
    const at = header.center;
    const t = header.thickness;
    const w = header.length;
    const H = DOOR_HEIGHT;
    const put = (al: number, out: number, y: number, size: [number, number, number], colour: string, part: string) =>
      parts.push(placed(at, along, into, al, out, baseY + y, size, a, colour, part));

    // The frame: two jambs and a head, filling the reveal.
    put(-(w / 2 - JAMB / 2), 0, H / 2, [JAMB, H, t], colours.frame, "jamb");
    put(w / 2 - JAMB / 2, 0, H / 2, [JAMB, H, t], colours.frame, "jamb");
    put(0, 0, H - JAMB / 2, [w - JAMB * 2, JAMB, t], colours.frame, "head");

    // Casing on both faces, proud of the plaster.
    for (const s of [-1, 1]) {
      const face = s * (t / 2 + CASING_THICK / 2);
      put(-(w / 2 + CASING / 2), face, (H + CASING) / 2, [CASING, H + CASING, CASING_THICK], colours.frame, "casing");
      put(w / 2 + CASING / 2, face, (H + CASING) / 2, [CASING, H + CASING, CASING_THICK], colours.frame, "casing");
      put(0, face, H + CASING / 2, [w + CASING * 2, CASING, CASING_THICK], colours.frame, "casing");
    }

    // The leaf, hung on the left jamb and standing open into the room:
    // stiles and rails at full thickness, panels set back on both faces.
    const theta = (OPEN_DEG * Math.PI) / 180;
    const leafDir: Vec2 = [along[0] * Math.cos(theta) + into[0] * Math.sin(theta), along[1] * Math.cos(theta) + into[1] * Math.sin(theta)];
    const leafNormal: Vec2 = [-leafDir[1], leafDir[0]];
    const leafAngle = a + OPEN_DEG * (into[0] * -along[1] + into[1] * along[0] >= 0 ? 1 : -1);
    const hinge: Vec2 = [at[0] - along[0] * (w / 2 - JAMB), at[1] - along[1] * (w / 2 - JAMB)];
    const lw = w - JAMB * 2 - 0.01;
    const lh = H - 0.02;
    const leaf = (al: number, y: number, size: [number, number, number], part: string, out = 0, colour = colours.leaf) =>
      parts.push(placed(hinge, leafDir, leafNormal, al, out, baseY + y, size, leafAngle, colour, part));
    leaf(STILE / 2, 0.01 + lh / 2, [STILE, lh, LEAF], "door-leaf");
    leaf(lw - STILE / 2, 0.01 + lh / 2, [STILE, lh, LEAF], "door-leaf");
    const inner = lw - STILE * 2;
    leaf(lw / 2, 0.01 + lh - TOP_RAIL / 2, [inner, TOP_RAIL, LEAF], "door-leaf");
    leaf(lw / 2, 0.01 + BOTTOM_RAIL / 2, [inner, BOTTOM_RAIL, LEAF], "door-leaf");
    const field = lh - TOP_RAIL - BOTTOM_RAIL;
    const rows = 3;
    const rowH = (field - MID_RAIL * (rows - 1)) / rows;
    for (let r = 1; r < rows; r++) {
      leaf(lw / 2, 0.01 + BOTTOM_RAIL + rowH * r + MID_RAIL * (r - 0.5), [inner, MID_RAIL, LEAF], "door-leaf");
    }
    leaf(lw / 2, 0.01 + lh / 2, [STILE * 0.8, field, LEAF], "door-leaf");
    const panelW = (inner - STILE * 0.8) / 2;
    for (let r = 0; r < rows; r++) {
      const y = 0.01 + BOTTOM_RAIL + rowH * (r + 0.5) + MID_RAIL * r;
      for (const side of [-1, 1]) {
        leaf(lw / 2 + side * (STILE * 0.4 + panelW / 2), y, [panelW, rowH, LEAF - PANEL_IN * 2], "door-panel");
      }
    }
    // A handle on each face, a metre up, by the free edge.
    for (const s of [-1, 1]) {
      leaf(lw - 0.08, 1.0, [0.03, 0.12, 0.05], "handle", s * (LEAF / 2 + 0.025), "#b8b6ae");
    }
  }
  return parts;
}
