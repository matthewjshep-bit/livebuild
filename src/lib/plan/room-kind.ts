/**
 * What kind of room a label refers to.
 *
 * Room names reach this app from four places that have never agreed: the
 * presets say "Hallway", a sketch says "Hall", a listing says "Bath", and a
 * person types whatever they like. Every feature that cares what a room *is*
 * has so far invented its own way of coping, and there are now three of them -
 * prefix matching in `typicalSize`, a `/stair/i` regex, and the `NON_LIVING`
 * regex - spread over six call sites.
 *
 * That has cost three separate bugs, most recently a corridor rendered twelve
 * feet deep because an exact lookup missed "Hall" and silently fell back to a
 * generic room. The failure always looks like a bug in the feature rather than
 * in the lookup, which is what makes it expensive to find.
 *
 * Floor materials, windows and furniture would each have added a fourth scheme.
 * So: one resolver, one vocabulary, and everything keys off it.
 */

export type RoomKind =
  | "living"
  | "kitchen"
  | "dining"
  | "bedroom"
  | "primary-bedroom"
  | "bathroom"
  | "powder"
  | "hallway"
  | "stairs"
  | "entry"
  | "office"
  | "laundry"
  | "garage"
  | "closet"
  | "basement"
  | "outside"
  | "other";

/**
 * Patterns per kind, longest match winning.
 *
 * Order within a kind does not matter; length does. "primarybedroom" must beat
 * "bedroom", or a primary suite is treated as a spare room - which is exactly
 * the mistake the old prefix matcher was written to avoid, and worth preserving
 * explicitly rather than by accident.
 */
const PATTERNS: Array<[RoomKind, string[]]> = [
  ["primary-bedroom", ["primarybedroom", "masterbedroom", "mainbedroom", "primarysuite", "mastersuite"]],
  ["bedroom", ["bedroom", "bed", "guestroom", "nursery"]],
  // An ensuite is a bathroom, whatever it is attached to. Listing it under
  // primary-bedroom would have made "Primary Ensuite" render as a bedroom -
  // carpet, a bed, and no plumbing.
  ["bathroom", ["bathroom", "bath", "ensuite", "shower", "washroom"]],
  ["powder", ["powderroom", "powder", "halfbath", "wc", "toilet"]],
  ["living", ["livingroom", "living", "familyroom", "family", "lounge", "greatroom", "den", "sittingroom"]],
  ["kitchen", ["kitchen", "kitchenette", "galley"]],
  ["dining", ["diningroom", "dining", "breakfastroom", "nook"]],
  ["hallway", ["hallway", "hall", "corridor", "landing", "passage"]],
  ["stairs", ["stairs", "staircase", "stairwell", "stairway"]],
  ["entry", ["entry", "entrance", "foyer", "porch", "vestibule", "mudroom"]],
  ["office", ["office", "study", "library", "bonusroom", "bonus"]],
  ["laundry", ["laundry", "utility", "utilityroom"]],
  ["garage", ["garage", "carport"]],
  ["closet", ["closet", "walkin", "walkincloset", "pantry", "wardrobe", "storage"]],
  ["basement", ["basement", "cellar", "lowerlevel"]],
  ["outside", ["outside", "deck", "patio", "yard", "garden", "backyard", "balcony", "terrace"]],
];

function normalise(label: string): string {
  return label.toLowerCase().replace(/[^a-z]/g, "");
}

export function roomKind(label: string): RoomKind {
  const key = normalise(label);
  if (!key) return "other";

  let best: RoomKind = "other";
  let bestLength = 0;

  for (const [kind, patterns] of PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.length <= bestLength) continue;

      // Three ways to match, in decreasing safety:
      //
      //   prefix either way  - "bed" against "Bedroom 2", or the reverse
      //   contained anywhere - "Unfinished Basement", "Back Deck", where the
      //                        word naming the kind is not the first one
      //
      // Containment is restricted to patterns of four characters or more.
      // Below that it starts matching the insides of unrelated words, and a
      // wrong kind is worse than a generic one: it renders the room with the
      // wrong floor and the wrong furniture rather than merely a plain one.
      const matches =
        key.startsWith(pattern) ||
        pattern.startsWith(key) ||
        (pattern.length >= 4 && key.includes(pattern));

      if (matches) {
        best = kind;
        bestLength = pattern.length;
      }
    }
  }

  return best;
}

/** Rooms a listing's "living area" excludes. */
export function isLivingArea(label: string): boolean {
  const kind = roomKind(label);
  return kind !== "garage" && kind !== "outside";
}

/** Rooms that connect storeys. */
export function isStairs(label: string): boolean {
  return roomKind(label) === "stairs";
}

/**
 * Rooms nobody photographs but everybody walks through.
 *
 * Used by the walk graph to decide what counts as a way through rather than a
 * destination.
 */
export function isCirculation(label: string): boolean {
  const kind = roomKind(label);
  return kind === "hallway" || kind === "stairs" || kind === "entry";
}
