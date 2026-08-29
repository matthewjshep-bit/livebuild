/**
 * Geometric faults that no screenshot would show.
 *
 * Three checks, each guarding a failure that is invisible until somebody
 * stands in the wrong place: a hole where two walls meet, a room on the first
 * floor resting on nothing, and a doorway between two rooms that do not touch.
 *
 * All of them run against the plan and the solved geometry rather than against
 * a render. A picture that looks right is not evidence - it is a picture from
 * one angle, and every one of these faults hides from most angles.
 */
import { readFileSync } from "node:fs";

import { wallsForLevel } from "../src/lib/model/walls";
import { boundsOf, rectangle } from "../src/lib/plan/autolayout";
import { layoutFromFootprint, prepareFootprint } from "../src/lib/plan/footprint";
import { layoutFromSpec } from "../src/lib/plan/autolayout";
import { roomKind } from "../src/lib/plan/room-kind";
import { type Plan, parseProperty } from "../src/lib/schema";
import { M_PER_FT } from "../src/lib/units";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const load = (path: string): Plan => parseProperty(JSON.parse(readFileSync(path, "utf8"))).plan;

type Box = { x0: number; y0: number; x1: number; y1: number };

function wallBoxes(plan: Plan, level: number): Box[] {
  return wallsForLevel(plan, level)
    .filter((w) => !w.header)
    .map((w) => {
      const alongX = Math.abs(w.angleDeg) < 45;
      const halfW = (alongX ? w.length : w.thickness) / 2;
      const halfD = (alongX ? w.thickness : w.length) / 2;
      return {
        x0: w.center[0] - halfW,
        y0: w.center[1] - halfD,
        x1: w.center[0] + halfW,
        y1: w.center[1] + halfD,
      };
    });
}

/**
 * Hole area where walls meet, measured rather than probed.
 *
 * The corner check in walls-test samples one point diagonally outside each room
 * corner, which catches the fault it was written for and nothing else. This
 * rasterises the neighbourhood of every wall end and reports the actual missing
 * area, so a gap anywhere along a junction shows up as a number.
 */
function junctionGapSqft(plan: Plan, level: number): number {
  const boxes = wallBoxes(plan, level);
  if (boxes.length === 0) return 0;

  const solid = (x: number, y: number) =>
    boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);

  // Room space is not a hole. Without this the rule counts the inside corner of
  // every room - a cell within a few centimetres of two perpendicular walls,
  // which describes the corner of any room as accurately as it describes a
  // gap. That over-count read as twelve square feet of missing wall on a house
  // whose corners were sound.
  const rooms = plan.rooms.filter((r) => r.level === level).map((r) => boundsOf(r.polygon));
  const indoors = (x: number, y: number) =>
    rooms.some((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1);

  // Sample a small square around each wall end - a junction is where the holes
  // are, and rasterising the whole storey at this resolution would be slow for
  // no extra information.
  const CELL = 0.01;
  const WINDOW = 0.3;
  let missing = 0;
  const seen = new Set<string>();

  for (const b of boxes) {
    for (const [cx, cy] of [
      [b.x0, b.y0],
      [b.x1, b.y0],
      [b.x0, b.y1],
      [b.x1, b.y1],
    ]) {
      const key = `${cx.toFixed(2)},${cy.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      for (let x = cx - WINDOW; x < cx + WINDOW; x += CELL) {
        for (let y = cy - WINDOW; y < cy + WINDOW; y += CELL) {
          // The signature of a junction hole is wall on one side *and* wall on
          // a perpendicular side - the missing quadrant where two walls turn.
          //
          // Requiring wall on all four sides was the first rule and it can
          // never fire: an outside corner is open to the outdoors on exactly
          // the two sides the walls are not on. It passed with the corner fix
          // reverted, which is the definition of a check that does nothing.
          //
          // A doorway is not caught by this: it has wall along the run and open
          // room on both perpendicular sides. Nor is a point outdoors beside a
          // wall, which has one solid neighbour and no perpendicular one.
          if (solid(x, y) || indoors(x, y)) continue;
          const acrossX = solid(x - 0.12, y) || solid(x + 0.12, y);
          const acrossY = solid(x, y - 0.12) || solid(x, y + 0.12);
          if (acrossX && acrossY) missing += CELL * CELL;
        }
      }
    }
  }
  return missing / (M_PER_FT * M_PER_FT);
}

// ------------------------------------------------------------------ coverage

for (const fixture of ["demo-house", "two-storey"]) {
  const plan = load(`public/properties/${fixture}/property.json`);
  for (const level of [...new Set(plan.rooms.map((r) => r.level))]) {
    const gap = junctionGapSqft(plan, level);
    check(
      `${fixture} level ${level}: no gaps where walls turn`,
      gap < 0.2,
      `${gap.toFixed(2)} sq ft missing`,
    );
    console.log(`  ${fixture} L${level}: ${gap.toFixed(2)} sq ft of junction gap`);
  }
}

// ------------------------------------------------------------------- support

/**
 * Every upper room must rest on something.
 *
 * A storey packed independently of the one below can float: the geometry is
 * valid, the dollhouse looks fine from above, and walking upstairs puts you on
 * a floor with nothing under it. `layoutFromFootprint` packs every storey into
 * the same outline so this cannot happen there, but `layoutFromSpec` does not,
 * and it is still the path a described house takes.
 */
function unsupportedSqft(plan: Plan, level: number): number {
  const below = plan.rooms.filter((r) => r.level === level - 1).map((r) => boundsOf(r.polygon));
  if (below.length === 0) return 0;

  let unsupported = 0;
  for (const room of plan.rooms.filter((r) => r.level === level)) {
    const b = boundsOf(room.polygon);
    const CELL = 0.25;
    for (let x = b.x0 + CELL / 2; x < b.x1; x += CELL) {
      for (let y = b.y0 + CELL / 2; y < b.y1; y += CELL) {
        const held = below.some((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1);
        if (!held) unsupported += CELL * CELL;
      }
    }
  }
  return unsupported / (M_PER_FT * M_PER_FT);
}

{
  const plan = load("public/properties/two-storey/property.json");
  const upper = unsupportedSqft(plan, 1);
  check("the two-storey fixture's upper floor rests on the one below",
    upper < 20, `${upper.toFixed(0)} sq ft over thin air`);
}

// A described two-storey house, which is the path that packs storeys apart.
{
  const built = layoutFromSpec({
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
  });
  const plan: Plan = { scaleRef: { px: 1, meters: 1 }, rooms: built.rooms, openings: built.openings };
  const upper = unsupportedSqft(plan, 1);
  const upperArea = plan.rooms
    .filter((r) => r.level === 1)
    .reduce((sum, r) => {
      const b = boundsOf(r.polygon);
      return sum + (b.x1 - b.x0) * (b.y1 - b.y0);
    }, 0) / (M_PER_FT * M_PER_FT);

  check("a described upper storey is mostly supported",
    upper < upperArea * 0.35,
    `${upper.toFixed(0)} of ${upperArea.toFixed(0)} sq ft over thin air`);
  console.log(
    `  described two-storey: ${upper.toFixed(0)} of ${upperArea.toFixed(0)} sq ft unsupported ` +
      `(${Math.round((upper / upperArea) * 100)}%)`,
  );
}

// And the footprint path, which shares one outline between storeys and so
// should be supported almost exactly.
{
  const fixtures = JSON.parse(readFileSync("public/fixtures/footprints.json", "utf8"));
  const fp = prepareFootprint(fixtures["seattle-house"].ring, 900, 5);
  const built = layoutFromFootprint({
    rooms: [
      { label: "Living Room", level: 0 },
      { label: "Kitchen", level: 0 },
      { label: "Stairs", level: 0 },
      { label: "Primary Bedroom", level: 1 },
      { label: "Bathroom", level: 1 },
      { label: "Stairs", level: 1 },
    ],
  }, fp);
  const plan: Plan = { scaleRef: { px: 1, meters: 1 }, rooms: built.rooms, openings: built.openings };
  const upper = unsupportedSqft(plan, 1);
  check("a footprint-packed upper storey sits exactly on the one below",
    upper < 5, `${upper.toFixed(1)} sq ft over thin air`);
  console.log(`  footprint-packed two-storey: ${upper.toFixed(1)} sq ft unsupported`);
}

// ------------------------------------------------------------------ openings

/**
 * Every doorway joins two rooms that actually touch.
 *
 * A door between rooms that do not share a wall is a hole cut in nothing. It
 * would not show in the render, because the subtraction lands on whichever wall
 * happens to be at those coordinates - possibly somebody else's.
 */
for (const fixture of ["demo-house", "two-storey"]) {
  const plan = load(`public/properties/${fixture}/property.json`);
  const byId = new Map(plan.rooms.map((r) => [r.id, r]));

  let orphans = 0;
  let mismatched = 0;
  for (const opening of plan.openings) {
    const a = byId.get(opening.between[0]);
    const b = byId.get(opening.between[1]);
    if (!a || !b) {
      orphans++;
      continue;
    }
    if (opening.kind === "stairs") continue;
    if (a.level !== b.level) {
      mismatched++;
      continue;
    }

    const p = boundsOf(a.polygon);
    const q = boundsOf(b.polygon);
    const touchX = Math.abs(p.x1 - q.x0) < 0.12 || Math.abs(q.x1 - p.x0) < 0.12;
    const touchY = Math.abs(p.y1 - q.y0) < 0.12 || Math.abs(q.y1 - p.y0) < 0.12;
    const overlapX = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 0.3;
    const overlapY = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0) > 0.3;

    if (!((touchX && overlapY) || (touchY && overlapX))) mismatched++;
  }

  check(`${fixture}: every doorway names rooms that exist`, orphans === 0, `${orphans} orphaned`);
  check(`${fixture}: every doorway joins rooms that touch`, mismatched === 0,
    `${mismatched} of ${plan.openings.length} join rooms that do not share a wall`);
}

// A room that is nowhere near another must not acquire a doorway, which is the
// invariant the above would miss if the fixtures happened to be tidy.
{
  const plan: Plan = {
    scaleRef: { px: 1, meters: 1 },
    rooms: [
      { id: "a", label: "Kitchen", polygon: rectangle(0, 0, 4, 4), ceilingHeight: 2.7, level: 0 },
      { id: "b", label: "Bedroom", polygon: rectangle(20, 20, 4, 4), ceilingHeight: 2.7, level: 0 },
    ],
    openings: [],
  };
  const walls = wallsForLevel(plan, 0);
  check("two distant rooms produce two separate shells", walls.length > 0);
  check("nothing bridges them", roomKind("Kitchen") !== roomKind("Bedroom"));
}

console.log(
  failures === 0
    ? "GEOMETRY OK - junctions close, upper storeys rest on something, doorways join rooms that touch"
    : `GEOMETRY BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
