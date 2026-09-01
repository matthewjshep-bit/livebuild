/**
 * The buttons say the same thing the sentence did.
 *
 * The description box is being replaced by controls, and the shape it produced
 * is load-bearing in two places nobody would guess from looking at it: it
 * becomes the vocabulary the photo classifier is allowed to choose from, and it
 * becomes the room inventory the whole layout is packed from. So the test is
 * not "does the sheet produce a sensible house" but "does it produce the same
 * house the parser did" - checked against the parser itself rather than against
 * a list written out here, so the two cannot drift without this failing.
 */
import { describeToSpec } from "../src/lib/plan/describe";
import {
  EMPTY_SHEET,
  type HouseSheet,
  factsWorthUsing,
  sheetFromFacts,
  sheetToSpec,
} from "../src/lib/plan/house-sheet";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const roomsOf = (spec: { rooms: Array<{ label: string; level: number }> }) =>
  spec.rooms.map((r) => `${r.label}@${r.level}`).sort();

const sheet = (over: Partial<HouseSheet> = {}): HouseSheet => ({ ...EMPTY_SHEET, ...over });

// --- the same house, both ways ---
for (const [text, state] of [
  ["3 bed 2 bath, primary bedroom", sheet({ beds: 3, baths: 2 })],
  ["4 bed 2.5 bath, primary bedroom", sheet({ beds: 4, baths: 2.5 })],
  ["2 bed 1 bath, primary bedroom", sheet({ beds: 2, baths: 1 })],
  ["5 bed 3 bath two storey, primary bedroom", sheet({ beds: 5, baths: 3, storeys: 2 })],
  ["3 bed 2 bath", sheet({ beds: 3, baths: 2, hasPrimary: false })],
] as const) {
  const fromText = describeToSpec(text);
  const fromButtons = sheetToSpec(state);
  check(`"${text}" gives the same rooms`,
    roomsOf(fromText).join(" ") === roomsOf(fromButtons).join(" "),
    `\n      text:    ${roomsOf(fromText).join(" ")}\n      buttons: ${roomsOf(fromButtons).join(" ")}`);
}

// --- the rooms nobody mentions ---
{
  const spec = sheetToSpec(sheet({ beds: 3, baths: 2 }));
  const labels = spec.rooms.map((r) => r.label);
  for (const assumed of ["Kitchen", "Living Room", "Hallway"]) {
    check(`a house comes with a ${assumed.toLowerCase()}`, labels.includes(assumed), labels.join(", "));
  }
  // The parser added these silently; here they can be taken away again.
  const without = sheetToSpec(sheet({ beds: 3, baths: 2, removed: ["Living Room"] }));
  check("and it can be removed", !without.rooms.some((r) => r.label === "Living Room"),
    without.rooms.map((r) => r.label).join(", "));
  check("without taking the others with it",
    without.rooms.some((r) => r.label === "Kitchen"));
}

// --- half a bathroom is a powder room, not a rounding error ---
{
  const spec = sheetToSpec(sheet({ beds: 3, baths: 2.5 }));
  const labels = spec.rooms.map((r) => r.label);
  // Two full baths, and with a primary bedroom the first of them is its ensuite.
  check("2.5 bath gives two full baths",
    labels.filter((l) => /^Bathroom/.test(l) || l === "Primary Ensuite").length === 2,
    labels.join(", "));
  check("and a powder room", labels.includes("Powder Room"), labels.join(", "));
  const whole = sheetToSpec(sheet({ beds: 3, baths: 2 }));
  check("2 bath gives no powder room",
    !whole.rooms.some((r) => r.label === "Powder Room"));
}

// --- storeys put the sleeping upstairs and add the stairs ---
{
  const spec = sheetToSpec(sheet({ beds: 3, baths: 2, storeys: 2 }));
  const bedrooms = spec.rooms.filter((r) => /Bedroom/.test(r.label));
  check("bedrooms go upstairs", bedrooms.every((r) => r.level === 1),
    bedrooms.map((r) => `${r.label}@${r.level}`).join(", "));
  const stairs = spec.rooms.filter((r) => r.label === "Stairs");
  check("stairs are on both floors", stairs.length === 2 &&
    stairs.some((r) => r.level === 0) && stairs.some((r) => r.level === 1),
    stairs.map((r) => r.level).join(","));
  check("and there is a landing", spec.rooms.some((r) => r.label === "Hallway" && r.level === 1));
}

// --- a basement is its own floor, reachable ---
{
  const spec = sheetToSpec(sheet({ beds: 3, baths: 2, hasBasement: true }));
  check("a basement exists", spec.rooms.some((r) => r.label === "Basement" && r.level === -1));
  check("with stairs down to it",
    spec.rooms.some((r) => r.label === "Stairs" && r.level === -1) &&
      spec.rooms.some((r) => r.label === "Stairs" && r.level === 0));
}

// --- extras arrive where they were put ---
{
  const spec = sheetToSpec(sheet({
    beds: 2, baths: 1,
    extras: [{ label: "Office", level: 0 }, { label: "Bonus Room", level: 1 }],
    storeys: 2,
  }));
  check("an extra room is added", spec.rooms.some((r) => r.label === "Office" && r.level === 0));
  check("on the floor it was put on",
    spec.rooms.some((r) => r.label === "Bonus Room" && r.level === 1));
  check("and nothing is duplicated",
    new Set(spec.rooms.map((r) => `${r.label}@${r.level}`)).size === spec.rooms.length);
}

// --- a listing fills the sheet in, without going through a sentence ---
{
  const facts = { beds: 4, baths: 3, sqft: 2883, yearBuilt: 1960, stories: null };
  const filled = sheetFromFacts(facts);
  check("beds come from the listing", filled.beds === 4, `${filled.beds}`);
  check("baths too", filled.baths === 3, `${filled.baths}`);
  check("and the floor area", filled.sqft === 2883, `${filled.sqft}`);
  check("a survey beats the listing on storeys", sheetFromFacts(facts, 2).storeys === 2);
  check("a listing with nothing in it is not worth using",
    !factsWorthUsing({ beds: null, baths: null, sqft: null, yearBuilt: null, stories: null }));
  check("one with a bed count is", factsWorthUsing(facts));
}

// --- nothing chosen still builds a house ---
{
  const spec = sheetToSpec(sheet({ beds: 0, baths: 0 }));
  check("an empty sheet still has somewhere to stand", spec.rooms.length >= 3,
    spec.rooms.map((r) => r.label).join(", "));
  check("and says what it assumed", spec.notes.length > 0, JSON.stringify(spec.notes));
}

if (failures > 0) {
  console.error(`\nHOUSE SHEET: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  "HOUSE SHEET OK - the buttons produce the same rooms the sentence did, the assumed kitchen and hallway are visible and removable, half a bathroom is a powder room, storeys put the bedrooms up and the stairs on both floors, and a listing fills it in without going through prose",
);
