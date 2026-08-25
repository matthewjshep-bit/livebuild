/**
 * A real building outline becomes a walkable house.
 *
 * The fixtures are genuine OpenStreetMap rings, not clean synthetic shapes,
 * because the whole difficulty is that real data is messy: twenty-five vertices
 * describing an L, a building rotated to its street, and porch steps that no
 * room can express. A test on a tidy rectangle would prove none of it.
 */
import { readFileSync } from "node:fs";
import { autoOpenings, boundsOf } from "../src/lib/plan/autolayout";
import {
  decompose,
  dominantAngle,
  layoutFromFootprint,
  packIntoFootprint,
  prepareFootprint,
  rectArea,
  simplify,
} from "../src/lib/plan/footprint";
import type { Vec2 } from "../src/lib/schema";
import { M_PER_FT } from "../src/lib/units";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

function reachableCount(ids: string[], openings: Array<{ between: [string, string] }>): number {
  if (ids.length === 0) return 0;
  const adjacency = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const o of openings) {
    adjacency.get(o.between[0])?.push(o.between[1]);
    adjacency.get(o.between[1])?.push(o.between[0]);
  }
  const seen = new Set([ids[0]]);
  const queue = [ids[0]];
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

const SQM_PER_SQFT = M_PER_FT * M_PER_FT;

// ---------------------------------------------------------------- primitives

// A square rotated off-axis must be recognised as square, not as whatever angle
// its longest edge happens to sit at.
const tilted: Vec2[] = [
  [0, 0],
  [8.66, 5],
  [3.66, 13.66],
  [-5, 8.66],
];
check("a 30-degree building is detected as 30 degrees", dominantAngle(tilted) === 30,
  `got ${dominantAngle(tilted)}`);

// Douglas-Peucker must drop detail without moving the corners.
const bayWindow: Vec2[] = [
  [0, 0], [10, 0], [10, 4],
  // A bay: four vertices bulging 30cm out of an otherwise straight wall.
  [7.5, 4], [7.4, 4.3], [5.6, 4.3], [5.5, 4],
  [0, 4],
];
const cleaned = simplify(bayWindow, 0.9);
check("a bay window is simplified away", cleaned.length < bayWindow.length,
  `${bayWindow.length} → ${cleaned.length}`);
check("simplifying keeps the corners", cleaned.length >= 4, `got ${cleaned.length}`);

// A plain rectangle must come back as one rectangle, not a grid of cells.
const plainRect: Vec2[] = [[0, 0], [10, 0], [10, 8], [0, 8]];
check("a rectangle decomposes to one rectangle", decompose(plainRect).length === 1,
  `got ${decompose(plainRect).length}`);

// An L must come back as two, and they must cover it exactly.
const ell: Vec2[] = [[0, 0], [12, 0], [12, 6], [6, 6], [6, 12], [0, 12]];
const ellRects = decompose(ell);
const ellArea = ellRects.reduce((s, r) => s + rectArea(r), 0);
check("an L decomposes to two rectangles", ellRects.length === 2, `got ${ellRects.length}`);
check("the pieces cover the L exactly", Math.abs(ellArea - 108) < 0.01, `got ${ellArea}`);

// ------------------------------------------------------------- real outlines

const fixtures: Record<string, { ring: Array<[number, number]>; tags?: Record<string, string> }> =
  JSON.parse(readFileSync("public/fixtures/footprints.json", "utf8"));

check("footprint fixtures are present", Object.keys(fixtures).length >= 2);

const HOUSE_ROOMS = [
  "Living Room", "Kitchen", "Dining Room", "Bedroom",
  "Bedroom 2", "Primary Bedroom", "Bathroom", "Hallway",
];

for (const [name, fixture] of Object.entries(fixtures)) {
  const fp = prepareFootprint(fixture.ring);

  check(`${name}: simplification reduces the outline`,
    fp.vertices.simplified <= fp.vertices.raw,
    `${fp.vertices.raw} → ${fp.vertices.simplified}`);

  check(`${name}: the outline stays rectilinear enough to pack`,
    fp.rects.length >= 1 && fp.rects.length <= 8,
    `got ${fp.rects.length} rectangles`);

  // No sliver survives - a 4 sqft rectangle is not a room and never will be.
  for (const r of fp.rects) {
    check(`${name}: no sliver rectangles`, rectArea(r) / SQM_PER_SQFT >= 25,
      `${Math.round(rectArea(r) / SQM_PER_SQFT)} sqft`);
  }

  const rooms = packIntoFootprint(HOUSE_ROOMS, fp);
  check(`${name}: every room is placed`, rooms.length === HOUSE_ROOMS.length,
    `${rooms.length}/${HOUSE_ROOMS.length}`);

  // The rooms must fill the building. A gap inside the outline is a room
  // nobody can reach, and it is invisible until someone walks the tour.
  const roomArea = rooms.reduce((sum, room) => {
    const b = boundsOf(room.polygon);
    return sum + (b.x1 - b.x0) * (b.y1 - b.y0);
  }, 0);
  const packedArea = fp.rects.reduce((s, r) => s + rectArea(r), 0);
  check(`${name}: rooms fill the footprint`, Math.abs(roomArea - packedArea) < packedArea * 0.02,
    `${Math.round(roomArea)} m² of ${Math.round(packedArea)} m²`);

  // Rooms must not overlap - two rooms in the same place is worse than a gap,
  // because it renders as one room with a wall through it.
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = boundsOf(rooms[i].polygon);
      const b = boundsOf(rooms[j].polygon);
      const overlap =
        a.x0 < b.x1 - 0.05 && b.x0 < a.x1 - 0.05 && a.y0 < b.y1 - 0.05 && b.y0 < a.y1 - 0.05;
      check(`${name}: ${rooms[i].label} does not overlap ${rooms[j].label}`, !overlap);
    }
  }

  // Every room must be inside the building it was packed into.
  const hull = boundsOf(fp.outline);
  for (const room of rooms) {
    const b = boundsOf(room.polygon);
    check(`${name}: ${room.label} is inside the outline`,
      b.x0 >= hull.x0 - 0.05 && b.x1 <= hull.x1 + 0.05 &&
      b.y0 >= hull.y0 - 0.05 && b.y1 <= hull.y1 + 0.05);
  }

  // No room may be a corridor by accident. This is what caught a kitchen
  // packed into a six-foot-wide sliver of the outline - technically a fair
  // share of the floor area, and obviously not a kitchen.
  for (const r of rooms) {
    const b = boundsOf(r.polygon);
    const narrowest = Math.min(b.x1 - b.x0, b.y1 - b.y0);
    check(`${name}: ${r.label} is wide enough to be a room`, narrowest >= 1.7,
      `${(narrowest / M_PER_FT).toFixed(1)} ft across`);
  }

  // And the whole house has to be walkable, which is the promise every other
  // layout path already makes.
  const openings = autoOpenings(rooms);
  const reached = reachableCount(rooms.map((r) => r.id), openings);
  check(`${name}: every room is reachable`, reached === rooms.length,
    `${reached}/${rooms.length} reachable via ${openings.length} doorways`);

  // Same input, same house. A layout that moved between runs on the same
  // address would read as the tool being unsure of itself.
  const again = packIntoFootprint(HOUSE_ROOMS, prepareFootprint(fixture.ring));
  check(`${name}: packing is deterministic`,
    JSON.stringify(again) === JSON.stringify(rooms));
}

// ------------------------------------------------------------ whole houses

// A two-storey house packed into one outline. Both storeys share the building,
// which is what a storey is - and it means the stairwells land on top of each
// other without anything having to move them there.
{
  const fp = prepareFootprint(fixtures["seattle-house"].ring, 900, 5);
  const spec = {
    rooms: [
      { label: "Living Room", level: 0 },
      { label: "Kitchen", level: 0 },
      { label: "Dining Room", level: 0 },
      { label: "Stairs", level: 0 },
      { label: "Primary Bedroom", level: 1 },
      { label: "Bedroom 2", level: 1 },
      { label: "Bathroom", level: 1 },
      { label: "Stairs", level: 1 },
    ],
  };
  const built = layoutFromFootprint(spec, fp, [["Kitchen", "Dining Room"]]);

  check("two storeys are laid out", built.rooms.length === 8, `got ${built.rooms.length}`);
  check("room ids are unique across storeys",
    new Set(built.rooms.map((r) => r.id)).size === built.rooms.length);

  for (const level of [0, 1]) {
    const onLevel = built.rooms.filter((r) => r.level === level);
    const openings = built.openings.filter(
      (o) => o.kind !== "stairs" && onLevel.some((r) => r.id === o.between[0]),
    );
    const reached = reachableCount(onLevel.map((r) => r.id), openings);
    check(`level ${level} is fully walkable`, reached === onLevel.length,
      `${reached}/${onLevel.length}`);
  }

  // What actually matters is that the storeys are joined, and the plan says
  // they are joined by deriving a stairs opening - the same rule the rest of
  // the app uses. Checking the corners lined up would be checking my method
  // rather than the requirement.
  const stairOpenings = built.openings.filter((o) => o.kind === "stairs");
  check("the storeys are joined by stairs", stairOpenings.length >= 1,
    `${stairOpenings.length} stair openings`);

  // And every room in the whole house is reachable from the front door.
  const allReached = reachableCount(built.rooms.map((r) => r.id), built.openings);
  check("the whole two-storey house is walkable", allReached === built.rooms.length,
    `${allReached}/${built.rooms.length}`);

  // Both storeys occupy the same outline, so they must cover the same area.
  const areaOf = (level: number) =>
    built.rooms
      .filter((r) => r.level === level)
      .reduce((sum, r) => {
        const b = boundsOf(r.polygon);
        return sum + (b.x1 - b.x0) * (b.y1 - b.y0);
      }, 0);
  check("both storeys fill the same footprint",
    Math.abs(areaOf(0) - areaOf(1)) < areaOf(0) * 0.02,
    `${Math.round(areaOf(0))} m² vs ${Math.round(areaOf(1))} m²`);
}

// Every two-storey house must have a way upstairs.
//
// A sweep rather than one example, because one example proved nothing here: the
// first version of this checked a single house, passed with the stairwell
// alignment removed, and would have shipped a bug. Across fifty configurations
// the alignment is the difference between all of them connected and roughly
// half of them having an unreachable upper floor.
{
  const groundRooms = ["Stairs", "Living Room", "Kitchen", "Dining Room", "Entry", "Powder Room", "Office"];
  const upperRooms = ["Stairs", "Primary Bedroom", "Bedroom 2", "Bedroom 3", "Bathroom", "Hallway", "Closet"];

  let stranded = 0;
  let houses = 0;

  for (const fixture of Object.values(fixtures)) {
    for (let g = 4; g <= groundRooms.length; g++) {
      for (let u = 4; u <= upperRooms.length; u++) {
        const spec = {
          rooms: [
            ...groundRooms.slice(0, g).map((label) => ({ label, level: 0 })),
            ...upperRooms.slice(0, u).map((label) => ({ label, level: 1 })),
          ],
        };
        const fp = prepareFootprint(fixture.ring, 1200, g);
        const built = layoutFromFootprint(spec, fp);
        houses++;

        const reached = reachableCount(built.rooms.map((r) => r.id), built.openings);
        if (reached !== built.rooms.length) stranded++;
      }
    }
  }

  check(`every two-storey house is fully walkable`, stranded === 0,
    `${stranded} of ${houses} had an unreachable room`);
  console.log(`  (${houses} two-storey configurations checked)`);
}

// The outline is coarsened when a house has too few rooms to fill its wings -
// a six-room house should not be cut into six of them.
{
  const detailed = prepareFootprint(fixtures["seattle-house"].ring, undefined, 12);
  const coarse = prepareFootprint(fixtures["seattle-house"].ring, undefined, 4);
  check("a small house gets a simpler outline",
    coarse.rects.length <= detailed.rects.length,
    `${coarse.rects.length} rects for 4 rooms vs ${detailed.rects.length} for 12`);
  check("a large house keeps the building's detail", detailed.rects.length >= 2,
    `got ${detailed.rects.length}`);
}

// ----------------------------------------------------------------- scaling

// Scaling to a listing's ground-floor area should nudge, and should refuse when
// the two sources disagree about which building this is.
const seattle = fixtures["seattle-house"];
if (seattle) {
  const raw = prepareFootprint(seattle.ring);
  const nudged = prepareFootprint(seattle.ring, raw.areaSqft * 1.2);
  check("scaling to a plausible area is applied",
    Math.abs(nudged.areaSqft - raw.areaSqft * 1.2) < raw.areaSqft * 0.02,
    `${Math.round(nudged.areaSqft)} vs ${Math.round(raw.areaSqft * 1.2)}`);

  const absurd = prepareFootprint(seattle.ring, raw.areaSqft * 5);
  check("an implausible area is refused rather than trusted",
    Math.abs(absurd.areaSqft - raw.areaSqft) < 1,
    `${Math.round(absurd.areaSqft)} vs ${Math.round(raw.areaSqft)}`);
}

console.log(
  failures === 0
    ? `FOOTPRINT OK - ${Object.keys(fixtures).length} real OSM outlines simplified, decomposed, packed and walkable`
    : `FOOTPRINT BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
