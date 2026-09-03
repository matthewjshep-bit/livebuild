import { z } from "zod";

/**
 * What each room is actually made of.
 *
 * The plan says where the walls are. This says what they are: the finishes, the
 * ceiling, the trim, the joinery, and how one room opens into the next. It is
 * the difference between a house and *this* house.
 *
 * Three rules hold the design together.
 *
 * **It hangs off `Property`, keyed by room id, never off `Room`.** A re-layout
 * regenerates `Plan.rooms` wholesale, so anything stored on a room is destroyed
 * by a rebuild with no error. `condition` solved this already - a
 * Property-level record plus `carryCondition` to move it by label - and this
 * follows the same path for the same reason.
 *
 * **Every value knows where it came from.** A field that was read off a
 * photograph, a field a person typed, and a field the house simply assumed are
 * three different kinds of claim, and a model that cannot tell them apart will
 * eventually overwrite the one that mattered. `source` is what makes the
 * editor honest and what stops a re-read clobbering a correction.
 *
 * **Absence is the normal case.** Every field is optional. A document with no
 * spec renders exactly as it did before there was one, which is what keeps
 * every tour already published working.
 */

/**
 * How much a value is worth trusting.
 *
 * Ordered deliberately: later beats earlier when two passes want the same
 * field, and `human` beats everything.
 */
export const Source = z.enum(["assumed", "inferred", "read", "verified", "human"]);
export type Source = z.infer<typeof Source>;

export const SOURCE_RANK: Record<Source, number> = {
  assumed: 0,
  inferred: 1,
  read: 2,
  verified: 3,
  human: 4,
};

/** Which of a room's four sides, in plan-space compass terms. */
export const Side = z.enum(["north", "south", "east", "west"]);
export type Side = z.infer<typeof Side>;

/* ------------------------------------------------------------- finishes */

/**
 * The floor materials the texture generator can actually draw.
 *
 * Deliberately the same union as `FloorFinish` in `model/textures.ts` rather
 * than a richer vocabulary that would need translating. A spec that can name a
 * material nothing can render is a spec that lies.
 */
export const FloorMaterial = z.enum([
  "wood",
  "tile",
  "stone",
  "carpet",
  "concrete",
  "grass",
]);
export type FloorMaterial = z.infer<typeof FloorMaterial>;

export const WallMaterial = z.enum([
  "paint",
  "wallpaper",
  "tile",
  "panelling",
  "exposed-brick",
  "timber",
]);
export type WallMaterial = z.infer<typeof WallMaterial>;

export const FloorFinishSpec = z.object({
  material: FloorMaterial.nullish(),
  /** Hex, quantised before it is stored - see `quantiseColour`. */
  colour: z.string().nullish(),
});

export const WallFinishSpec = z.object({
  material: WallMaterial.nullish(),
  colour: z.string().nullish(),
});

/* -------------------------------------------------------------- ceiling */

export const CeilingKind = z.enum(["flat", "tray", "coffered", "beamed", "vaulted", "sloped"]);
export type CeilingKind = z.infer<typeof CeilingKind>;

export const BeamSpec = z.object({
  count: z.number().int().min(1).max(24),
  /** Which way they run across the room. */
  axis: z.enum(["x", "y"]),
  widthM: z.number().positive().default(0.14),
  dropM: z.number().positive().default(0.18),
  colour: z.string().nullish(),
});

export const CeilingSpec = z.object({
  heightM: z.number().min(1.8).max(6).nullish(),
  kind: CeilingKind.default("flat"),
  /** How far a tray or coffer is recessed above the surrounding ceiling. */
  liftM: z.number().nonnegative().default(0.15),
  /** How wide the flat border around a tray is. */
  marginM: z.number().nonnegative().default(0.5),
  beams: BeamSpec.nullish(),
  colour: z.string().nullish(),
});
export type CeilingSpec = z.infer<typeof CeilingSpec>;
export type BeamSpec = z.infer<typeof BeamSpec>;

/* ----------------------------------------------------------------- trim */

export const TrimProfile = z.enum(["square", "ogee", "stepped", "colonial", "chamfer"]);
export type TrimProfile = z.infer<typeof TrimProfile>;

export const TrimSpec = z.object({
  baseboardM: z.number().positive().nullish(),
  profile: TrimProfile.nullish(),
  crown: z.boolean().nullish(),
  crownM: z.number().positive().nullish(),
  colour: z.string().nullish(),
});

/* ------------------------------------------------------------- openings */

/**
 * How one room gives onto another.
 *
 * `Opening.width` has existed on the plan all along, but every opening is
 * derived from adjacency by `autoOpenings` and every one comes out a doorway -
 * so a kitchen that opens to the dining room across three metres was built with
 * a wall and a single door in it. That is a room-layout fact and it changes how
 * a house reads more than almost anything else on this page.
 */
export const OpeningKind = z.enum(["door", "cased", "open", "none"]);
export type OpeningKind = z.infer<typeof OpeningKind>;

export const OpeningSpec = z.object({
  kind: OpeningKind.default("door"),
  widthM: z.number().positive().nullish(),
});

/* --------------------------------------------------------------- shape */

/**
 * One room giving a rectangle of floor to the room next door.
 *
 * The only way a room's shape may change, and deliberately the only way. The
 * building's outline is survey data and stays put, so an L-shaped living room
 * is the dining room ceding it a corner - which conserves the floor area by
 * construction and leaves the shell untouched, rather than by anyone
 * remembering to check.
 */
export const ShapeEdit = z.object({
  /** The room giving up floor. */
  from: z.string().min(1),
  /** The adjacent room receiving it, on the same storey. */
  to: z.string().min(1),
  /** What moves, in plan-space metres. */
  rect: z.object({
    x0: z.number(),
    y0: z.number(),
    x1: z.number(),
    y1: z.number(),
  }),
  source: Source.default("read"),
  why: z.string().default(""),
});
export type ShapeEdit = z.infer<typeof ShapeEdit>;

/* ------------------------------------------------------------- joinery */

export const DoorStyle = z.enum(["shaker", "slab", "raised-panel", "glazed", "beadboard"]);
export type DoorStyle = z.infer<typeof DoorStyle>;

export const WorktopMaterial = z.enum([
  "quartz",
  "granite",
  "laminate",
  "butcher-block",
  "stainless",
  "marble",
]);

export const Worktop = z.object({
  material: WorktopMaterial.default("quartz"),
  colour: z.string().nullish(),
  /** 20mm, 30mm and 40mm are what a slab is cut to. */
  thicknessM: z.number().positive().default(0.03),
});

/**
 * Built-in joinery: the things a buyer is purchasing rather than the things the
 * seller will take away.
 *
 * Placed against a wall as a fraction along it rather than at a coordinate,
 * for the reason every placement in this schema is: a re-layout resizes rooms,
 * and a run stored at 2.1 metres from a corner ends up inside a wall while a
 * run stored as "the north wall, starting a third of the way along" does not.
 */
export const Joinery = z.object({
  id: z.string().min(1),
  kind: z.enum(["cabinet-run", "island", "vanity", "wardrobe"]),
  /** Which wall it stands against. Islands stand free and ignore this. */
  wall: Side.nullish(),
  /** Where the run starts, as a fraction along that wall. */
  alongM: z.number().min(0).max(1).default(0),
  /** How much of the wall it takes, as a fraction. */
  lengthM: z.number().min(0.05).max(1).default(0.6),
  depthM: z.number().positive().nullish(),
  /** Base units, wall units, or both. */
  tier: z.enum(["base", "wall", "base+wall", "tall"]).default("base+wall"),
  doorStyle: DoorStyle.default("shaker"),
  colour: z.string().nullish(),
  hardware: z.enum(["bar", "knob", "edge", "none"]).default("bar"),
  worktop: Worktop.nullish(),
});
export type Joinery = z.infer<typeof Joinery>;

/* ------------------------------------------------------------ contents */

/**
 * What is in the room, in two lists that mean two different things.
 *
 * The reader was told to ignore contents outright - "the building, not its
 * contents" - and so a brick fireplace, the most fixed thing in a living room,
 * had no field to land in, and a sofa's colour, the most visible thing in the
 * photograph, was never asked for. The distinction the prompt was drawing is
 * real and is kept; it just needs both halves.
 *
 * A **fixture** is fitted: the buyer is purchasing it, the scope of work may
 * price it, and it is still there when the seller's van has gone. A
 * **furnishing** is theirs: wanted only for what it looks like, so a room
 * reads as the room in the photograph rather than a showroom in the scheme's
 * colours.
 */
export const FixtureKind = z.enum([
  "fireplace",
  "range",
  "hood",
  "dishwasher",
  "wall-oven",
  "fridge",
  "built-in-shelving",
]);
export type FixtureKind = z.infer<typeof FixtureKind>;

export const Fixture = z.object({
  id: z.string().min(1),
  kind: FixtureKind,
  /** Free text: "brick", "stainless steel", "cast iron". The builder maps it. */
  material: z.string().nullish(),
  colour: z.string().nullish(),
});
export type Fixture = z.infer<typeof Fixture>;

export const FurnishingKind = z.enum(["sofa", "armchair", "bed", "dining-table", "desk", "rug"]);
export type FurnishingKind = z.infer<typeof FurnishingKind>;

export const Furnishing = z.object({
  id: z.string().min(1),
  kind: FurnishingKind,
  colour: z.string().nullish(),
  material: z.enum(["leather", "fabric", "wood", "metal"]).nullish(),
});
export type Furnishing = z.infer<typeof Furnishing>;

/* ------------------------------------------------------------- the room */

export const RoomSpec = z.object({
  floor: FloorFinishSpec.nullish(),
  walls: WallFinishSpec.nullish(),
  ceiling: CeilingSpec.nullish(),
  trim: TrimSpec.nullish(),
  /** Keyed by the other room's id. */
  openings: z.record(z.string(), OpeningSpec).default({}),
  /** Cabinetry, islands, vanities and built-in wardrobes. */
  joinery: z.array(Joinery).default([]),
  /** Fitted things that are not cabinetry: a fireplace, a range, a hood. */
  fixtures: z.array(Fixture).default([]),
  /** The seller's things, kept for their colour and their presence. */
  furnishings: z.array(Furnishing).default([]),
  /**
   * Where each field came from, keyed by dotted path - `floor.material`,
   * `ceiling.heightM`, `openings.r3.kind`.
   *
   * Kept beside the values rather than wrapped around each one. Wrapping
   * doubles the schema and forces every consumer to unwrap a field it only
   * wants the value of; a parallel map costs one lookup at exactly the two
   * places that care, which are the merge and the editor.
   */
  source: z.record(z.string(), Source).default({}),
  /** Why a value was assumed, for the paths that were. Shown in the editor. */
  because: z.record(z.string(), z.string()).default({}),
  /** True once a photograph has actually been read for this room. */
  observed: z.boolean().default(false),
  notes: z.string().default(""),
});
export type RoomSpec = z.infer<typeof RoomSpec>;

/**
 * What the house does when a room says nothing.
 *
 * A house has one carpenter. The trim is the same profile throughout, the doors
 * match, the ceilings on a storey are the same height - not because that is
 * always true, but because it is true far more often than any per-room guess,
 * and a house whose every room disagrees reads as a collage rather than a
 * building.
 */
export const HouseDefaults = z.object({
  trim: TrimSpec.nullish(),
  /** Ceiling height per storey, keyed by level as a string. */
  ceilingM: z.record(z.string(), z.number().positive()).default({}),
  wallColour: z.string().nullish(),
  ceilingColour: z.string().nullish(),
});
export type HouseDefaults = z.infer<typeof HouseDefaults>;

export const HouseSpec = z.object({
  version: z.literal(1).default(1),
  rooms: z.record(z.string(), RoomSpec).default({}),
  defaults: HouseDefaults.nullish(),
  /** Anything a pass proposed and the gates refused, with the reason. */
  rejections: z
    .array(
      z.object({
        roomId: z.string(),
        path: z.string(),
        proposed: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  /**
   * Room shapes, as transfers between neighbours.
   *
   * Kept at the house level rather than on a room because an edit is about two
   * rooms at once, and because it has to survive a re-layout: the polygon it
   * produces is regenerated by the packer, and this is the recipe for putting
   * it back.
   */
  shapeEdits: z.array(ShapeEdit).default([]),
  /** When the inference last ran, so the editor can say how fresh it is. */
  inferredAt: z.number().nullish(),
});
export type HouseSpec = z.infer<typeof HouseSpec>;

/* ---------------------------------------------------------------- helpers */

export const EMPTY_ROOM_SPEC: RoomSpec = RoomSpec.parse({});

/**
 * Round a measured colour to something a house could have been painted.
 *
 * Colour is part of the merge key in `Model.tsx`, so twelve rooms reporting
 * twelve imperceptibly different whites become twelve meshes and twelve
 * generated textures. Quantising to 12 levels a channel keeps every distinction
 * anyone can see and collapses the ones nobody can.
 */
export function quantiseColour(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  const step = (channel: number) => {
    const quantised = Math.round((channel / 255) * 11) * (255 / 11);
    return Math.max(0, Math.min(255, Math.round(quantised)));
  };
  const r = step((value >> 16) & 255);
  const g = step((value >> 8) & 255);
  const b = step(value & 255);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether `next` is allowed to overwrite what `current` already holds. */
export function outranks(next: Source, current: Source | undefined): boolean {
  if (current === undefined) return true;
  // Equal ranks overwrite: a second read of the same room is a newer reading of
  // the same quality, not a competing one. Only a person's edit is sticky, and
  // it is sticky because nothing else reaches its rank.
  return SOURCE_RANK[next] >= SOURCE_RANK[current];
}
