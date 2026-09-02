import { ROOM_PRESETS } from "@/lib/plan/autolayout";

/**
 * Turn a plain-English description of a house into a room list.
 *
 * Deliberately deterministic and offline. Real descriptions are far more
 * structured than they look - "3 bed 2 bath, open plan kitchen and living,
 * primary has an ensuite, two-car garage" is almost a data format - so a parser
 * handles the common case instantly, for free, with no key and no network.
 *
 * An optional Claude pass (see /api/describe) handles genuine prose that this
 * cannot, and returns the same shape. This is the fallback whenever that is
 * unavailable, so the feature never simply stops working.
 */

export type HouseSpec = {
  /** Rooms in the order a person would walk them, each with a storey. */
  rooms: Array<{ label: string; level: number }>;
  /** What was understood, shown back so a wrong reading is visible immediately. */
  notes: string[];
  source: "parsed" | "ai";
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function toNumber(raw: string): number | null {
  const word = NUMBER_WORDS[raw.toLowerCase()];
  if (word !== undefined) return word;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

const COUNT = `(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join("|")})`;

function firstCount(text: string, unit: string): number | null {
  // Tolerates "3 bed", "three bedrooms", "3br", "3-bed".
  const match = new RegExp(`${COUNT}\\s*[-\\s]?\\s*(?:${unit})`, "i").exec(text);
  return match ? toNumber(match[1]) : null;
}

/** Rooms recognised by name, mapped to the label the rest of the app uses. */
const NAMED_ROOMS: Array<[RegExp, string]> = [
  [/\b(?:living|lounge|great)\s*room\b|\bliving\b/i, "Living Room"],
  [/\bfamily\s*room\b|\bden\b/i, "Family Room"],
  [/\bkitchen\b/i, "Kitchen"],
  [/\bdining\b/i, "Dining Room"],
  [/\b(?:office|study)\b/i, "Office"],
  [/\blaundry\b|\bmud\s*room\b|\butility\b/i, "Laundry"],
  [/\b(?:entry|foyer|entrance|hall\s*way)\b/i, "Entry"],
  [/\bpantry\b/i, "Pantry"],
  [/\bsun\s*room\b|\bconservatory\b/i, "Sunroom"],
  [/\b(?:deck|patio|porch|yard|garden|backyard)\b/i, "Outside"],
  [/\bbonus\s*room\b|\bloft\b/i, "Bonus Room"],
  [/\bcloset\b|\bwalk[-\s]?in\b/i, "Closet"],
  [/\battic\b/i, "Attic"],
];

const UPSTAIRS = /\b(?:two|2|three|3)[-\s]?(?:stor(?:e?y|ies)|level|floor)|\bsecond\s+floor\b|\bupstairs\b|\bfirst\s+floor\s+and\s+second\b|\btwo\s+levels\b/i;
const BASEMENT = /\bbasement\b|\bcellar\b|\blower\s+level\b/i;
const PRIMARY = /\b(?:primary|master|main)\s*(?:bed|suite|bedroom)/i;
const ENSUITE = /\bensuite\b|\ben[-\s]suite\b|\battached\s+bath/i;

/**
 * Storey assignment for a two-storey house.
 *
 * Sleeping upstairs and living downstairs is the overwhelmingly common US
 * layout, so it is the right default - and being wrong here costs one drag in
 * the builder, whereas making the user assign every room costs them every time.
 */
function levelFor(label: string, storeys: number): number {
  if (storeys < 2) return 0;
  if (/^Bedroom|^Primary/.test(label)) return 1;
  if (label === "Bathroom" || /^Bathroom \d/.test(label) || label === "Primary Ensuite") return 1;
  if (label === "Bonus Room" || label === "Attic") return 1;
  return 0;
}

export function describeToSpec(text: string): HouseSpec {
  const notes: string[] = [];
  const rooms: Array<{ label: string; level: number }> = [];
  const seen = new Set<string>();

  const add = (label: string, level: number) => {
    const key = `${label}@${level}`;
    if (seen.has(key)) return;
    seen.add(key);
    rooms.push({ label, level });
  };

  const hasUpstairs = UPSTAIRS.test(text);
  const hasBasement = BASEMENT.test(text);
  const storeys = hasUpstairs ? 2 : 1;

  // --- bedrooms ---
  const bedCount = firstCount(text, "bed(?:room)?s?|bd|br") ?? 0;
  const hasPrimary = PRIMARY.test(text);
  if (bedCount > 0) {
    const whole = Math.max(1, Math.round(bedCount));
    for (let i = 0; i < whole; i++) {
      const label =
        hasPrimary && i === 0 ? "Primary Bedroom" : `Bedroom ${hasPrimary ? i + 1 : i + 1}`;
      add(label, levelFor(label, storeys));
    }
    notes.push(
      `${whole} bedroom${whole === 1 ? "" : "s"}${hasPrimary ? ", one of them primary" : ""}`,
    );
  }

  // --- bathrooms, including halves ---
  const bathCount = firstCount(text, "bath(?:room)?s?|ba") ?? 0;
  if (bathCount > 0) {
    const full = Math.floor(bathCount);
    // "2.5 bath" means two full and one without a shower.
    const half = bathCount - full >= 0.4 ? 1 : 0;
    const ensuite = ENSUITE.test(text) || hasPrimary;

    for (let i = 0; i < full; i++) {
      const label =
        ensuite && i === 0
          ? "Primary Ensuite"
          : full - (ensuite ? 1 : 0) > 1
            ? `Bathroom ${i + (ensuite ? 0 : 1)}`
            : "Bathroom";
      add(label, levelFor(label, storeys));
    }
    if (half) add("Powder Room", 0);

    notes.push(
      `${full} full bath${full === 1 ? "" : "s"}${half ? " and a powder room" : ""}` +
        `${ensuite ? ", one an ensuite" : ""}`,
    );
  }

  // --- rooms mentioned by name ---
  for (const [pattern, label] of NAMED_ROOMS) {
    if (pattern.test(text)) add(label, levelFor(label, storeys));
  }

  // --- garage ---
  if (/\bgarage\b|\bcarport\b/i.test(text)) {
    const cars = firstCount(text, "car");
    add("Garage", 0);
    notes.push(cars ? `${cars}-car garage` : "a garage");
  }

  // --- rooms nobody bothers to mention but every house has ---
  // A description is a summary, not an inventory: "3 bed 2 bath" implies a
  // kitchen. Adding them is far less annoying than a plan with no kitchen.
  add("Kitchen", 0);
  add("Living Room", 0);

  // A hallway is what actually joins the rooms, and is the one room people
  // never think to mention. It needs no photos to do its job.
  add("Hallway", 0);
  if (storeys > 1) add("Hallway", 1);

  if (storeys > 1) {
    add("Stairs", 0);
    add("Stairs", 1);
    notes.push("two storeys, with stairs joining them");
  }

  if (hasBasement) {
    add("Basement", -1);
    add("Stairs", -1);
    add("Stairs", 0);
    notes.push("a basement");
  }

  if (notes.length === 0) {
    notes.push("nothing specific recognised - a simple one-storey layout");
  }

  return { rooms, notes, source: "parsed" };
}

/**
 * Room options for the tagging step, ordered by what the description implies.
 *
 * This is the point of parsing the description at all: after "3 bed 2 bath" the
 * buttons should read Primary Bedroom / Bedroom 2 / Bedroom 3, not a generic
 * "Bedroom" that cannot tell them apart. Presets stay on the end so a room the
 * description missed is still one tap away.
 */
export function roomOptionsFor(spec: HouseSpec | null): string[] {
  if (!spec) return ROOM_PRESETS;
  const fromSpec: string[] = [];
  for (const room of spec.rooms) {
    if (!fromSpec.includes(room.label)) fromSpec.push(room.label);
  }
  return [...fromSpec, ...ROOM_PRESETS.filter((preset) => !fromSpec.includes(preset))];
}
