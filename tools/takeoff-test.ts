/**
 * Quantities derived from the model are internally consistent.
 *
 * These are the numbers every cost in the BOM is multiplied by, so an error
 * here is invisible and expensive: a wall area that forgot its windows inflates
 * every paint line in the house by a few percent and nothing looks wrong.
 */
import { readFileSync } from "node:fs";

import { livingAreaSqft, takeoffForPlan } from "../src/lib/bom/takeoff";
import { autoOpenings } from "../src/lib/plan/autolayout";
import { area } from "../src/lib/plan/geometry";
import { parseProperty } from "../src/lib/schema";
import type { Plan } from "../src/lib/schema";
import { M_PER_FT } from "../src/lib/units";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// Through the schema, not raw JSON: the demo house predates `level` and relies
// on the default, and reading it raw once made a whole suite test nothing.
const load = (path: string): Plan => {
  const doc = parseProperty(JSON.parse(readFileSync(path, "utf8")));
  const openings = doc.plan.openings.length ? doc.plan.openings : autoOpenings(doc.plan.rooms);
  return { ...doc.plan, openings };
};

for (const [name, path] of [
  ["demo house", "public/properties/demo-house/property.json"],
  ["two-storey", "public/properties/two-storey/property.json"],
] as Array<[string, string]>) {
  const plan = load(path);
  const takeoff = takeoffForPlan(plan);

  check(`${name}: every room is measured`, takeoff.length === plan.rooms.length);

  for (const room of takeoff) {
    const source = plan.rooms.find((r) => r.id === room.roomId)!;
    const expectedSqft = area(source.polygon) / (M_PER_FT * M_PER_FT);

    check(
      `${name}/${room.label}: floor matches the polygon`,
      Math.abs(room.floorSqft - expectedSqft) < 0.5,
      `${room.floorSqft.toFixed(1)} against ${expectedSqft.toFixed(1)}`,
    );

    // Openings can only remove wall.
    check(
      `${name}/${room.label}: net wall is at most gross`,
      room.wallSqft <= room.wallGrossSqft + 0.01,
      `${room.wallSqft.toFixed(1)} net against ${room.wallGrossSqft.toFixed(1)} gross`,
    );
    check(`${name}/${room.label}: wall area is positive`, room.wallSqft > 0);

    // A doorway takes wall out; a room with one must show it.
    if (room.doorCount > 0) {
      check(
        `${name}/${room.label}: doors reduce the wall area`,
        room.wallSqft < room.wallGrossSqft,
        "net equals gross despite having doors",
      );
      check(
        `${name}/${room.label}: skirting is shorter than the perimeter`,
        room.baseboardLf < room.perimeterLf,
        `${room.baseboardLf.toFixed(1)}ft against ${room.perimeterLf.toFixed(1)}ft`,
      );
    }

    check(
      `${name}/${room.label}: skirting never exceeds the perimeter`,
      room.baseboardLf <= room.perimeterLf + 0.01,
    );
    check(`${name}/${room.label}: cabinet run is positive`, room.cabinetRunLf > 0);
    check(
      `${name}/${room.label}: cabinet run is under the perimeter`,
      room.cabinetRunLf < room.perimeterLf,
    );

    const expectedDoors = plan.openings.filter(
      (o) => o.kind !== "stairs" && o.between.includes(room.roomId),
    ).length;
    check(
      `${name}/${room.label}: door count matches the plan`,
      room.doorCount === expectedDoors,
      `${room.doorCount} against ${expectedDoors}`,
    );
  }

  // Living area excludes the garage, the same way a listing's does.
  const total = takeoff.reduce((s, r) => s + r.floorSqft, 0);
  const living = livingAreaSqft(plan);
  check(`${name}: living area is at most the total`, living <= total + 0.01);
  check(`${name}: living area is house-sized`, living > 200 && living < 8000,
    `${Math.round(living)} sqft`);
}

// A garage really is excluded, rather than merely usually absent.
{
  const plan: Plan = {
    scaleRef: { px: 1, meters: M_PER_FT },
    openings: [],
    rooms: [
      { id: "a", label: "Living Room", polygon: [[0, 0], [5, 0], [5, 4], [0, 4]], ceilingHeight: 2.7, level: 0 },
      { id: "b", label: "Garage", polygon: [[5, 0], [11, 0], [11, 6], [5, 6]], ceilingHeight: 2.7, level: 0 },
    ],
  };
  const all = takeoffForPlan(plan).reduce((s, r) => s + r.floorSqft, 0);
  check("a garage is left out of living area", livingAreaSqft(plan) < all * 0.6,
    `${livingAreaSqft(plan).toFixed(0)} of ${all.toFixed(0)}`);
}

console.log(
  failures === 0
    ? "TAKEOFF OK - quantities derive from the model and hold together"
    : `TAKEOFF BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
