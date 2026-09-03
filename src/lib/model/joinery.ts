import { orientedFrameOf } from "@/lib/plan/geometry";
import type { Box, Piece } from "@/lib/model/furniture";
import type { Joinery, RoomSpec, Side } from "@/lib/spec/schema";
import type { Room } from "@/lib/schema";

/**
 * Built-in joinery, as boxes in room-local metres.
 *
 * Deliberately the same `Piece`/`Box` contract the furniture generator uses,
 * and that is worth being explicit about because it buys three things for
 * nothing. The 2D plan already draws whatever that contract produces, so the
 * drawing gains its cabinetry without being told. `elementForPiece` already
 * maps a piece kind onto a bill-of-materials element, so a cabinet becomes a
 * priced line by being named. And the renderer already merges these into one
 * mesh per room, element and colour, so a kitchen's whole run costs one draw
 * call rather than thirty.
 *
 * Everything here is a box. That sounds like a limitation and mostly is not:
 * what makes cabinetry read as cabinetry is not curvature, it is the *reveals*
 * - the shadow gap between two doors, the plinth set back under the carcass,
 * the worktop standing a little proud of the doors below it. Those are all
 * boxes in the right places, and the 3mm fillet every box gets does the rest.
 */

/** Standard carcass sizes. A kitchen is built to these, not to taste. */
const BASE_DEPTH = 0.6;
const BASE_HEIGHT = 0.87;
const WALL_DEPTH = 0.35;
const WALL_BOTTOM = 1.42;
const WALL_TOP = 2.15;
const TALL_HEIGHT = 2.1;
const VANITY_DEPTH = 0.55;
const VANITY_HEIGHT = 0.85;

/** The plinth, set back under the doors. What stops a run looking like a shelf. */
const PLINTH_HEIGHT = 0.1;
const PLINTH_SETBACK = 0.05;

/** The shadow gap between adjacent doors. Three millimetres, as fitted. */
const REVEAL = 0.003;

/** How far a worktop overhangs the doors below it. */
const WORKTOP_PROUD = 0.02;

/** Roughly the width of one door. Runs are divided into this many. */
const DOOR_WIDTH = 0.5;

const CARCASS = "#e8e4dc";
const WORKTOP = "#d8d6d2";
const HANDLE = "#b8bcc0";

type Placement = {
  /** Room-local, x across and y along the room's depth. */
  x: number;
  y: number;
  width: number;
  depth: number;
  /** Which way the fronts face: the run's doors are on this side. */
  facing: Side;
};

/**
 * Turn "the north wall, a third along, three fifths of it" into a footprint.
 *
 * The spec stores fractions rather than metres so a re-layout cannot put a run
 * inside a wall. This is where they become a real rectangle, clamped to the
 * room it is in - a run longer than its wall is a reading that got through, and
 * it is cheaper to trim it here than to reject the whole room's spec for it.
 */
function place(item: Joinery, width: number, depth: number, itemDepth: number): Placement | null {
  const along = Math.max(0, Math.min(1, item.alongM));
  const span = Math.max(0.05, Math.min(1 - along, item.lengthM));

  switch (item.wall) {
    case "north":
      return { x: along * width, y: 0, width: span * width, depth: itemDepth, facing: "north" };
    case "south":
      return {
        x: along * width,
        y: depth - itemDepth,
        width: span * width,
        depth: itemDepth,
        facing: "south",
      };
    case "west":
      return { x: 0, y: along * depth, width: itemDepth, depth: span * depth, facing: "west" };
    case "east":
      return {
        x: width - itemDepth,
        y: along * depth,
        width: itemDepth,
        depth: span * depth,
        facing: "east",
      };
    default:
      return null;
  }
}

/** The run's length along the wall, whichever axis that is. */
const runLength = (p: Placement) =>
  p.facing === "north" || p.facing === "south" ? p.width : p.depth;

const box = (
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  colour: string,
  finish?: Box["finish"],
): Box => ({ center: [x + w / 2, y + h / 2, z + d / 2], size: [w, h, d], colour, ...(finish ? { finish } : {}) });

/** How a worktop takes the light, by what it is made of. */
const WORKTOP_FINISH: Record<NonNullable<NonNullable<Joinery["worktop"]>["material"]>, Box["finish"]> = {
  // Brushed steel: the one worktop that is a metal, and reads as one.
  stainless: { roughness: 0.32, metalness: 0.85 },
  // Polished stone. The sheen is most of what says "stone" at a distance.
  quartz: { roughness: 0.22, metalness: 0 },
  marble: { roughness: 0.2, metalness: 0 },
  granite: { roughness: 0.26, metalness: 0 },
  // Matte, which is the honest answer for both.
  laminate: { roughness: 0.7, metalness: 0 },
  "butcher-block": { roughness: 0.55, metalness: 0 },
};
const worktopFinish = (top: Joinery["worktop"]) =>
  top?.material ? WORKTOP_FINISH[top.material] : undefined;

/** Frame rails and stiles, and how far a panel sits back from the door's face. */
const RAIL = 0.06;
const PANEL_IN = 0.006;
const FIELD_UP = 0.003;

/**
 * One door, in whichever style the photograph said.
 *
 * `doorStyle` was read, stored and never drawn: every door was one flat box,
 * so a shaker kitchen and a slab one rendered identically. The read prompt
 * itself says the difference is "a line of shadow a few millimetres wide
 * around the edge of each door, and it is the single most telling thing about
 * a kitchen's age" - which is exactly what a frame of four boxes round a
 * recessed panel produces, and what one box cannot.
 *
 * `along` is the door's extent along the run, `up` its vertical extent, and
 * `face` the coordinate of the carcass face it sits on. `out` is +1 when the
 * door's front points along the positive axis and -1 when it points back,
 * which is the whole of the orientation problem in one sign.
 */
function door(
  style: Joinery["doorStyle"],
  horizontal: boolean,
  along: [number, number],
  up: [number, number],
  face: number,
  thickness: number,
  out: 1 | -1,
  colour: string,
  boxes: Box[],
): void {
  const [a0, a1] = along;
  const [u0, u1] = up;
  const aw = a1 - a0;
  const uh = u1 - u0;
  // The door occupies [face, face + thickness] when it points forward and
  // [face - thickness, face] when it points back; `near` is its back edge.
  const near = out === 1 ? face : face - thickness;

  const slab = (aa: number, uu: number, ww: number, hh: number, depthFrom: number, depthTo: number, c = colour) => {
    const d0 = Math.min(depthFrom, depthTo);
    const dd = Math.abs(depthTo - depthFrom);
    if (horizontal) boxes.push(box(aa, uu, d0, ww, hh, dd, c));
    else boxes.push(box(d0, uu, aa, dd, hh, ww, c));
  };
  const full: [number, number] = [near, near + thickness];
  // Recessed: the panel's front sits PANEL_IN behind the frame's front.
  const recessed: [number, number] =
    out === 1 ? [near, near + thickness - PANEL_IN] : [near + PANEL_IN, near + thickness];
  // Raised: a field inside the recess, proud of the panel but behind the frame.
  const raised: [number, number] =
    out === 1
      ? [near, near + thickness - PANEL_IN + FIELD_UP]
      : [near + PANEL_IN - FIELD_UP, near + thickness];

  if (style === "slab" || aw < RAIL * 3 || uh < RAIL * 3) {
    slab(a0, u0, aw, uh, ...full);
    return;
  }

  if (style === "glazed") {
    // A frame round a pane. The pane is the same glassy tint the windows use.
    slab(a0, u0, aw, RAIL, ...full);
    slab(a0, u1 - RAIL, aw, RAIL, ...full);
    slab(a0, u0 + RAIL, RAIL, uh - RAIL * 2, ...full);
    slab(a1 - RAIL, u0 + RAIL, RAIL, uh - RAIL * 2, ...full);
    slab(a0 + RAIL, u0 + RAIL, aw - RAIL * 2, uh - RAIL * 2, ...recessed, "#cfe0ea");
    return;
  }

  if (style === "beadboard") {
    // A flat door with vertical grooves: the face, then three shallow
    // channels cut into it.
    slab(a0, u0, aw, uh, ...full);
    const grooves = 3;
    for (let i = 1; i <= grooves; i++) {
      const at = a0 + (aw * i) / (grooves + 1);
      slab(at - 0.003, u0 + RAIL, 0.006, uh - RAIL * 2, ...recessed, shift(colour, -14));
    }
    return;
  }

  // Shaker and raised-panel: a frame round a recessed panel. The raised one
  // adds a field standing a little proud inside the recess.
  slab(a0, u0, aw, RAIL, ...full);
  slab(a0, u1 - RAIL, aw, RAIL, ...full);
  slab(a0, u0 + RAIL, RAIL, uh - RAIL * 2, ...full);
  slab(a1 - RAIL, u0 + RAIL, RAIL, uh - RAIL * 2, ...full);
  slab(a0 + RAIL, u0 + RAIL, aw - RAIL * 2, uh - RAIL * 2, ...recessed);
  if (style === "raised-panel") {
    const inset = RAIL + 0.03;
    slab(a0 + inset, u0 + inset, aw - inset * 2, uh - inset * 2, ...raised);
  }
}

/** A colour nudged darker, for a groove or a shadow. */
function shift(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + amount)).toString(16).padStart(2, "0");
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

/**
 * One tier of cabinets: a carcass, its doors, and their handles.
 *
 * The doors are separate boxes standing a millimetre proud of the carcass with
 * a reveal between them, which is the whole trick. A single face panel the
 * length of the run reads as a sideboard; the same panel cut into door-widths
 * with a three-millimetre shadow between each reads as a kitchen, and the only
 * difference is a line of shadow every half metre.
 */
function tier(
  p: Placement,
  base: number,
  height: number,
  depth: number,
  colour: string,
  hardware: Joinery["hardware"],
  style: Joinery["doorStyle"],
  boxes: Box[],
): void {
  const horizontal = p.facing === "north" || p.facing === "south";
  const length = runLength(p);

  // The carcass, set back by the door thickness so the doors sit on its face.
  const doorThickness = 0.018;
  const carcassDepth = depth - doorThickness;

  if (horizontal) {
    const z = p.facing === "north" ? p.y : p.y + depth - carcassDepth;
    boxes.push(box(p.x, base, z, p.width, height, carcassDepth, colour));
  } else {
    const x = p.facing === "west" ? p.x : p.x + depth - carcassDepth;
    boxes.push(box(x, base, p.y, carcassDepth, height, p.depth, colour));
  }

  // Doors, one per half metre, with a shadow gap between each.
  const count = Math.max(1, Math.round(length / DOOR_WIDTH));
  const doorRun = (length - REVEAL * (count + 1)) / count;
  if (doorRun <= 0.05) return;

  for (let i = 0; i < count; i++) {
    const offset = REVEAL + i * (doorRun + REVEAL);
    const up: [number, number] = [base + REVEAL, base + height - REVEAL];
    if (horizontal) {
      // North-facing fronts point +z from the carcass face; south-facing
      // point -z from theirs.
      const out: 1 | -1 = p.facing === "north" ? 1 : -1;
      const face = p.facing === "north" ? p.y + carcassDepth : p.y + doorThickness;
      door(style, true, [p.x + offset, p.x + offset + doorRun], up, face, doorThickness, out, colour, boxes);
      if (hardware !== "none") {
        const hx = p.x + offset + (i % 2 === 0 ? doorRun - 0.06 : 0.04);
        const front = out === 1 ? face + doorThickness : face - doorThickness;
        const hz = out === 1 ? front : front - 0.02;
        if (hardware === "knob") boxes.push(box(hx - 0.005, base + height * 0.5, hz, 0.03, 0.03, 0.02, HANDLE));
        else boxes.push(box(hx, base + height * 0.6, hz, 0.02, height * 0.28, 0.02, HANDLE));
      }
    } else {
      const out: 1 | -1 = p.facing === "west" ? 1 : -1;
      const face = p.facing === "west" ? p.x + carcassDepth : p.x + doorThickness;
      door(style, false, [p.y + offset, p.y + offset + doorRun], up, face, doorThickness, out, colour, boxes);
      if (hardware !== "none") {
        const hy = p.y + offset + (i % 2 === 0 ? doorRun - 0.06 : 0.04);
        const front = out === 1 ? face + doorThickness : face - doorThickness;
        const hx = out === 1 ? front : front - 0.02;
        if (hardware === "knob") boxes.push(box(hx, base + height * 0.5, hy - 0.005, 0.02, 0.03, 0.03, HANDLE));
        else boxes.push(box(hx, base + height * 0.6, hy, 0.02, height * 0.28, 0.02, HANDLE));
      }
    }
  }
}

/** A run of base units, with its plinth and worktop. */
function baseRun(p: Placement, item: Joinery, boxes: Box[]): void {
  const colour = item.colour ?? CARCASS;
  const horizontal = p.facing === "north" || p.facing === "south";
  const depth = horizontal ? p.depth : p.width;

  // The plinth: set back, and darker for being in shadow. Leaving it out is
  // what makes a run look like a box on the floor rather than a fitted one.
  if (horizontal) {
    const z = p.facing === "north" ? p.y : p.y + depth - (depth - PLINTH_SETBACK);
    boxes.push(box(p.x, 0, z, p.width, PLINTH_HEIGHT, depth - PLINTH_SETBACK, colour));
  } else {
    const x = p.facing === "west" ? p.x : p.x + PLINTH_SETBACK;
    boxes.push(box(x, 0, p.y, depth - PLINTH_SETBACK, PLINTH_HEIGHT, p.depth, colour));
  }

  tier(p, PLINTH_HEIGHT, BASE_HEIGHT - PLINTH_HEIGHT, depth, colour, item.hardware, item.doorStyle, boxes);

  // The worktop, standing proud of the doors on the open side.
  const top = item.worktop;
  const thickness = top?.thicknessM ?? 0.03;
  const topColour = top?.colour ?? WORKTOP;
  const finish = worktopFinish(top);
  if (horizontal) {
    const z = p.facing === "north" ? p.y : p.y - WORKTOP_PROUD;
    boxes.push(box(p.x, BASE_HEIGHT, z, p.width, thickness, depth + WORKTOP_PROUD, topColour, finish));
  } else {
    const x = p.facing === "west" ? p.x : p.x - WORKTOP_PROUD;
    boxes.push(box(x, BASE_HEIGHT, p.y, depth + WORKTOP_PROUD, thickness, p.depth, topColour, finish));
  }
}

/**
 * Every fitted thing in one room, in the contract the renderer already speaks.
 */
export function joineryFor(room: Room, spec: RoomSpec | undefined): Piece[] {
  if (!spec?.joinery?.length) return [];

  // The room's own frame, so a run of units follows the wall it was put on
  // rather than the nearest world axis.
  const frame = orientedFrameOf(room.polygon);
  const { width, depth } = frame;
  if (width < 1 || depth < 1) return [];

  const pieces: Piece[] = [];

  for (const item of spec.joinery) {
    const boxes: Box[] = [];
    const colour = item.colour ?? CARCASS;

    if (item.kind === "island") {
      // Free-standing, in the middle, and only where there is room to walk
      // round it. Nine hundred millimetres each side is the clearance a
      // kitchen needs, and below that an island is an obstruction.
      const iw = Math.min(item.lengthM * width, width - 1.8);
      const id = Math.min(item.depthM ?? 1.0, depth - 1.8);
      if (iw < 0.8 || id < 0.6) continue;
      const x = (width - iw) / 2;
      const y = (depth - id) / 2;
      boxes.push(box(x + PLINTH_SETBACK, 0, y + PLINTH_SETBACK, iw - PLINTH_SETBACK * 2, PLINTH_HEIGHT, id - PLINTH_SETBACK * 2, colour));
      boxes.push(box(x, PLINTH_HEIGHT, y, iw, BASE_HEIGHT - PLINTH_HEIGHT, id, colour));
      const thickness = item.worktop?.thicknessM ?? 0.03;
      boxes.push(
        box(x - WORKTOP_PROUD, BASE_HEIGHT, y - WORKTOP_PROUD, iw + WORKTOP_PROUD * 2, thickness, id + WORKTOP_PROUD * 2, item.worktop?.colour ?? WORKTOP, worktopFinish(item.worktop)),
      );
      pieces.push({ kind: "island", boxes });
      continue;
    }

    const itemDepth =
      item.depthM ??
      (item.kind === "vanity" ? VANITY_DEPTH : item.tier === "wall" ? WALL_DEPTH : BASE_DEPTH);
    const p = place(item, width, depth, itemDepth);
    if (!p) continue;
    if (runLength(p) < 0.4) continue;

    if (item.kind === "vanity") {
      const horizontal = p.facing === "north" || p.facing === "south";
      const d = horizontal ? p.depth : p.width;
      tier(p, 0, VANITY_HEIGHT, d, colour, item.hardware, item.doorStyle, boxes);
      const thickness = item.worktop?.thicknessM ?? 0.03;
      if (horizontal) {
        boxes.push(box(p.x, VANITY_HEIGHT, p.y - WORKTOP_PROUD, p.width, thickness, d + WORKTOP_PROUD, item.worktop?.colour ?? WORKTOP, worktopFinish(item.worktop)));
      } else {
        boxes.push(box(p.x - WORKTOP_PROUD, VANITY_HEIGHT, p.y, d + WORKTOP_PROUD, thickness, p.depth, item.worktop?.colour ?? WORKTOP, worktopFinish(item.worktop)));
      }
      pieces.push({ kind: "vanity", boxes });
      continue;
    }

    if (item.kind === "wardrobe" || item.tier === "tall") {
      const horizontal = p.facing === "north" || p.facing === "south";
      tier(p, 0, TALL_HEIGHT, horizontal ? p.depth : p.width, colour, item.hardware, item.doorStyle, boxes);
      pieces.push({ kind: item.kind === "wardrobe" ? "wardrobe" : "cabinet", boxes });
      continue;
    }

    if (item.tier === "base" || item.tier === "base+wall") baseRun(p, item, boxes);

    if (item.tier === "wall" || item.tier === "base+wall") {
      const wallDepth = WALL_DEPTH;
      const wp = place(item, width, depth, wallDepth);
      if (wp) {
        tier(
          wp,
          WALL_BOTTOM,
          WALL_TOP - WALL_BOTTOM,
          wallDepth,
          colour,
          item.hardware,
          item.doorStyle,
          boxes,
        );
      }
    }

    if (boxes.length > 0) pieces.push({ kind: "cabinet", boxes });
  }

  return pieces.filter((piece) => piece.boxes.length > 0).map((piece) => ({ ...piece, frame }));
}
