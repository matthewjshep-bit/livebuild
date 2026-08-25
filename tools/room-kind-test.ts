/**
 * Every name the app can produce resolves to the right kind.
 *
 * This is the lookup that three separate bugs have already come from, each
 * looking like a bug in the feature that called it. The cases below are the
 * actual vocabularies in play: the presets, what a sketch reader writes, what a
 * listing calls things, and what the describe parser generates.
 */
import { isLivingArea, isStairs, roomKind } from "../src/lib/plan/room-kind";
import { ROOM_PRESETS } from "../src/lib/plan/autolayout";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const cases: Array<[string, string]> = [
  // Presets
  ["Living Room", "living"],
  ["Kitchen", "kitchen"],
  ["Dining Room", "dining"],
  ["Primary Bedroom", "primary-bedroom"],
  ["Bedroom", "bedroom"],
  ["Bathroom", "bathroom"],
  ["Hallway", "hallway"],
  ["Stairs", "stairs"],
  ["Garage", "garage"],
  ["Outside", "outside"],

  // What a sketch reader writes — the shorthand that caused the twelve-foot
  // corridor when it missed.
  ["Hall", "hallway"],
  ["Bath", "bathroom"],
  ["Dining", "dining"],
  ["Bed", "bedroom"],
  ["Living", "living"],

  // What the describe parser generates
  ["Bedroom 2", "bedroom"],
  ["Bedroom 3", "bedroom"],
  ["Bathroom 1", "bathroom"],
  // An ensuite is a bathroom, whatever it adjoins.
  ["Primary Ensuite", "bathroom"],
  ["Powder Room", "powder"],

  // What people and listings actually say
  ["Master Bedroom", "primary-bedroom"],
  ["Master Suite", "primary-bedroom"],
  ["Family Room", "living"],
  ["Den", "living"],
  ["Foyer", "entry"],
  ["Mudroom", "entry"],
  ["Walk-In Closet", "closet"],
  ["Unfinished Basement", "basement"],
  ["Back Deck", "outside"],
  ["Utility Room", "laundry"],
  ["Study", "office"],

  // Nothing recognisable
  ["Snug", "other"],
  ["", "other"],
];

for (const [label, expected] of cases) {
  const got = roomKind(label);
  check(`"${label}" is ${expected}`, got === expected, `got ${got}`);
}

// The specific mistake the longest-match rule exists to prevent.
check(
  "a primary bedroom is not answered by 'bedroom'",
  roomKind("Primary Bedroom") !== roomKind("Bedroom 2"),
);

// Every preset must resolve to something, or a room the app itself offers would
// fall through to generic handling.
for (const preset of ROOM_PRESETS) {
  check(`preset "${preset}" resolves`, roomKind(preset) !== "other", `got other`);
}

// The two derived helpers, which replace regexes scattered across the codebase.
check("a garage is not living area", !isLivingArea("Garage"));
check("a deck is not living area", !isLivingArea("Back Deck"));
check("a bedroom is living area", isLivingArea("Bedroom 2"));
check("stairs are recognised", isStairs("Stairs") && isStairs("Stairwell"));
check("a hallway is not stairs", !isStairs("Hallway"));

console.log(
  failures === 0
    ? `ROOM KIND OK - ${cases.length} labels from four different vocabularies resolve correctly`
    : `ROOM KIND BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
