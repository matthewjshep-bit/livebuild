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
): Box => ({ center: [x + w / 2, y + h / 2, z + d / 2], size: [w, h, d], colour });

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
    if (horizontal) {
      const z = p.facing === "north" ? p.y + carcassDepth : p.y;
      boxes.push(box(p.x + offset, base + REVEAL, z, doorRun, height - REVEAL * 2, doorThickness, colour));
      if (hardware !== "none") {
        // A bar pull, run vertically near the leading edge of each door.
        const hx = p.x + offset + (i % 2 === 0 ? doorRun - 0.06 : 0.04);
        const hz = p.facing === "north" ? z + doorThickness : z - 0.02;
        boxes.push(box(hx, base + height * 0.6, hz, 0.02, height * 0.28, 0.02, HANDLE));
      }
    } else {
      const x = p.facing === "west" ? p.x + carcassDepth : p.x;
      boxes.push(box(x, base + REVEAL, p.y + offset, doorThickness, height - REVEAL * 2, doorRun, colour));
      if (hardware !== "none") {
        const hy = p.y + offset + (i % 2 === 0 ? doorRun - 0.06 : 0.04);
        const hx = p.facing === "west" ? x + doorThickness : x - 0.02;
        boxes.push(box(hx, base + height * 0.6, hy, 0.02, height * 0.28, 0.02, HANDLE));
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

  tier(p, PLINTH_HEIGHT, BASE_HEIGHT - PLINTH_HEIGHT, depth, colour, item.hardware, boxes);

  // The worktop, standing proud of the doors on the open side.
  const top = item.worktop;
  const thickness = top?.thicknessM ?? 0.03;
  const topColour = top?.colour ?? WORKTOP;
  if (horizontal) {
    const z = p.facing === "north" ? p.y : p.y - WORKTOP_PROUD;
    boxes.push(box(p.x, BASE_HEIGHT, z, p.width, thickness, depth + WORKTOP_PROUD, topColour));
  } else {
    const x = p.facing === "west" ? p.x : p.x - WORKTOP_PROUD;
    boxes.push(box(x, BASE_HEIGHT, p.y, depth + WORKTOP_PROUD, thickness, p.depth, topColour));
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
        box(x - WORKTOP_PROUD, BASE_HEIGHT, y - WORKTOP_PROUD, iw + WORKTOP_PROUD * 2, thickness, id + WORKTOP_PROUD * 2, item.worktop?.colour ?? WORKTOP),
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
      tier(p, 0, VANITY_HEIGHT, d, colour, item.hardware, boxes);
      const thickness = item.worktop?.thicknessM ?? 0.03;
      if (horizontal) {
        boxes.push(box(p.x, VANITY_HEIGHT, p.y - WORKTOP_PROUD, p.width, thickness, d + WORKTOP_PROUD, item.worktop?.colour ?? WORKTOP));
      } else {
        boxes.push(box(p.x - WORKTOP_PROUD, VANITY_HEIGHT, p.y, d + WORKTOP_PROUD, thickness, p.depth, item.worktop?.colour ?? WORKTOP));
      }
      pieces.push({ kind: "vanity", boxes });
      continue;
    }

    if (item.kind === "wardrobe" || item.tier === "tall") {
      const horizontal = p.facing === "north" || p.facing === "south";
      tier(p, 0, TALL_HEIGHT, horizontal ? p.depth : p.width, colour, item.hardware, boxes);
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
          boxes,
        );
      }
    }

    if (boxes.length > 0) pieces.push({ kind: "cabinet", boxes });
  }

  return pieces.filter((piece) => piece.boxes.length > 0).map((piece) => ({ ...piece, frame }));
}
