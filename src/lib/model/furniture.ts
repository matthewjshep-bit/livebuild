import { FURNITURE_COLOURS } from "@/lib/model/materials";
import { orientedFrameOf } from "@/lib/plan/geometry";
import { type RoomKind, roomKind } from "@/lib/plan/room-kind";
import type { Opening, Plan, Room, Vec2 } from "@/lib/schema";
import type { RoomSpec } from "@/lib/spec/schema";

/**
 * Furnish a room from what kind of room it is.
 *
 * Procedural rather than modelled: every piece is a handful of boxes assembled
 * in code. Sourced models would look better and would bring asset licensing,
 * megabytes of download, and a house that cannot be furnished offline. Boxes
 * scale to whatever room they land in, which matters more here than fidelity -
 * rooms are generated, so their proportions are never known in advance.
 *
 * Derived, never stored. Improving this improves every tour already built.
 */

export type Box = {
  /** Centre, in room-local metres with the origin at the room's min corner. */
  center: [number, number, number];
  size: [number, number, number];
  colour: string;
  /**
   * How the surface behaves under light, when colour is not the whole story.
   *
   * Absent means what it always meant - the renderer's default for the
   * element. Present, it is how a worktop knows it is stainless rather than
   * laminate: the two can be the same grey and are nothing alike.
   */
  finish?: { roughness: number; metalness: number };
};

export type Piece = {
  kind: string;
  boxes: Box[];
  /**
   * The room's own frame, when it is not square to the world.
   *
   * Boxes are in room-local metres, and until now "room-local" meant the corner
   * of the room's bounding box with the axes pointing the way the world's do.
   * That is exactly right for a rectangular room and increasingly wrong as one
   * turns: the box round a room at thirty degrees is half as big again as the
   * room, so a bed placed against a wall floats in space with the wall running
   * past it diagonally.
   *
   * Absent means what it always meant, so nothing that ignores this changes.
   */
  frame?: { origin: Vec2; rotationDeg: number };
};

/** How much clear floor a doorway needs. Nothing may be placed inside this. */
const DOOR_CLEARANCE = 0.75;

export type Placement = {
  /** Footprint in room-local coordinates. */
  x: number;
  y: number;
  width: number;
  depth: number;
};

export type Wall = "north" | "south" | "east" | "west";

/**
 * The wall furthest from any door.
 *
 * Where a bed or a sofa belongs: against the wall you do not walk through. Beds
 * placed on the door wall look wrong in a way people notice immediately without
 * being able to say why.
 */
function quietestWall(width: number, depth: number, doors: Vec2[]): Wall {
  const candidates: Array<[Wall, Vec2]> = [
    ["north", [width / 2, 0]],
    ["south", [width / 2, depth]],
    ["west", [0, depth / 2]],
    ["east", [width, depth / 2]],
  ];

  let best: Wall = "north";
  let bestDistance = -1;
  for (const [wall, mid] of candidates) {
    const distance = doors.length
      ? Math.min(...doors.map((d) => Math.hypot(d[0] - mid[0], d[1] - mid[1])))
      : mid[1];
    if (distance > bestDistance) {
      bestDistance = distance;
      best = wall;
    }
  }
  return best;
}

function blocksDoor(place: Placement, doors: Vec2[]): boolean {
  for (const door of doors) {
    const nearestX = Math.max(place.x, Math.min(door[0], place.x + place.width));
    const nearestY = Math.max(place.y, Math.min(door[1], place.y + place.depth));
    if (Math.hypot(door[0] - nearestX, door[1] - nearestY) < DOOR_CLEARANCE) return true;
  }
  return false;
}

/** Doorway positions in the room's own frame. */
function doorsOf(plan: Plan, room: Room): Vec2[] {
  const frame = orientedFrameOf(room.polygon);
  const r = (-frame.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return plan.openings
    .filter((o: Opening) => o.kind !== "stairs" && o.between.includes(room.id))
    .map((o) => {
      const dx = o.at[0] - frame.origin[0];
      const dy = o.at[1] - frame.origin[1];
      return [dx * cos - dy * sin, dx * sin + dy * cos] as Vec2;
    });
}

const C = FURNITURE_COLOURS;

/** A rectangular slab, given a footprint and a height range. */
export function slab(
  place: Placement,
  from: number,
  to: number,
  colour: string,
  finish?: Box["finish"],
): Box {
  return {
    center: [place.x + place.width / 2, (from + to) / 2, place.y + place.depth / 2],
    size: [place.width, to - from, place.depth],
    colour,
    ...(finish ? { finish } : {}),
  };
}

/** A colour nudged darker, for the shadowed part of one piece. */
export function darker(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return hex;
  const c = (v: number) => Math.max(0, Math.min(255, v - amount)).toString(16).padStart(2, "0");
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

/**
 * Push a footprint against a wall, centred along it.
 *
 * Furniture in the middle of a room reads as a showroom; against a wall it
 * reads as somewhere someone lives.
 */
export function againstWall(
  wall: Wall,
  width: number,
  depth: number,
  size: [number, number],
  offset = 0.05,
): Placement {
  const [long, deep] = size;
  switch (wall) {
    case "north":
      return { x: (width - long) / 2, y: offset, width: long, depth: deep };
    case "south":
      return { x: (width - long) / 2, y: depth - deep - offset, width: long, depth: deep };
    case "west":
      return { x: offset, y: (depth - long) / 2, width: deep, depth: long };
    case "east":
      return { x: width - deep - offset, y: (depth - long) / 2, width: deep, depth: long };
  }
}

type Builder = (width: number, depth: number, doors: Vec2[], spec?: RoomSpec | null) => Piece[];

const BUILDERS: Partial<Record<RoomKind, Builder>> = {
  bedroom: (w, d, doors, spec) => bedroom(w, d, doors, 1.4, spec),
  "primary-bedroom": (w, d, doors, spec) => bedroom(w, d, doors, 1.6, spec),
  living: livingRoom,
  kitchen: kitchen,
  dining: dining,
  bathroom: bathroom,
  powder: powder,
  office: office,
  garage: garage,
  laundry: laundry,
};

function bedroom(
  width: number,
  depth: number,
  doors: Vec2[],
  bedWidth: number,
  spec?: RoomSpec | null,
): Piece[] {
  const pieces: Piece[] = [];
  const wall = quietestWall(width, depth, doors);
  const bed = againstWall(wall, width, depth, [bedWidth, 2.0], 0.12);
  if (bed.width > width - 0.3 || bed.depth > depth - 0.3 || blocksDoor(bed, doors)) return pieces;

  // The headboard takes the colour the photograph saw, when it saw one.
  const seen = spec?.furnishings?.find((f) => f.kind === "bed");
  const head = seen?.colour ?? C.soft;

  pieces.push({
    kind: "bed",
    boxes: [
      slab(bed, 0.1, 0.4, C.timberDark),
      // Mattress inset, so the base reads as a frame rather than one block.
      slab(
        { x: bed.x + 0.04, y: bed.y + 0.04, width: bed.width - 0.08, depth: bed.depth - 0.08 },
        0.4,
        0.62,
        C.white,
      ),
      slab(
        wall === "north" || wall === "south"
          ? { x: bed.x + 0.1, y: wall === "north" ? bed.y + 0.08 : bed.y + bed.depth - 0.45, width: bed.width - 0.2, depth: 0.37 }
          : { x: wall === "west" ? bed.x + 0.08 : bed.x + bed.width - 0.45, y: bed.y + 0.1, width: 0.37, depth: bed.depth - 0.2 },
        0.62,
        0.74,
        head,
      ),
    ],
  });

  // A wardrobe on the opposite wall, when there is room to open it.
  const opposite: Wall =
    wall === "north" ? "south" : wall === "south" ? "north" : wall === "west" ? "east" : "west";
  const wardrobe = againstWall(opposite, width, depth, [Math.min(1.6, width * 0.5), 0.6]);
  if (!blocksDoor(wardrobe, doors) && depth > 3 && width > 2.6) {
    pieces.push({ kind: "wardrobe", boxes: [slab(wardrobe, 0, 2.0, C.white)] });
  }

  return pieces;
}

function livingRoom(width: number, depth: number, doors: Vec2[], spec?: RoomSpec | null): Piece[] {
  const pieces: Piece[] = [];
  const wall = quietestWall(width, depth, doors);
  const sofa = againstWall(wall, width, depth, [Math.min(2.2, width * 0.6), 0.9], 0.25);
  if (blocksDoor(sofa, doors)) return pieces;

  /**
   * The sofa in the photograph's colour, and its material's finish.
   *
   * It was always `scheme.furniture.soft`, which in every scheme is a pale
   * grey or sand - so a dark leather sofa came back as a pale fabric one, and
   * the room read as staged rather than as the room. A read colour is the
   * exact hex the reader returned, which `recolour` leaves alone precisely
   * because it is not in the palette.
   */
  const seen = spec?.furnishings?.find((f) => f.kind === "sofa");
  const seat = seen?.colour ?? C.soft;
  const back = seen?.colour ? darker(seen.colour, 22) : C.softDark;
  const finish: Box["finish"] | undefined =
    seen?.material === "leather" ? { roughness: 0.5, metalness: 0 } : undefined;

  pieces.push({
    kind: "sofa",
    boxes: [
      slab(sofa, 0.1, 0.42, seat, finish),
      slab(
        wall === "north"
          ? { ...sofa, depth: 0.2 }
          : wall === "south"
            ? { ...sofa, y: sofa.y + sofa.depth - 0.2, depth: 0.2 }
            : wall === "west"
              ? { ...sofa, width: 0.2 }
              : { ...sofa, x: sofa.x + sofa.width - 0.2, width: 0.2 },
        0.42,
        0.78,
        back,
        finish,
      ),
    ],
  });

  const table: Placement = {
    x: width / 2 - 0.55,
    y: depth / 2 - 0.35,
    width: 1.1,
    depth: 0.7,
  };
  if (!blocksDoor(table, doors) && width > 2.6 && depth > 2.6) {
    pieces.push({ kind: "coffee-table", boxes: [slab(table, 0.34, 0.42, C.timber)] });
  }

  const opposite: Wall =
    wall === "north" ? "south" : wall === "south" ? "north" : wall === "west" ? "east" : "west";
  const media = againstWall(opposite, width, depth, [Math.min(1.8, width * 0.5), 0.4]);
  if (!blocksDoor(media, doors)) {
    pieces.push({
      kind: "media-unit",
      boxes: [slab(media, 0, 0.5, C.timberDark), slab(media, 0.62, 1.28, C.dark)],
    });
  }

  return pieces;
}

function kitchen(width: number, depth: number, doors: Vec2[]): Piece[] {
  const pieces: Piece[] = [];
  const runWall: Wall = width >= depth ? "north" : "west";
  const run = againstWall(runWall, width, depth, [width >= depth ? width * 0.9 : depth * 0.9, 0.62], 0.02);

  if (!blocksDoor(run, doors)) {
    pieces.push({
      kind: "counter",
      boxes: [
        slab(run, 0, 0.86, C.white),
        // A worktop slightly proud of the units, which is what makes a counter
        // run look like cabinetry rather than a shelf.
        slab({ ...run, x: run.x - 0.02, y: run.y - 0.02, width: run.width + 0.04, depth: run.depth + 0.04 }, 0.86, 0.92, C.dark),
      ],
    });
  }

  const island: Placement = { x: width / 2 - 0.8, y: depth / 2 - 0.4, width: 1.6, depth: 0.8 };
  if (width > 3.4 && depth > 3.2 && !blocksDoor(island, doors)) {
    pieces.push({
      kind: "island",
      boxes: [slab(island, 0, 0.86, C.white), slab(island, 0.86, 0.93, C.dark)],
    });
  }

  const fridge = againstWall(runWall === "north" ? "east" : "south", width, depth, [0.75, 0.7]);
  if (!blocksDoor(fridge, doors)) {
    pieces.push({ kind: "fridge", boxes: [slab(fridge, 0, 1.8, C.metal)] });
  }

  return pieces;
}

function dining(width: number, depth: number, doors: Vec2[]): Piece[] {
  const tableW = Math.min(1.6, width * 0.55);
  const tableD = Math.min(0.9, depth * 0.45);
  const table: Placement = {
    x: width / 2 - tableW / 2,
    y: depth / 2 - tableD / 2,
    width: tableW,
    depth: tableD,
  };
  if (blocksDoor(table, doors)) return [];

  const boxes: Box[] = [
    slab(table, 0.68, 0.76, C.timber),
    slab({ ...table, x: table.x + 0.08, y: table.y + 0.08, width: table.width - 0.16, depth: table.depth - 0.16 }, 0, 0.68, C.timberDark),
  ];

  // Chairs down the long sides only; ends look cluttered at this scale.
  const seats = Math.max(2, Math.min(3, Math.floor(tableW / 0.6)));
  for (let i = 0; i < seats; i++) {
    const x = table.x + ((i + 0.5) / seats) * table.width - 0.2;
    for (const y of [table.y - 0.5, table.y + table.depth + 0.1]) {
      boxes.push(slab({ x, y, width: 0.4, depth: 0.4 }, 0.3, 0.46, C.soft));
      boxes.push(slab({ x, y, width: 0.4, depth: 0.08 }, 0.46, 0.92, C.softDark));
    }
  }

  return [{ kind: "dining-set", boxes }];
}

function bathroom(width: number, depth: number, doors: Vec2[]): Piece[] {
  const pieces: Piece[] = [];
  const wall = quietestWall(width, depth, doors);
  const bath = againstWall(wall, width, depth, [Math.min(1.7, Math.max(width, depth) * 0.8), 0.75], 0.02);

  if (!blocksDoor(bath, doors) && Math.max(width, depth) > 1.9) {
    pieces.push({
      kind: "bath",
      boxes: [
        slab(bath, 0, 0.55, C.white),
        slab({ x: bath.x + 0.07, y: bath.y + 0.07, width: bath.width - 0.14, depth: bath.depth - 0.14 }, 0.42, 0.56, C.glassy),
      ],
    });
  }

  const basinWall: Wall = wall === "north" ? "south" : wall === "south" ? "north" : wall === "west" ? "east" : "west";
  const basin = againstWall(basinWall, width, depth, [0.6, 0.45]);
  if (!blocksDoor(basin, doors)) {
    pieces.push({ kind: "basin", boxes: [slab(basin, 0.55, 0.88, C.white)] });
  }

  const wc = againstWall(basinWall, width, depth, [0.4, 0.62]);
  wc.x = Math.max(0.05, wc.x - 0.85);
  if (!blocksDoor(wc, doors) && wc.x > 0.02) {
    pieces.push({ kind: "wc", boxes: [slab(wc, 0, 0.4, C.white), slab({ ...wc, depth: 0.2 }, 0.4, 0.75, C.white)] });
  }

  return pieces;
}

function powder(width: number, depth: number, doors: Vec2[]): Piece[] {
  const wall = quietestWall(width, depth, doors);
  const basin = againstWall(wall, width, depth, [0.5, 0.4]);
  const wc = againstWall(wall === "north" ? "south" : "north", width, depth, [0.4, 0.6]);
  const pieces: Piece[] = [];
  if (!blocksDoor(basin, doors)) pieces.push({ kind: "basin", boxes: [slab(basin, 0.55, 0.85, C.white)] });
  if (!blocksDoor(wc, doors)) pieces.push({ kind: "wc", boxes: [slab(wc, 0, 0.4, C.white)] });
  return pieces;
}

function office(width: number, depth: number, doors: Vec2[]): Piece[] {
  const wall = quietestWall(width, depth, doors);
  const desk = againstWall(wall, width, depth, [Math.min(1.5, width * 0.6), 0.65], 0.1);
  if (blocksDoor(desk, doors)) return [];
  return [
    {
      kind: "desk",
      boxes: [
        slab(desk, 0.7, 0.76, C.timber),
        slab({ ...desk, width: 0.06 }, 0, 0.7, C.metal),
        slab({ ...desk, x: desk.x + desk.width - 0.06, width: 0.06 }, 0, 0.7, C.metal),
      ],
    },
  ];
}

function laundry(width: number, depth: number, doors: Vec2[]): Piece[] {
  const wall = quietestWall(width, depth, doors);
  const machines = againstWall(wall, width, depth, [Math.min(1.3, width * 0.8), 0.6]);
  if (blocksDoor(machines, doors)) return [];
  return [{ kind: "machines", boxes: [slab(machines, 0, 0.88, C.white)] }];
}

function garage(width: number, depth: number, doors: Vec2[]): Piece[] {
  const car: Placement = {
    x: width / 2 - 0.9,
    y: depth / 2 - 2.2,
    width: 1.8,
    depth: 4.4,
  };
  // Every other builder asks this and this one never did, which made the
  // garage the one room where the "nothing may block a doorway" rule was not
  // enforced - on the largest object in the house, in the room most likely to
  // have a side door onto a narrow wall.
  if (car.width > width - 0.6 || car.depth > depth - 0.6 || blocksDoor(car, doors)) return [];
  return [
    {
      kind: "car",
      boxes: [
        slab(car, 0.25, 0.75, C.softDark),
        slab({ x: car.x + 0.15, y: car.y + 1.0, width: car.width - 0.3, depth: car.depth * 0.45 }, 0.75, 1.15, C.glassy),
      ],
    },
  ];
}

/**
 * Furnish one room.
 *
 * Pieces that will not fit with clearance are skipped rather than shrunk: a bed
 * squeezed into a room too small for it looks more broken than an empty room,
 * and generated rooms are sometimes genuinely too small.
 */
export function furnishRoom(plan: Plan, room: Room, spec?: RoomSpec | null): Piece[] {
  // Measured in the room's own frame, so an angled room is furnished to its own
  // walls rather than to the larger box the world would draw round it.
  const frame = orientedFrameOf(room.polygon);
  const { width, depth } = frame;
  if (width < 1.2 || depth < 1.2) return [];

  const builder = BUILDERS[roomKind(room.label)];
  if (!builder) return [];

  const doors = doorsOf(plan, room);
  return builder(width, depth, doors, spec)
    .filter((piece) => piece.boxes.length > 0)
    .map((piece) => ({ ...piece, frame }));
}
