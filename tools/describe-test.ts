/**
 * Does the parser read house descriptions the way a person means them?
 *
 * These are the phrasings a listing agent actually types. The parser is the
 * default path - the AI pass is an upgrade, not a crutch - so it has to hold up
 * on its own.
 */
import { layoutFromSpec, scaleToLivingArea } from "../src/lib/plan/autolayout";
import { describeToSpec, roomOptionsFor } from "../src/lib/plan/describe";

const cases: Array<{ text: string; expect: (labels: string[], levels: number[]) => string | null }> = [
  {
    text: "3 bed, 2 bath single storey with an open plan kitchen and living room, plus a 2 car garage",
    expect: (l, lv) => {
      if (l.filter((x) => /Bedroom/.test(x)).length !== 3) return "wanted 3 bedrooms";
      if (!l.includes("Garage")) return "wanted a garage";
      if (new Set(lv).size !== 1) return "single storey should stay on one level";
      return null;
    },
  },
  {
    text: "Two storey 4 bedroom 2.5 bath. Primary bedroom upstairs with an ensuite. Dining room, office and laundry downstairs.",
    expect: (l, lv) => {
      if (!l.includes("Primary Bedroom")) return "wanted a Primary Bedroom";
      if (!l.includes("Primary Ensuite")) return "wanted an ensuite";
      if (!l.includes("Powder Room")) return "2.5 baths should give a powder room";
      if (!l.includes("Stairs")) return "two storeys need stairs";
      if (!lv.includes(1)) return "wanted an upstairs";
      if (!l.includes("Dining Room") || !l.includes("Office") || !l.includes("Laundry"))
        return "missed a named room";
      return null;
    },
  },
  {
    text: "Small 2 bed 1 bath cottage with a kitchen, living room and a back deck",
    expect: (l) => {
      if (l.filter((x) => /Bedroom/.test(x)).length !== 2) return "wanted 2 bedrooms";
      if (!l.includes("Outside")) return "a deck should become Outside";
      if (l.includes("Powder Room")) return "1 bath should not add a powder room";
      return null;
    },
  },
  {
    text: "three bedroom two bathroom ranch with a finished basement",
    expect: (l, lv) => {
      if (l.filter((x) => /Bedroom/.test(x)).length !== 3) return "word numbers should parse";
      if (!lv.includes(-1)) return "wanted a basement level";
      if (!l.includes("Basement")) return "wanted a Basement room";
      return null;
    },
  },
  {
    text: "4br 3ba two-story colonial, master suite with attached bath, 3 car garage",
    expect: (l) => {
      if (l.filter((x) => /Bedroom/.test(x)).length !== 4) return "4br shorthand should parse";
      if (!l.includes("Primary Bedroom")) return "'master suite' should mean primary";
      if (!l.includes("Primary Ensuite")) return "'attached bath' should mean ensuite";
      return null;
    },
  },
  {
    text: "just a nice house",
    expect: (l) => {
      if (!l.includes("Kitchen") || !l.includes("Living Room"))
        return "should still produce a usable minimum";
      return null;
    },
  },
];

let failures = 0;
for (const testCase of cases) {
  const spec = describeToSpec(testCase.text);
  const labels = spec.rooms.map((r) => r.label);
  const levels = spec.rooms.map((r) => r.level);
  const problem = testCase.expect(labels, levels);
  if (problem) {
    failures++;
    console.log(`  FAIL ${problem}`);
    console.log(`       "${testCase.text}"`);
    console.log(`       got: ${labels.join(", ")}`);
  }
}

// The tagging options must lead with what the description implies.
const spec = describeToSpec("3 bed 2 bath, primary suite");
const options = roomOptionsFor(spec);
if (options[0] !== "Primary Bedroom") {
  failures++;
  console.log(`  FAIL tag options should lead with the described rooms, got ${options[0]}`);
}
if (!options.includes("Garage")) {
  failures++;
  console.log("  FAIL presets should still be reachable");
}


// --- the described house must lay out as a connected building ---

function reachable(rooms: Array<{ id: string }>, openings: Array<{ between: [string, string] }>) {
  const adjacency = new Map(rooms.map((r) => [r.id, [] as string[]]));
  for (const o of openings) {
    adjacency.get(o.between[0])?.push(o.between[1]);
    adjacency.get(o.between[1])?.push(o.between[0]);
  }
  const seen = new Set([rooms[0].id]);
  const queue = [rooms[0].id];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.size;
}

const layoutCases = [
  "3 bed 2 bath single storey with a kitchen and living room",
  "Two storey 4 bedroom 2.5 bath, primary suite upstairs with ensuite, 2 car garage",
  "three bedroom two bathroom ranch with a finished basement",
];

for (const text of layoutCases) {
  const { rooms, openings } = layoutFromSpec(describeToSpec(text));
  const reached = reachable(rooms, openings as Array<{ between: [string, string] }>);
  if (reached !== rooms.length) {
    failures++;
    console.log(`  FAIL layout not fully connected (${reached}/${rooms.length}): "${text}"`);
    const stairs = openings.filter((o) => o.kind === "stairs").length;
    console.log(`       ${rooms.length} rooms, ${openings.length} openings, ${stairs} stairs`);
  }
}

console.log(
  failures === 0
    ? `DESCRIBE OK - ${cases.length} descriptions parsed, ${layoutCases.length} laid out connected`
    : `DESCRIBE BROKEN - ${failures} failures`,
);

// --- square footage must actually size the plan ---
//
// This is the accuracy claim the listing import exists for: without it a 900
// sqft cottage and a 3,000 sqft house generate nearly the same dollhouse, and
// every distance inside the tour is wrong by the same factor.
import { area } from "../src/lib/plan/geometry";
import { sqftToM2 } from "../src/lib/units";

const NON_LIVING = /garage|outside|deck|patio|porch|attic|shed|carport/i;
const livingArea = (rooms: Array<{ label: string; polygon: Array<[number, number]> }>) =>
  rooms.filter((r) => !NON_LIVING.test(r.label)).reduce((s, r) => s + area(r.polygon), 0);

for (const [text, targetSqft] of [
  ["3 bed 2 bath with a kitchen, living room and 2 car garage", 1850],
  ["2 bed 1 bath cottage", 900],
  ["Two storey 4 bed 3 bath", 2800],
] as Array<[string, number]>) {
  const { rooms } = layoutFromSpec(describeToSpec(text), sqftToM2(targetSqft));
  const actual = livingArea(rooms) / sqftToM2(1);
  const off = Math.abs(actual - targetSqft) / targetSqft;
  if (off > 0.02) {
    failures++;
    console.log(`  FAIL wanted ~${targetSqft} sqft of living area, got ${Math.round(actual)}`);
    console.log(`       "${text}"`);
  }
}

// A garage must not be counted, or every real room shrinks to make room for it.
{
  const spec = describeToSpec("3 bed 2 bath with a 2 car garage");
  const { rooms } = layoutFromSpec(spec, sqftToM2(1800));
  const garage = rooms.find((r) => /garage/i.test(r.label));
  if (!garage) {
    failures++;
    console.log("  FAIL expected a garage in this plan");
  } else if (Math.abs(livingArea(rooms) / sqftToM2(1) - 1800) / 1800 > 0.02) {
    failures++;
    console.log("  FAIL garage was counted toward living area");
  }
}

// Absurd square footage means the inputs disagree; the plan should be left alone
// rather than scaled into nonsense.
{
  const spec = describeToSpec("3 bed 2 bath");
  const plain = layoutFromSpec(spec).rooms;
  const silly = scaleToLivingArea(plain, sqftToM2(60));
  if (livingArea(silly) !== livingArea(plain)) {
    failures++;
    console.log("  FAIL an implausible sqft should be ignored, not applied");
  }
}

console.log(
  failures === 0
    ? "SIZING OK - plans scale to a listing's square footage, excluding the garage"
    : `SIZING BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
