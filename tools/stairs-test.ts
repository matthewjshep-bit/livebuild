/**
 * A staircase you can actually climb.
 *
 * Stairs were a flat slab with a ramp underneath, so the model showed a floor
 * where a staircase was. The thing to guard now is subtler and worse: that the
 * treads drawn and the heights the walker's feet land on come apart. That is
 * invisible in a screenshot - the stair looks right and you sink through it -
 * which is exactly why every check here reads geometry rather than pixels.
 */
import { readFileSync } from "node:fs";

import {
  FLIGHT_WIDTH_MIN,
  GOING_MIN,
  PITCH_MAX_DEG,
  RISER_MAX,
  SUM_MAX,
  SUM_MIN,
  ceilingHolesFor,
  fitStair,
  floorHolesFor,
  heightAt,
  levelForHeight,
  stairPieces,
  stairRuns,
  subtractRects,
} from "../src/lib/model/stairs";
import { boundsOf } from "../src/lib/plan/autolayout";
import { levelBase } from "../src/lib/plan/geometry";
import { type Plan, parseProperty } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const load = (path: string): Plan => parseProperty(JSON.parse(readFileSync(path, "utf8"))).plan;
const plan = load("public/properties/two-storey/property.json");

// ------------------------------------------------------------------ the fit

const runs = stairRuns(plan);
check("the two-storey house has one staircase", runs.length === 1, `${runs.length} runs`);

if (runs.length === 0) {
  console.log("STAIRS BROKEN - no run to test");
  process.exit(1);
}

const run = runs[0];
const s = run.spec;

console.log(
  `  ${s.kind}: ${s.risers} risers @ ${(s.riser * 1000).toFixed(1)}mm, ` +
    `going ${(s.going * 1000).toFixed(0)}mm, 2R+G ${(s.twoRPlusG * 1000).toFixed(0)}mm, ` +
    `${s.pitchDeg.toFixed(1)}°, flights ${(s.flightWidth * 1000).toFixed(0)}mm`,
);

// A straight flight cannot fit a generated stairwell, and that is the reason
// this module exists rather than drawing a ramp with lines on it.
check("a generated stairwell gets a half-turn, not a straight flight",
  s.kind === "switchback", `got ${s.kind}`);

check("the rise is the storey height exactly",
  Math.abs(s.rise - (levelBase(plan, 1) - levelBase(plan, 0))) < 1e-9,
  `${s.rise}`);
check("the risers add up to the rise",
  Math.abs(s.risers * s.riser - s.rise) < 1e-9,
  `${s.risers} x ${s.riser} vs ${s.rise}`);

// The ergonomics, which have real answers rather than opinions.
check("the riser is climbable", s.riser <= RISER_MAX + 1e-9, `${(s.riser * 1000).toFixed(1)}mm`);
check("the going is deep enough for a foot", s.going >= GOING_MIN - 1e-9,
  `${(s.going * 1000).toFixed(0)}mm`);
check("2R+G is inside the comfort band",
  s.twoRPlusG >= SUM_MIN - 1e-6 && s.twoRPlusG <= SUM_MAX + 1e-6,
  `${(s.twoRPlusG * 1000).toFixed(1)}mm`);
check("the pitch is not a ladder", s.pitchDeg <= PITCH_MAX_DEG, `${s.pitchDeg.toFixed(1)}°`);
check("the flights are wide enough to walk", s.flightWidth >= FLIGHT_WIDTH_MIN - 1e-9,
  `${(s.flightWidth * 1000).toFixed(0)}mm`);
check("it reports itself compliant", s.compliant && s.warnings.length === 0,
  s.warnings.join(" | "));

// ------------------------------------------------- drawn and walked agree

// The check that matters. Every step is sampled across its own rectangle and
// the height the walker would be given must be the height the tread was drawn
// at. Two descriptions of the staircase, one assertion.
{
  let mismatches = 0;
  let samples = 0;
  for (const step of run.steps) {
    for (let i = 1; i <= 3; i++) {
      for (let j = 1; j <= 3; j++) {
        const x = step.rect.x0 + ((step.rect.x1 - step.rect.x0) * i) / 4;
        const y = step.rect.y0 + ((step.rect.y1 - step.rect.y0) * j) / 4;
        samples++;
        if (Math.abs((heightAt(run, x, y) ?? -1e9) - step.top) > 1e-9) mismatches++;
      }
    }
  }
  check("the walker's feet land on the treads that were drawn",
    mismatches === 0, `${mismatches} of ${samples} samples disagreed`);
}

// And the boxes actually rendered must sit at those same heights.
{
  const lower = plan.rooms.find((r) => r.id === run.lowerRoomId)!;
  const upper = plan.rooms.find((r) => r.id === run.upperRoomId)!;
  const tops = new Set(run.steps.filter((st) => st.role !== "apron").map((st) => st.top.toFixed(6)));

  let drawn = 0;
  let stray = 0;
  for (const [room, level] of [
    [lower, run.lowerLevel],
    [upper, run.lowerLevel + 1],
  ] as Array<[typeof lower, number]>) {
    const b = boundsOf(room.polygon);
    const baseY = levelBase(plan, level);
    for (const piece of stairPieces(plan, room, level)) {
      for (const box of piece.boxes) {
        drawn++;
        const top = baseY + box.center[1] + box.size[1] / 2;
        if (!tops.has(top.toFixed(6))) stray++;
        // Room-local, as the furniture convention requires.
        const px = b.x0 + box.center[0];
        const py = b.y0 + box.center[2];
        if (!(px >= run.footprint.x0 - 1e-6 && px <= run.footprint.x1 + 1e-6)) stray++;
        if (!(py >= run.footprint.y0 - 1e-6 && py <= run.footprint.y1 + 1e-6)) stray++;
      }
    }
  }
  check("every tread is drawn at the height its step declares", stray === 0,
    `${stray} strays across ${drawn} boxes`);
  check("both storeys draw part of the staircase", drawn === tops.size,
    `${drawn} boxes for ${tops.size} steps`);
}

// Nothing is drawn twice: the plan cut partitions the staircase.
{
  const lower = plan.rooms.find((r) => r.id === run.lowerRoomId)!;
  const upper = plan.rooms.find((r) => r.id === run.upperRoomId)!;
  const below = stairPieces(plan, lower, run.lowerLevel).flatMap((p) => p.boxes).length;
  const above = stairPieces(plan, upper, run.lowerLevel + 1).flatMap((p) => p.boxes).length;
  check("each storey draws some of it", below > 0 && above > 0, `${below} below, ${above} above`);
  console.log(`  ${below} steps drawn on the lower storey, ${above} on the upper`);
}

// ------------------------------------------------------------- the climb

// March the whole staircase and check it climbs one riser at a time. An
// off-by-one in the flight split shows up here and nowhere else.
{
  const jumps: number[] = [];
  let previous: number | null = null;
  const ordered = [...run.steps].sort((a, b) => a.top - b.top);
  for (const step of ordered) {
    if (previous !== null) jumps.push(step.top - previous);
    previous = step.top;
  }
  const worst = Math.max(...jumps);
  check("no single step is taller than one riser", worst <= s.riser + 1e-9,
    `${(worst * 1000).toFixed(1)}mm against a ${(s.riser * 1000).toFixed(1)}mm riser`);
  check("the top of the staircase reaches the floor above",
    Math.abs(ordered[ordered.length - 1].top + s.riser - run.topY) < 1e-9,
    `${ordered[ordered.length - 1].top} + one riser vs ${run.topY}`);
  check("the bottom starts at the floor below",
    Math.abs(ordered[0].top - run.baseY) < 1e-9, `${ordered[0].top}`);
}

// The storey a height belongs to, which is what flips the walker between floors.
check("halfway up you are still downstairs", levelForHeight(plan, run.baseY + 0.4) === 0);
check("near the top you are upstairs", levelForHeight(plan, run.topY - 0.3) === 1);

// ------------------------------------------------------------ slab surgery

check("no holes means the room is unchanged",
  JSON.stringify(subtractRects({ x0: 0, y0: 0, x1: 4, y1: 3 }, [])) ===
    JSON.stringify([{ x0: 0, y0: 0, x1: 4, y1: 3 }]));

{
  const outer = { x0: 0, y0: 0, x1: 4, y1: 4 };
  const hole = { x0: 1, y0: 1, x1: 2, y1: 2 };
  const pieces = subtractRects(outer, [hole]);
  const area = pieces.reduce((sum, r) => sum + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  check("cutting a hole removes exactly its area", Math.abs(area - (16 - 1)) < 1e-9, `${area}`);
  const overlaps = pieces.some(
    (r) => r.x0 < hole.x1 && hole.x0 < r.x1 && r.y0 < hole.y1 && hole.y0 < r.y1,
  );
  check("and no piece reaches back into the hole", !overlaps);
}

// The floor above the staircase must be opened, and nothing else must be.
for (const room of plan.rooms) {
  const floor = floorHolesFor(plan, room);
  const ceiling = ceilingHolesFor(plan, room);
  check(`${room.label} L${room.level}: floor opened only where a stair arrives`,
    (floor.length > 0) === (room.id === run.upperRoomId), `${floor.length} holes`);
  check(`${room.label} L${room.level}: ceiling opened only where a stair leaves`,
    (ceiling.length > 0) === (room.id === run.lowerRoomId), `${ceiling.length} holes`);
}

// ---------------------------------------------------------- degenerate cases

// A stairwell too small for any staircase must degrade to the old ramp rather
// than throw or produce a ladder - the tour still has to be walkable.
{
  const tiny = fitStair(3.05, { x0: 0, y0: 0, x1: 1.4, y1: 1.2 });
  check("a stairwell too small falls back to a ramp", tiny.spec.kind === "ramp", tiny.spec.kind);
  check("and says why", tiny.spec.warnings.length > 0 && !tiny.spec.compliant);
}

// A generous room should not produce a lazy stair: the going is clamped and the
// surplus goes into the landing.
{
  const roomy = fitStair(3.05, { x0: 0, y0: 0, x1: 5.0, y1: 2.4 });
  check("a generous stairwell still respects the comfort band",
    roomy.spec.twoRPlusG <= SUM_MAX + 1e-6, `${(roomy.spec.twoRPlusG * 1000).toFixed(0)}mm`);
}

// Deterministic: the same house must not put its staircase somewhere else on a
// second render.
check("fitting is deterministic",
  JSON.stringify(fitStair(3.05, { x0: 0, y0: 0, x1: 3, y1: 1.7 })) ===
    JSON.stringify(fitStair(3.05, { x0: 0, y0: 0, x1: 3, y1: 1.7 })));

// A house with no staircase at all must produce none.
check("a single-storey house has no staircases",
  stairRuns(load("public/properties/demo-house/property.json")).length === 0);

console.log(
  failures === 0
    ? `STAIRS OK - ${s.risers} risers at ${(s.riser * 1000).toFixed(0)}mm, ` +
      `${s.pitchDeg.toFixed(0)}° pitch, and the treads drawn are the heights walked`
    : `STAIRS BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
