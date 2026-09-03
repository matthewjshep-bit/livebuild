import {
  type FloorMaterial,
  type Side,
  type HouseSpec,
  type RoomSpec,
  type Source,
  EMPTY_ROOM_SPEC,
  outranks,
} from "@/lib/spec/schema";
import { boundsOf, roomAdjacency } from "@/lib/plan/geometry";

import { type RoomKind, roomKind, roomKinds } from "@/lib/plan/room-kind";
import type { Plan, Room, Vec2 } from "@/lib/schema";

/**
 * Fill in the house nobody photographed.
 *
 * A listing set covers the rooms that sell a house. It does not cover the
 * landing, the second bathroom, the cupboard under the stairs, or the fourth
 * bedroom that had a bed in it - and yet the model has to build those too. The
 * question is what to build.
 *
 * The wrong answer is to leave them at defaults, because defaults are per-room
 * and a house is not. A landing floored in a generic oak between two rooms
 * floored in a specific walnut does not read as an unphotographed landing; it
 * reads as a mistake. What makes a house cohere is that the same carpenter
 * trimmed all of it, the same floor ran through the circulation, and the
 * ceilings on a storey are the same height.
 *
 * So this reasons rather than defaults. It takes whatever was actually seen,
 * works out the house's own conventions from it, and applies those conventions
 * outward - preferring continuity through an opening over a room-kind guess,
 * and a room-kind guess over nothing. Every value it writes is marked
 * `inferred` and carries a sentence saying why, so the editor can show its
 * working and a person can disagree with it in one click.
 *
 * It is deliberately pure and deliberately runs with no photographs at all: a
 * house built from an address alone still comes out looking like one house
 * rather than a set of unrelated rooms.
 */

/** Rooms that are wet, whatever their neighbours are floored with. */
const WET: RoomKind[] = ["bathroom", "powder", "laundry"];

/** Rooms that are corridors between other rooms rather than destinations. */
const CIRCULATION: RoomKind[] = ["hallway", "entry", "stairs"];

/**
 * Circulation that can open onto a room without a door in between.
 *
 * A hall gives onto a sitting room through an arch all the time. A staircase
 * does not: it opens off the hall, and treating it as though it could be open
 * to whatever it happens to touch is how a flight of stairs ends up taking the
 * kitchen's tiles because the two share a wall.
 */
const OPEN_CIRCULATION: RoomKind[] = ["hallway", "entry"];

/** Rooms an arch can lead into. Somewhere you sit, not somewhere you cook. */
const RECEPTION: RoomKind[] = ["living", "dining"];

/**
 * What a room of each kind is floored with, absent any other evidence.
 *
 * The last resort, and it mirrors the table the texture generator has always
 * used. It is only reached when a room has no observed neighbour to take a
 * cue from, which on a typical listing set is a handful of rooms at most.
 */
const KIND_FLOOR: Record<RoomKind, FloorMaterial> = {
  living: "wood",
  dining: "wood",
  office: "wood",
  hallway: "wood",
  stairs: "wood",
  bedroom: "carpet",
  "primary-bedroom": "carpet",
  closet: "carpet",
  kitchen: "tile",
  laundry: "tile",
  bathroom: "tile",
  powder: "tile",
  entry: "stone",
  garage: "concrete",
  basement: "concrete",
  outside: "grass",
  other: "wood",
};

/** A sensible ceiling for a storey nobody measured. */
const DEFAULT_CEILING_M = 2.7;

/** Standard skirting, and the profile that goes with a plain modern house. */
const DEFAULT_BASEBOARD_M = 0.09;

/** How wide a shared wall has to be before an opening in it reads as an arch. */
const CASED_OPENING_MIN_WALL_M = 2.4;

type Counted<T> = { value: T; count: number };

/** The most common value in a list, or null when the list is empty. */
function mode<T extends string | number>(values: T[]): Counted<T> | null {
  if (values.length === 0) return null;
  const tally = new Map<T, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  let best: Counted<T> | null = null;
  for (const [value, count] of tally) {
    if (!best || count > best.count) best = { value, count };
  }
  return best;
}

/** Read a dotted path off a room spec. */
function at(spec: RoomSpec, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
      spec,
    );
}

/**
 * Write a value only where it would not overwrite a better claim.
 *
 * Everything this module produces is `inferred`, which sits above `assumed`
 * and below everything a photograph or a person supplied. So a room that was
 * actually looked at keeps what was seen, and re-running the inference is
 * always safe - it can only ever fill gaps, never argue with evidence.
 */
function fill(
  spec: RoomSpec,
  path: string,
  value: string | number | boolean,
  why: string,
  source: Source = "inferred",
): void {
  if (!outranks(source, spec.source[path])) return;
  if (at(spec, path) !== undefined && at(spec, path) !== null && spec.source[path] === source) {
    return;
  }

  const keys = path.split(".");
  const leaf = keys.pop()!;
  let node = spec as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (node[key] === undefined || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[leaf] = value;
  spec.source[path] = source;
  spec.because[path] = why;
}

/** A deep-enough copy that filling one room cannot alter another. */
function cloneRoom(spec: RoomSpec | undefined): RoomSpec {
  const base = spec ?? EMPTY_ROOM_SPEC;
  return {
    ...base,
    floor: base.floor ? { ...base.floor } : base.floor,
    walls: base.walls ? { ...base.walls } : base.walls,
    ceiling: base.ceiling ? { ...base.ceiling } : base.ceiling,
    trim: base.trim ? { ...base.trim } : base.trim,
    openings: Object.fromEntries(
      Object.entries(base.openings).map(([id, opening]) => [id, { ...opening }]),
    ),
    source: { ...base.source },
    because: { ...base.because },
  };
}

export type InferenceReport = {
  spec: HouseSpec;
  /** How many fields were filled, for the build notes. */
  filled: number;
  /** One line per convention the house was found to have. */
  conventions: string[];
};

/**
 * The wall a fitted run would actually go on.
 *
 * Length is not the first question, and sorting by it was wrong: the longest
 * wall in a bedroom is very often the one with the door in it, and a wardrobe
 * built across a doorway is not a subtle error - it is a room you cannot get
 * into. So a wall the door opens onto is disqualified outright, and only then
 * does length decide between what is left.
 *
 * The distance is measured to the *nearest point* of the wall rather than its
 * middle, because a door at the end of a long wall still rules that wall out
 * and is a long way from its centre.
 *
 * Exported because the reader needs it too: a photograph that shows fitted
 * units in a room the inference gave none is better evidence of cabinets than
 * a room kind is, and the reader has to put them somewhere.
 */
export function clearestWall(
  room: Room,
  plan: Plan,
): { side: Side; run: number; clearance: number } | null {
  const b = boundsOf(room.polygon);
  const width = b.x1 - b.x0;
  const depth = b.y1 - b.y0;
  if (width < 1.5 || depth < 1.5) return null;

  const doors = plan.openings
    .filter((o) => o.kind !== "stairs" && o.between.includes(room.id))
    .map((o) => o.at);
  const sides: Array<{ side: Side; run: number; a: Vec2; b: Vec2 }> = [
    { side: "north", run: width, a: [b.x0, b.y0], b: [b.x1, b.y0] },
    { side: "south", run: width, a: [b.x0, b.y1], b: [b.x1, b.y1] },
    { side: "west", run: depth, a: [b.x0, b.y0], b: [b.x0, b.y1] },
    { side: "east", run: depth, a: [b.x1, b.y0], b: [b.x1, b.y1] },
  ];
  const nearestDoor = (side: { a: Vec2; b: Vec2 }) =>
    doors.length === 0
      ? Infinity
      : Math.min(
          ...doors.map((d) => {
            const len2 = Math.hypot(side.b[0] - side.a[0], side.b[1] - side.a[1]) ** 2 || 1;
            const t = Math.max(
              0,
              Math.min(
                1,
                ((d[0] - side.a[0]) * (side.b[0] - side.a[0]) +
                  (d[1] - side.a[1]) * (side.b[1] - side.a[1])) /
                  len2,
              ),
            );
            return Math.hypot(
              d[0] - (side.a[0] + (side.b[0] - side.a[0]) * t),
              d[1] - (side.a[1] + (side.b[1] - side.a[1]) * t),
            );
          }),
        );

  const DOOR_CLEAR_M = 0.9;
  const ranked = sides
    .map((side) => ({ ...side, clearance: nearestDoor(side) }))
    .sort((a, z) => z.clearance - a.clearance || z.run - a.run);
  const usable = ranked.filter((side) => side.clearance > DOOR_CLEAR_M);
  // Everything is near a doorway in a small room, and a closet has a door in
  // its only long wall by definition. Taking the clearest available beats
  // fitting nothing at all.
  const best = (usable.length > 0 ? usable : ranked).sort(
    (a, z) => z.run - a.run || z.clearance - a.clearance,
  )[0];
  return { side: best.side, run: best.run, clearance: best.clearance };
}

export function inferHouse(plan: Plan, existing: HouseSpec): InferenceReport {
  const rooms = plan.rooms;
  const spec: HouseSpec = {
    ...existing,
    rooms: Object.fromEntries(rooms.map((room) => [room.id, cloneRoom(existing.rooms[room.id])])),
    defaults: existing.defaults ? { ...existing.defaults } : null,
    inferredAt: Date.now(),
  };
  const conventions: string[] = [];
  const before = countSourced(spec);

  const specOf = (room: Room) => spec.rooms[room.id];
  const observed = (room: Room, path: string) => {
    const source = specOf(room).source[path];
    return source === "read" || source === "verified" || source === "human";
  };

  /* --- 1. The house's own conventions, from whatever was actually seen --- */

  const seenBaseboard = rooms
    .filter((r) => observed(r, "trim.baseboardM"))
    .map((r) => specOf(r).trim?.baseboardM)
    .filter((v): v is number => typeof v === "number");
  const baseboardM = mode(seenBaseboard)?.value ?? DEFAULT_BASEBOARD_M;
  if (seenBaseboard.length > 0) {
    conventions.push(`Skirting runs at ${Math.round(baseboardM * 1000)}mm throughout.`);
  }

  const seenProfile = rooms
    .filter((r) => observed(r, "trim.profile"))
    .map((r) => specOf(r).trim?.profile)
    .filter((v): v is NonNullable<typeof v> => Boolean(v));
  const profile = mode(seenProfile)?.value ?? "square";

  const seenTrimColour = rooms
    .filter((r) => observed(r, "trim.colour"))
    .map((r) => specOf(r).trim?.colour)
    .filter((v): v is string => Boolean(v));
  const trimColour = mode(seenTrimColour)?.value ?? null;

  const seenWallColour = rooms
    .filter((r) => observed(r, "walls.colour"))
    .map((r) => specOf(r).walls?.colour)
    .filter((v): v is string => Boolean(v));
  const wallColour = mode(seenWallColour)?.value ?? null;
  if (seenWallColour.length > 1 && mode(seenWallColour)!.count > 1) {
    conventions.push("Most rooms share one wall colour.");
  }

  // Ceiling height is per storey, not per house: a ground floor is commonly
  // taller than the bedrooms above it, and averaging the two would be wrong in
  // both places.
  const levels = [...new Set(rooms.map((r) => r.level))];
  const ceilingByLevel: Record<string, number> = { ...(existing.defaults?.ceilingM ?? {}) };
  for (const level of levels) {
    const here = rooms.filter((r) => r.level === level);
    const seen = here
      .filter((r) => observed(r, "ceiling.heightM"))
      .map((r) => specOf(r).ceiling?.heightM)
      .filter((v): v is number => typeof v === "number");
    ceilingByLevel[String(level)] = mode(seen)?.value ?? DEFAULT_CEILING_M;
  }

  spec.defaults = {
    ...(spec.defaults ?? {}),
    trim: { baseboardM, profile, crown: null, crownM: null, colour: trimColour },
    ceilingM: ceilingByLevel,
    wallColour,
    ceilingColour: spec.defaults?.ceilingColour ?? null,
  };

  const adjacency = roomAdjacency(plan);
  const byId = new Map(rooms.map((r) => [r.id, r]));

  /* --- 2. Openings: which walls are really doorways --- */
  //
  // Before the floors, and that ordering is load-bearing. Whether a floor runs
  // from one room into the next is decided by whether there is a threshold
  // between them, so the openings have to be settled before continuity can be
  // asked about. Working the other way round - as this did at first - meant
  // every floor was resolved against openings that were all still doors, and a
  // kitchen open to the dining room came out tiled because nothing had yet
  // noticed it was the same space.

  const seenPair = new Set<string>();
  for (const room of rooms) {
    for (const otherId of adjacency.get(room.id) ?? []) {
      const other = byId.get(otherId);
      if (!other) continue;

      // Once per pair, and written to both sides.
      //
      // Evaluating from each room independently gave contradictory answers -
      // the hall called its opening to the sitting room an arch while the
      // sitting room called the same opening a door - because the rule only
      // looks one way round. Two names for one hole in one wall is a thing the
      // editor would have to show and nobody could act on.
      const pair = [room.id, otherId].sort().join("|");
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);

      const kind = roomKind(room.label);
      const otherKind = roomKind(other.label);
      const shared = sharedWallM(room, other);

      const archway =
        (OPEN_CIRCULATION.includes(kind) && RECEPTION.includes(otherKind)) ||
        (OPEN_CIRCULATION.includes(otherKind) && RECEPTION.includes(kind));
      const openPlan =
        (kind === "kitchen" && otherKind === "dining") ||
        (kind === "dining" && otherKind === "kitchen") ||
        (kind === "living" && otherKind === "dining") ||
        (kind === "dining" && otherKind === "living");

      const cased = (archway || openPlan) && shared >= CASED_OPENING_MIN_WALL_M;
      const why = cased
        ? `${room.label} and ${other.label} share ${shared.toFixed(1)}m of wall and are both open rooms, so this reads as an opening rather than a door.`
        : `A doorway between ${room.label} and ${other.label}.`;

      fill(specOf(room), `openings.${otherId}.kind`, cased ? "cased" : "door", why);
      fill(specOf(other), `openings.${room.id}.kind`, cased ? "cased" : "door", why);
    }
  }

  /* --- 3. Floors: continuity first, then the kind of room, then nothing --- */

  /**
   * The rooms a floor genuinely runs into.
   *
   * A doorway is a threshold and floors change at one all the time. A cased
   * opening or a missing wall is not - the two rooms are one space, and a floor
   * that changed material halfway across it would be a deliberate choice rather
   * than the normal case. So continuity propagates through the wide openings
   * only.
   */
  const flowsInto = (room: Room): Room[] =>
    [...(adjacency.get(room.id) ?? [])]
      .map((id) => byId.get(id))
      .filter((other): other is Room => Boolean(other))
      .filter((other) => {
        const kind = specOf(room).openings[other.id]?.kind ?? specOf(other).openings[room.id]?.kind;
        return kind === "cased" || kind === "open";
      });

  const floorOf = (room: Room): FloorMaterial | null =>
    (specOf(room).floor?.material as FloorMaterial | undefined) ?? null;

  // Settled first: everything a photograph actually told us. Those are the
  // seeds continuity spreads from, and they never move.
  const settled = new Set(rooms.filter((r) => observed(r, "floor.material")).map((r) => r.id));

  for (const room of rooms) {
    const kinds = roomKinds(room.label);
    /**
     * The floor follows the *least* fitted of a room's kinds.
     *
     * A room named for two is one space, and one space has one floor. Which
     * one it is follows from how open-plan rooms are actually built: the
     * living room's boards run through into the kitchen far more often than
     * the kitchen's tile runs out into the living room. So the joinery comes
     * from the fitted kind and the floor from the other, and a plain kitchen -
     * which names only itself - is unaffected.
     */
    const floorKind = kinds[kinds.length - 1];
    if (settled.has(room.id)) continue;

    // (a) A wet room is tiled whatever is next door, and whatever else it is
    //     also called. Water is a stronger argument than continuity, and a
    //     carpeted bathroom inferred from the carpeted bedroom it opens off is
    //     the single most obviously wrong thing this could produce.
    if (kinds.some((k) => WET.includes(k))) {
      fill(specOf(room), "floor.material", "tile", `${room.label} is a wet room, so it is tiled.`);
      continue;
    }

    // (b) The floor of whatever it opens into, when it opens into anything.
    const flowing = flowsInto(room)
      .map(floorOf)
      .filter((m): m is FloorMaterial => Boolean(m));
    const continuous = mode(flowing);
    if (continuous) {
      const through = flowsInto(room)
        .filter((other) => floorOf(other) === continuous.value)
        .map((other) => other.label);
      fill(
        specOf(room),
        "floor.material",
        continuous.value,
        `The floor runs straight through from ${through.join(" and ")}, with no threshold between.`,
      );
      continue;
    }

    // (c) Circulation takes whatever most of the rooms it serves are floored
    //     with. A hall is not a destination; it is the thing every other room
    //     is entered from, and it almost always matches them.
    if (kinds.some((k) => CIRCULATION.includes(k))) {
      const served = [...(adjacency.get(room.id) ?? [])]
        .map((id) => byId.get(id))
        .filter((other): other is Room => Boolean(other))
        .filter((other) => settled.has(other.id))
        .map(floorOf)
        .filter((m): m is FloorMaterial => Boolean(m));
      const common = mode(served);
      if (common) {
        fill(
          specOf(room),
          "floor.material",
          common.value,
          `A ${room.label.toLowerCase()} normally matches the rooms it connects, and most of them are ${common.value}.`,
        );
        continue;
      }
    }

    // (d) What a room of this kind usually has.
    fill(
      specOf(room),
      "floor.material",
      KIND_FLOOR[floorKind],
      `Nothing was seen of this room; a ${room.label.toLowerCase()} is usually ${KIND_FLOOR[floorKind]}.`,
    );
  }

  /* --- 4. One oak. Every room with the same material shares its colour --- */

  const colourFor = new Map<FloorMaterial, string>();
  for (const room of rooms) {
    if (!observed(room, "floor.colour")) continue;
    const material = floorOf(room);
    const colour = specOf(room).floor?.colour;
    if (material && colour && !colourFor.has(material)) colourFor.set(material, colour);
  }
  for (const room of rooms) {
    const material = floorOf(room);
    if (!material) continue;
    const colour = colourFor.get(material);
    if (!colour || observed(room, "floor.colour")) continue;
    fill(
      specOf(room),
      "floor.colour",
      colour,
      `A house is laid with one ${material}; this matches the ${material} that was seen elsewhere.`,
    );
  }
  if (colourFor.size > 0) {
    conventions.push(
      `One ${[...colourFor.keys()].join(", one ")} runs through the house.`,
    );
  }

  /* --- 5. The fitted joinery a room of this kind has --- */

  /**
   * A kitchen has cabinets whether or not anybody photographed them.
   *
   * This is the same argument as the floors, one level up. Leaving an
   * unphotographed kitchen empty does not read as "no photograph reached this
   * room", it reads as a kitchen with no kitchen in it - and the fitted units
   * are the single most looked-at thing in a house. So a room of a kind that
   * has joinery gets joinery, against the wall that has the clearest run, and
   * it is marked as the assumption it is.
   *
   * Only where a photograph has not already said otherwise. A run that was
   * read outranks this and is left exactly alone.
   */
  for (const room of rooms) {
    const roomSpec = specOf(room);
    if (roomSpec.joinery.length > 0) continue;

    const kind = roomKind(room.label);
    const b = boundsOf(room.polygon);
    const width = b.x1 - b.x0;
    const depth = b.y1 - b.y0;
    if (width < 1.5 || depth < 1.5) continue;

    const clearest = clearestWall(room, plan);
    if (!clearest) continue;

    if (kind === "kitchen") {
      roomSpec.joinery = [
        {
          id: `${room.id}-run`,
          kind: "cabinet-run",
          wall: clearest.side,
          alongM: 0.05,
          lengthM: 0.85,
          depthM: null,
          tier: "base+wall",
          doorStyle: "shaker",
          colour: null,
          hardware: "bar",
          worktop: { material: "quartz", colour: null, thicknessM: 0.03 },
        },
      ];
      roomSpec.source["joinery"] = "inferred";
      roomSpec.because["joinery"] =
        `Every kitchen has fitted units; these run along the ${clearest.side} wall, which has the clearest ${clearest.run.toFixed(1)}m.`;
      continue;
    }

    if (kind === "bathroom" || kind === "powder") {
      roomSpec.joinery = [
        {
          id: `${room.id}-vanity`,
          kind: "vanity",
          wall: clearest.side,
          alongM: 0.1,
          lengthM: kind === "powder" ? 0.35 : 0.5,
          depthM: null,
          tier: "base",
          doorStyle: "shaker",
          colour: null,
          hardware: "knob",
          worktop: { material: "quartz", colour: null, thicknessM: 0.03 },
        },
      ];
      roomSpec.source["joinery"] = "inferred";
      roomSpec.because["joinery"] = `A ${room.label.toLowerCase()} has a vanity under its basin.`;
      continue;
    }

    if (kind === "closet") {
      // A closet is a room in this model rather than a recess, so it is the one
      // room whose entire purpose is its joinery. Left empty it is a small
      // carpeted box with a door, which is not what anybody means by a closet.
      roomSpec.joinery = [
        {
          id: `${room.id}-hanging`,
          kind: "wardrobe",
          wall: clearest.side,
          alongM: 0.05,
          lengthM: 0.9,
          depthM: 0.6,
          tier: "tall",
          doorStyle: "slab",
          colour: null,
          hardware: "none",
          worktop: null,
        },
      ];
      roomSpec.source["joinery"] = "inferred";
      roomSpec.because["joinery"] =
        "A closet is fitted out along its longest wall; that is what it is for.";
      continue;
    }

    if (kind === "primary-bedroom" || kind === "bedroom") {
      // Only where there is a wall long enough to lose to it. A fitted wardrobe
      // in a small bedroom is the difference between a bedroom and a corridor.
      if (clearest.run < 2.6) continue;
      roomSpec.joinery = [
        {
          id: `${room.id}-wardrobe`,
          kind: "wardrobe",
          wall: clearest.side,
          alongM: 0.1,
          lengthM: 0.55,
          depthM: 0.6,
          tier: "tall",
          doorStyle: "slab",
          colour: null,
          hardware: "edge",
          worktop: null,
        },
      ];
      roomSpec.source["joinery"] = "inferred";
      roomSpec.because["joinery"] =
        `A bedroom with ${clearest.run.toFixed(1)}m of clear wall normally has a fitted wardrobe on it.`;
      continue;
    }

    if (kind === "laundry") {
      roomSpec.joinery = [
        {
          id: `${room.id}-run`,
          kind: "cabinet-run",
          wall: clearest.side,
          alongM: 0.1,
          lengthM: 0.5,
          depthM: null,
          tier: "wall",
          doorStyle: "slab",
          colour: null,
          hardware: "bar",
          worktop: null,
        },
      ];
      roomSpec.source["joinery"] = "inferred";
      roomSpec.because["joinery"] = "A utility room has cupboards over the machines.";
    }
  }

  /* --- 6. Ceilings and trim, from the conventions worked out above --- */

  for (const room of rooms) {
    const roomSpec = specOf(room);
    const level = String(room.level);
    fill(
      roomSpec,
      "ceiling.heightM",
      ceilingByLevel[level] ?? DEFAULT_CEILING_M,
      seenBaseboard.length > 0 || observedAnyCeiling(spec, rooms, room.level)
        ? `Ceilings on this storey were measured at ${(ceilingByLevel[level] ?? DEFAULT_CEILING_M).toFixed(2)}m.`
        : "No ceiling height was seen anywhere, so the house takes a standard one.",
    );
    fill(roomSpec, "trim.baseboardM", baseboardM, "The house's skirting, applied throughout.");
    fill(roomSpec, "trim.profile", profile, "The house's skirting profile, applied throughout.");
    if (trimColour) {
      fill(roomSpec, "trim.colour", trimColour, "The trim colour seen elsewhere in the house.");
    }
    if (wallColour && !observed(room, "walls.colour")) {
      fill(roomSpec, "walls.colour", wallColour, "The wall colour most of the house is painted.");
    }
  }

  const filled = countSourced(spec) - before;
  if (filled > 0) {
    conventions.unshift(
      `Filled in ${filled} detail${filled === 1 ? "" : "s"} for rooms no photograph reached.`,
    );
  }

  return { spec, filled, conventions };
}

function observedAnyCeiling(spec: HouseSpec, rooms: Room[], level: number): boolean {
  return rooms.some((room) => {
    if (room.level !== level) return false;
    const source = spec.rooms[room.id]?.source["ceiling.heightM"];
    return source === "read" || source === "verified" || source === "human";
  });
}

function countSourced(spec: HouseSpec): number {
  return Object.values(spec.rooms).reduce(
    (sum, room) => sum + Object.keys(room.source).length,
    0,
  );
}

/**
 * How much wall two rooms actually share.
 *
 * Measured off the bounding boxes rather than the polygons, because it only
 * ever decides whether an opening is wide enough to read as an archway, and a
 * room's notch is never the side it shares with the room it opens onto.
 */
function sharedWallM(a: Room, b: Room): number {
  const boundsOf = (room: Room) => {
    const xs = room.polygon.map((p) => p[0]);
    const ys = room.polygon.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  const p = boundsOf(a);
  const q = boundsOf(b);
  const overlapX = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
  const overlapY = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
  // Touching on one axis means the shared run is the overlap on the other.
  if (overlapX > 0 && overlapY > -0.3 && overlapY < 0.3) return overlapX;
  if (overlapY > 0 && overlapX > -0.3 && overlapX < 0.3) return overlapY;
  return Math.max(0, Math.min(overlapX, overlapY));
}
