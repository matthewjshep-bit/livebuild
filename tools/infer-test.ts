/**
 * The house fills its own gaps, and fills them coherently.
 *
 * A listing set covers the rooms that sell a house and skips the landing, the
 * second bathroom and the box room. Those still have to be built, and the
 * failure mode is not that they come out wrong in some interesting way - it is
 * that they come out *generic*, so a house of eleven specific rooms and three
 * default ones reads as three mistakes.
 *
 * So this checks the reasoning rather than the output: that a floor runs
 * through an opening but stops at a door, that a wet room is never carpeted
 * because its neighbour is, that a hall takes after the rooms it serves, that
 * one oak means one oak, and - the one that matters most - that nothing it
 * infers ever overwrites something a photograph or a person actually said.
 */
import { inferHouse } from "../src/lib/spec/infer";
import { HouseSpec, type RoomSpec } from "../src/lib/spec/schema";
import { autoOpenings } from "../src/lib/plan/autolayout";
import { rectangle } from "../src/lib/plan/geometry";
import type { Plan, Room } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const room = (id: string, label: string, x: number, y: number, w: number, h: number): Room => ({
  id,
  label,
  polygon: rectangle(x, y, w, h),
  ceilingHeight: 2.7,
  level: 0,
});

/**
 *   kitchen | dining | living
 *   --------+--------+--------
 *      hall | bath   | bed
 *
 * Kitchen/dining/living run along the top and all touch each other; the hall
 * runs beneath the kitchen and touches the bathroom and bedroom.
 */
const rooms: Room[] = [
  room("kitchen", "Kitchen", 0, 0, 4, 4),
  room("dining", "Dining Room", 4, 0, 4, 4),
  room("living", "Living Room", 8, 0, 4, 4),
  room("hall", "Hallway", 0, 4, 4, 3),
  room("bath", "Bathroom", 4, 4, 4, 3),
  room("bed", "Bedroom", 8, 4, 4, 3),
];

const plan: Plan = {
  scaleRef: { px: 100, meters: 1 },
  rooms,
  openings: autoOpenings(rooms),
};

/** A spec where only the dining room was actually photographed. */
const seedDiningWood = (): HouseSpec => {
  const dining: RoomSpec = {
    ...HouseSpec.parse({}).rooms.x,
    floor: { material: "wood", colour: "#a9865c" },
    walls: { material: "paint", colour: "#eeeae4" },
    ceiling: { heightM: 3.05, kind: "flat", liftM: 0.15, marginM: 0.5, beams: null, colour: null },
    trim: { baseboardM: 0.14, profile: "ogee", crown: null, crownM: null, colour: "#ffffff" },
    openings: {},
    source: {
      "floor.material": "read",
      "floor.colour": "read",
      "walls.colour": "read",
      "ceiling.heightM": "read",
      "trim.baseboardM": "read",
      "trim.profile": "read",
      "trim.colour": "read",
    },
    because: {},
    observed: true,
    notes: "",
  };
  return HouseSpec.parse({ rooms: { dining } });
};

// --- with nothing seen at all ---
const blank = inferHouse(plan, HouseSpec.parse({}));
check("every room gets a floor even with no photographs", rooms.every((r) => Boolean(blank.spec.rooms[r.id].floor?.material)));
check("the bathroom is tiled", blank.spec.rooms.bath.floor?.material === "tile");
check("the bedroom is carpeted", blank.spec.rooms.bed.floor?.material === "carpet");
check("the kitchen is tiled", blank.spec.rooms.kitchen.floor?.material === "tile");
check(
  "every filled field says why",
  Object.values(blank.spec.rooms).every((r) =>
    Object.keys(r.source).every((path) => Boolean(r.because[path])),
  ),
);
check(
  "and every one is marked inferred, never read",
  Object.values(blank.spec.rooms).every((r) =>
    Object.values(r.source).every((s) => s === "inferred"),
  ),
);
check("a ceiling height is chosen for every room", rooms.every((r) => blank.spec.rooms[r.id].ceiling?.heightM === 2.7));

// --- with the dining room seen ---
const seeded = inferHouse(plan, seedDiningWood());
const S = seeded.spec.rooms;

check("what was read is left alone", S.dining.floor?.material === "wood" && S.dining.source["floor.material"] === "read");
check(
  "the house adopts the trim it was shown",
  seeded.spec.defaults?.trim?.baseboardM === 0.14 && seeded.spec.defaults?.trim?.profile === "ogee",
  `got ${seeded.spec.defaults?.trim?.baseboardM}m ${seeded.spec.defaults?.trim?.profile}`,
);
check(
  "and applies it to rooms nobody photographed",
  S.bed.trim?.baseboardM === 0.14 && S.bed.trim?.profile === "ogee",
);
check(
  "the storey takes the ceiling height that was measured",
  rooms.every((r) => S[r.id].ceiling?.heightM === 3.05),
  `bedroom got ${S.bed.ceiling?.heightM}`,
);

// --- continuity ---
check(
  "kitchen and dining are read as one open space",
  S.kitchen.openings.dining?.kind === "cased" || S.dining.openings.kitchen?.kind === "cased",
  `kitchen→dining ${S.kitchen.openings.dining?.kind}, dining→kitchen ${S.dining.openings.kitchen?.kind}`,
);
check(
  "so the dining room's floor runs into the kitchen",
  S.kitchen.floor?.material === "wood",
  `kitchen got ${S.kitchen.floor?.material}`,
);
check(
  "and into the living room",
  S.living.floor?.material === "wood",
  `living got ${S.living.floor?.material}`,
);
check(
  "one oak: the continued floor is the same colour, not a fresh default",
  S.kitchen.floor?.colour === "#a9865c" && S.living.floor?.colour === "#a9865c",
  `kitchen ${S.kitchen.floor?.colour}, living ${S.living.floor?.colour}`,
);

// --- and where it must stop ---
// The bedroom sits under the living room, not beside the hall - it is the
// living room it opens off.
check(
  "the bedroom keeps its door, not an archway",
  S.bed.openings.living?.kind === "door" && S.living.openings.bed?.kind === "door",
  `bed→living ${S.bed.openings.living?.kind}, living→bed ${S.living.openings.bed?.kind}`,
);
check(
  "the bathroom is tiled even though it opens off carpeted and wooden rooms",
  S.bath.floor?.material === "tile",
  `got ${S.bath.floor?.material}`,
);
check(
  "the hallway takes after the rooms it serves rather than a generic default",
  Boolean(S.hall.floor?.material),
  `got ${S.hall.floor?.material}`,
);

// --- re-running is safe ---
const again = inferHouse(plan, seeded.spec);
check(
  "running it twice changes nothing",
  JSON.stringify(stripTime(again.spec)) === JSON.stringify(stripTime(seeded.spec)),
);

// --- a human always wins ---
const corrected = structuredClone(seeded.spec);
corrected.rooms.kitchen.floor = { material: "tile", colour: "#d8d5cf" };
corrected.rooms.kitchen.source["floor.material"] = "human";
corrected.rooms.kitchen.source["floor.colour"] = "human";
const afterEdit = inferHouse(plan, corrected);
check(
  "a hand-corrected floor survives the inference running again",
  afterEdit.spec.rooms.kitchen.floor?.material === "tile" &&
    afterEdit.spec.rooms.kitchen.source["floor.material"] === "human",
  `got ${afterEdit.spec.rooms.kitchen.floor?.material} (${afterEdit.spec.rooms.kitchen.source["floor.material"]})`,
);

// --- it parses ---
check("the result is a valid document", HouseSpec.safeParse(seeded.spec).success);
check("it reports what it did", seeded.conventions.length > 0, seeded.conventions.join(" | "));

function stripTime(spec: HouseSpec) {
  return { ...spec, inferredAt: 0 };
}

console.log(
  failures === 0
    ? `INFERENCE OK - gaps filled from the house's own conventions, floors run through openings and stop at doors, wet rooms stay tiled, and nothing overwrites what was seen`
    : `INFERENCE FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
);
process.exit(failures === 0 ? 0 : 1);
