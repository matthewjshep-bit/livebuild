import { boundsOf } from "@/lib/plan/geometry";
import { clearestWall } from "@/lib/spec/infer";
import { type Box, type Piece, type Wall, againstWall, slab } from "@/lib/model/furniture";
import type { Fixture, RoomSpec } from "@/lib/spec/schema";
import type { Plan, Room } from "@/lib/schema";

/**
 * The fitted things that are not cabinetry, as boxes in room-local metres.
 *
 * A fireplace is the most fixed object in a living room and the first thing
 * anyone notices in a photograph of one, and until now there was no field for
 * it, no builder for it, and no brick to build it from - the reader was told
 * to ignore contents outright. It reports fixtures now, and this is where they
 * become geometry: beside `joinery.ts`, which does the same for cabinets, and
 * apart from `furniture.ts`, whose pieces are staging that a toggle can turn
 * off. A fireplace does not turn off.
 *
 * Boxes, in the codebase's own idiom. A chimney breast proud of the wall, a
 * dark firebox let into it, a hearth, a mantel. It reads as a fireplace from
 * across the room, which is where a dollhouse is looked at from.
 *
 * Built in the room's bounding box with plan axes, exactly as `joinery.ts`
 * does and for the same reason: `Joinery.wall` is a plan direction, and a
 * range has to stand on the wall its run is on. The first version of this
 * used the room's oriented frame, as furniture does, and in a 4x5 kitchen -
 * whose frame is turned a quarter - "north" came out as the wall with the
 * door in it, and the range stood in the doorway.
 */

const BRICK = "#8b4a3a";
const STONE = "#8f8a83";
const STEEL = "#b8bcc0";
const SOOT = "#1e1a17";
const PAINT = "#f4f4f2";
const STEEL_FINISH: Box["finish"] = { roughness: 0.35, metalness: 0.8 };

/** What a fixture is made of, as a colour, when the reader named a material. */
function materialColour(material: string | null | undefined, fallback: string): string {
  const m = (material ?? "").toLowerCase();
  if (/brick/.test(m)) return BRICK;
  if (/stone|slate|granite|marble/.test(m)) return STONE;
  if (/stainless|steel|chrome/.test(m)) return STEEL;
  if (/black|cast/.test(m)) return "#2a2a2c";
  if (/wood|timber|oak|pine/.test(m)) return "#b08a5a";
  return fallback;
}

/**
 * Which of a room's four walls are outside walls.
 *
 * A wall is exterior when no other room on the storey shares it - checked by
 * bounding edges, which is what every placement here already uses. Chimneys
 * are on outside walls; a fireplace on a partition is a fireplace in the
 * middle of the house.
 */
function exteriorWalls(room: Room, plan: Plan): Wall[] {
  const b = boundsOf(room.polygon);
  const others = plan.rooms
    .filter((r) => r.id !== room.id && r.level === room.level)
    .map((r) => boundsOf(r.polygon));
  const EPS = 0.05;
  const overlaps = (a0: number, a1: number, b0: number, b1: number) =>
    Math.min(a1, b1) - Math.max(a0, b0) > 0.3;
  const shared = (wall: Wall) =>
    others.some((o) =>
      wall === "north"
        ? Math.abs(o.y1 - b.y0) < EPS && overlaps(b.x0, b.x1, o.x0, o.x1)
        : wall === "south"
          ? Math.abs(o.y0 - b.y1) < EPS && overlaps(b.x0, b.x1, o.x0, o.x1)
          : wall === "west"
            ? Math.abs(o.x1 - b.x0) < EPS && overlaps(b.y0, b.y1, o.y0, o.y1)
            : Math.abs(o.x0 - b.x1) < EPS && overlaps(b.y0, b.y1, o.y0, o.y1),
    );
  return (["north", "south", "west", "east"] as Wall[]).filter((w) => !shared(w));
}

/** The wall a fitted thing goes on: the cabinet run's wall, else the clearest. */
function runWall(room: Room, spec: RoomSpec, plan: Plan): Wall {
  const run = spec.joinery.find((j) => j.kind === "cabinet-run" && j.wall);
  if (run?.wall) return run.wall as Wall;
  return (clearestWall(room, plan)?.side as Wall | undefined) ?? "north";
}

function fireplace(item: Fixture, wall: Wall, width: number, depth: number): Piece {
  const surround = item.colour ?? materialColour(item.material, BRICK);
  const boxes: Box[] = [
    // The chimney breast, floor to ceiling, proud of the wall.
    slab(againstWall(wall, width, depth, [1.6, 0.35], 0), 0, 2.3, surround),
    // The firebox, let into it: a dark opening set a little in.
    slab(againstWall(wall, width, depth, [0.9, 0.3], 0.02), 0.12, 0.82, SOOT),
    // Stone underfoot, a painted shelf above.
    slab(againstWall(wall, width, depth, [1.8, 0.5], 0), 0, 0.03, STONE),
    slab(againstWall(wall, width, depth, [1.7, 0.42], 0), 1.15, 1.2, PAINT),
  ];
  return { kind: "fireplace", boxes };
}

function range(item: Fixture, wall: Wall, width: number, depth: number): Piece {
  const body = item.colour ?? materialColour(item.material, STEEL);
  const p = againstWall(wall, width, depth, [0.76, 0.65], 0);
  const boxes: Box[] = [slab(p, 0, 0.9, body, STEEL_FINISH), slab(p, 0.9, 0.92, "#2a2a2c")];
  // Four hobs on the cooktop.
  const hob = 0.18;
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const x = p.x + 0.12 + i * (p.width - 0.24 - hob);
    const y = p.y + 0.1 + j * (p.depth - 0.2 - hob);
    boxes.push(slab({ x, y, width: hob, depth: hob }, 0.92, 0.935, "#3a3a3c"));
  }
  return { kind: "range", boxes };
}

function hood(item: Fixture, wall: Wall, width: number, depth: number): Piece {
  const colour = item.colour ?? materialColour(item.material, STEEL);
  const canopy = againstWall(wall, width, depth, [0.76, 0.5], 0);
  const flue = againstWall(wall, width, depth, [0.38, 0.25], 0);
  return {
    kind: "hood",
    boxes: [slab(canopy, 1.5, 1.62, colour, STEEL_FINISH), slab(flue, 1.62, 2.3, colour, STEEL_FINISH)],
  };
}

function fridge(item: Fixture, wall: Wall, width: number, depth: number): Piece {
  const p = againstWall(wall, width, depth, [0.78, 0.7], 0);
  return { kind: "fridge", boxes: [slab(p, 0, 1.8, item.colour ?? STEEL, STEEL_FINISH)] };
}

function dishwasher(item: Fixture, wall: Wall, width: number, depth: number): Piece {
  const p = againstWall(wall, width, depth, [0.6, 0.6], 0);
  return { kind: "dishwasher", boxes: [slab(p, 0.1, 0.86, item.colour ?? STEEL, STEEL_FINISH)] };
}

/**
 * Slide a piece along its wall to one end (-1), the other (+1), or leave it (0).
 *
 * `againstWall` centres, and a kitchen's appliances stand in a row rather than
 * on top of one another: the range takes the centre, the fridge one end, the
 * dishwasher the other. Done on the finished boxes so each builder can keep
 * centring, which is the simple thing to get right. The end is 0.9m in from
 * the corner, which keeps a fridge off the return of an L-shaped run.
 */
function offset(piece: Piece, wall: Wall, side: -1 | 0 | 1, width: number, depth: number): Piece {
  if (side === 0) return piece;
  const horizontal = wall === "north" || wall === "south";
  const span = horizontal ? width : depth;
  const target = side === -1 ? 0.9 : span - 0.9;
  return {
    ...piece,
    boxes: piece.boxes.map((b) => {
      const centre = horizontal ? b.center[0] : b.center[2];
      const half = (horizontal ? b.size[0] : b.size[2]) / 2;
      const clamped = Math.max(half + 0.02, Math.min(span - half - 0.02, target));
      const delta = clamped - centre;
      return {
        ...b,
        center: horizontal
          ? [b.center[0] + delta, b.center[1], b.center[2]]
          : [b.center[0], b.center[1], b.center[2] + delta],
      };
    }),
  };
}

/**
 * The wall a room's fireplace stands on, or null when the room has none.
 *
 * An outside wall, and of those the one the door does not open onto -
 * `clearestWall` ranks that - and failing that not the cabinet run's wall.
 * Exported because a chimney is built over it, outside, by `facade-trim.ts`.
 */
export function fireplaceWall(
  room: Room,
  spec: RoomSpec | undefined,
  plan: Plan,
  /**
   * A wall not to use when any other will do: the house's front. The plan
   * does not hold the front door - the site puts it on the front wall - so
   * without this a living room on the front put its fireplace over the
   * door and its chimney in front of it.
   */
  avoid: Wall | null = null,
): Wall | null {
  if (!spec?.fixtures?.some((f) => f.kind === "fireplace")) return null;
  const outside = exteriorWalls(room, plan);
  const run = runWall(room, spec, plan);
  const preferred = clearestWall(room, plan)?.side as Wall | undefined;
  const candidates = avoid ? outside.filter((w) => w !== avoid) : outside;
  return (
    candidates.find((w) => w === preferred) ??
    candidates.find((w) => w !== run) ??
    candidates[0] ??
    outside[0] ??
    preferred ??
    "north"
  );
}

export function fixturesFor(room: Room, spec: RoomSpec | undefined, plan: Plan, avoid: Wall | null = null): Piece[] {
  if (!spec?.fixtures?.length) return [];
  const b = boundsOf(room.polygon);
  const width = b.x1 - b.x0;
  const depth = b.y1 - b.y0;
  if (width < 1.5 || depth < 1.5) return [];

  const run = runWall(room, spec, plan);
  const pieces: Piece[] = [];

  for (const item of spec.fixtures) {
    switch (item.kind) {
      case "fireplace": {
        pieces.push(fireplace(item, fireplaceWall(room, spec, plan, avoid) ?? "north", width, depth));
        break;
      }
      case "range":
        pieces.push(range(item, run, width, depth));
        break;
      case "hood":
        pieces.push(hood(item, run, width, depth));
        break;
      case "fridge":
        pieces.push(offset(fridge(item, run, width, depth), run, -1, width, depth));
        break;
      case "dishwasher":
        pieces.push(offset(dishwasher(item, run, width, depth), run, 1, width, depth));
        break;
      default:
        // wall-oven, built-in-shelving: read and kept, not yet built.
        break;
    }
  }

  // No frame: these are bounds-local, and `Model.tsx` places a frameless
  // piece at the bounding box's corner, which is what joinery gets.
  return pieces;
}
