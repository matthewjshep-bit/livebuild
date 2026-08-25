/**
 * Does a hand-drawn plan survive the trip into a walkable one?
 *
 * Runs on a recorded reading of `public/fixtures/sketch-floorplan.jpg` so it is
 * deterministic and free. What it tests is the part that can silently go wrong:
 * a model's coordinates are approximate, and rooms that were drawn sharing a
 * wall come back a few units apart. Since doorways are derived from adjacency,
 * "a few units apart" means a house nobody can walk through.
 *
 * Re-record the reading with `node tools/sketch-live-test.mjs` after changing
 * the prompt.
 */
import { readFileSync } from "node:fs";

import { sketchToPlan } from "../src/lib/plan/sketch";
import { area } from "../src/lib/plan/geometry";
import { M_PER_FT } from "../src/lib/units";

const reading = JSON.parse(readFileSync("public/fixtures/sketch-floorplan.reading.json", "utf8"));
const truth = JSON.parse(readFileSync("public/fixtures/sketch-floorplan.truth.json", "utf8"));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const { rooms, openings, scale, adjustments } = sketchToPlan(reading);

check("every drawn room survives", rooms.length === truth.rooms.length,
  `${rooms.length} of ${truth.rooms.length}`);

// Adjacency is the load-bearing property: it is what becomes doorways.
const connects = (a: string, b: string) =>
  openings.some((o) => {
    const labels = o.between.map((id) => rooms.find((r) => r.id === id)?.label ?? "");
    return labels.some((l) => l.includes(a)) && labels.some((l) => l.includes(b));
  });

for (const [a, b] of truth.adjacent as Array<[string, string]>) {
  check(`${a} connects to ${b}`, connects(a, b));
}

// Every room reachable from every other.
{
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
  check("the whole plan is walkable", seen.size === rooms.length, `${seen.size}/${rooms.length}`);
}

// Written dimensions set the scale.
//
// Asserted in aggregate, because that is what the code promises: scale is
// derived from every dimensioned room at once, so a single sloppy rectangle
// cannot set the size of the house. The cost is that no one room lands exactly
// on its written figure — the fixture's Living Room comes out 197 sqft against
// a written 224 — and that trade is deliberate.
{
  const written: Record<string, number> = {
    "Living Room": 16 * 14,
    Kitchen: 12 * 11,
    Bedroom: 12 * 12,
  };

  let wantTotal = 0;
  let gotTotal = 0;
  for (const [name, sqft] of Object.entries(written)) {
    const room = rooms.find((r) => r.label.includes(name.split(" ")[0]));
    if (!room) {
      failures++;
      console.log(`  FAIL no room matching ${name}`);
      continue;
    }
    const actual = area(room.polygon) / (M_PER_FT * M_PER_FT);
    wantTotal += sqft;
    gotTotal += actual;
    // Each room should at least be in the right ballpark.
    check(`${name} is roughly its written size`, Math.abs(actual - sqft) / sqft < 0.25,
      `${Math.round(actual)} sqft against a written ${sqft}`);
  }

  check("dimensioned rooms total their written area", Math.abs(gotTotal - wantTotal) / wantTotal < 0.15,
    `${Math.round(gotTotal)} sqft against ${wantTotal}`);
}

// The point of the exercise: rooms come out plausible for what they are, not
// whatever the pen happened to do. A corridor is the sharpest test — drawn as a
// wide band, it must still end up narrow.
{
  const hall = rooms.find((r) => /hall/i.test(r.label));
  if (!hall) {
    failures++;
    console.log("  FAIL no Hall in the plan");
  } else {
    const ys = hall.polygon.map((p) => p[1]);
    const depthFt = (Math.max(...ys) - Math.min(...ys)) / M_PER_FT;
    check("a hallway comes out narrow", depthFt < 7,
      `Hall is ${depthFt.toFixed(1)} ft deep — a corridor, not a room`);
  }

  // Every wall on a clean increment, so nothing looks hand-wobbled.
  const off = rooms.flatMap((r) => r.polygon.flat())
    .filter((v) => Math.abs(v / (M_PER_FT / 2) - Math.round(v / (M_PER_FT / 2))) > 0.01);
  check("walls land on 6in increments", off.length === 0, `${off.length} stray coordinates`);

  check("it reports what it changed", adjustments.length >= 2);
}

// Sanity: a house, not a doll's house or a stadium.
{
  const total = rooms.reduce((s, r) => s + area(r.polygon), 0) / (M_PER_FT * M_PER_FT);
  check("total area is house-sized", total > 600 && total < 4000, `${Math.round(total)} sqft`);
}

// --- a badly proportioned drawing, which is the normal case ---
//
// The point of solving dimensions rather than tracing them: what the pen did is
// noise. A room drawn huge because that is where the hand stopped should not
// come out huge. Adjacency must survive intact regardless.
{
  const messy = {
    gridWidth: 1000,
    gridHeight: 800,
    notes: [],
    rooms: [
      { label: "Bath", x: 0, y: 0, width: 620, height: 380, level: 0, writtenFeet: null },
      { label: "Living Room", x: 620, y: 0, width: 380, height: 380, level: 0, writtenFeet: null },
      { label: "Hallway", x: 0, y: 380, width: 1000, height: 210, level: 0, writtenFeet: null },
      { label: "Bedroom", x: 0, y: 590, width: 500, height: 210, level: 0, writtenFeet: null },
      { label: "Kitchen", x: 500, y: 590, width: 500, height: 210, level: 0, writtenFeet: null },
    ],
  };

  const solved = sketchToPlan(messy);
  const sizeOf = (label: string) => {
    const room = solved.rooms.find((r) => r.label === label)!;
    const xs = room.polygon.map((p) => p[0]);
    const ys = room.polygon.map((p) => p[1]);
    return {
      w: (Math.max(...xs) - Math.min(...xs)) / M_PER_FT,
      h: (Math.max(...ys) - Math.min(...ys)) / M_PER_FT,
    };
  };

  // Drawn as a band a quarter of the page deep; must still be a corridor.
  const hall = sizeOf("Hallway");
  check("a fat hallway is narrowed to a corridor", hall.h < 6,
    `${hall.h.toFixed(1)} ft deep`);

  // Drawn at 29% of the page against the living room's 18%; the absurdity
  // should at least be reduced, even though the grid limits how far.
  const bath = sizeOf("Bath");
  const living = sizeOf("Living Room");
  check("an oversized bathroom is brought back", bath.w * bath.h <= living.w * living.h * 1.2,
    `Bath ${Math.round(bath.w * bath.h)} sqft vs Living Room ${Math.round(living.w * living.h)}`);

  check("adjacency survives being resized", solved.openings.length >= 5,
    `${solved.openings.length} doorways`);
}

console.log(
  failures === 0
    ? `SKETCH OK - ${rooms.length} rooms, ${openings.length} doorways, all reachable ` +
      `(scale ${(scale / M_PER_FT).toFixed(2)} ft per unit)`
    : `SKETCH BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
