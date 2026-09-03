import type { WallSolid } from "@/lib/model/walls";
import { type Part, alongOf, placed } from "@/lib/model/parts";
import { doorwaysOf } from "@/lib/model/door-leaves";
import type { Plan } from "@/lib/schema";

/**
 * The small things on a wall that say a house is wired: a switch plate by
 * every door, and an outlet every few metres along the skirting.
 *
 * Nobody photographs a light switch and everybody notices a wall without
 * one - it is the difference between a room and a rendering of a room at
 * exactly the scale a walker looks at. Cheap: a plate is one box.
 */

const PLATE: [number, number, number] = [0.08, 0.12, 0.012];
const PLATE_COLOUR = "#f2f1ee";
const SWITCH_Y = 1.2;
const OUTLET_Y = 0.3;
const OUTLET_EVERY = 3;
/** Proud of the plaster by this much, so the plate sits on the wall and not in it. */
const PROUD = 0.006;

export function switchesFor(plan: Plan, level: number, walls: WallSolid[], baseY: number): Part[] {
  const parts: Part[] = [];

  // A switch on the latch side of each doorway, on the face the leaf opens
  // into, where a hand reaches for it coming in.
  for (const { header, into } of doorwaysOf(plan, level, walls)) {
    const along = alongOf(header.angleDeg);
    parts.push(
      placed(header.center, along, into, header.length / 2 + 0.07 + 0.12, header.thickness / 2 + PROUD, baseY + SWITCH_Y, PLATE, header.angleDeg, PLATE_COLOUR, "switch"),
    );
  }

  // Outlets along every wall long enough to have one: both faces of a
  // partition, the inside face only of an exterior wall.
  for (const wall of walls) {
    if (wall.header || wall.base > 1e-6 || wall.length < 1.5) continue;
    const along = alongOf(wall.angleDeg);
    const normal: [number, number] = [-along[1], along[0]];
    const faces: Array<[number, number]> = wall.exterior && wall.outward
      ? [[-wall.outward[0], -wall.outward[1]]]
      : [normal, [-normal[0], -normal[1]]];
    const count = Math.max(1, Math.floor(wall.length / OUTLET_EVERY));
    for (const face of faces) {
      for (let i = 0; i < count; i++) {
        const al = -wall.length / 2 + (wall.length / (count + 1)) * (i + 1);
        parts.push(placed(wall.center, along, face, al, wall.thickness / 2 + PROUD, baseY + OUTLET_Y, PLATE, wall.angleDeg, PLATE_COLOUR, "outlet"));
      }
    }
  }
  return parts;
}
