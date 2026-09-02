/**
 * Walls are built once, with thickness, and doorways are real openings.
 *
 * The failure this guards against is invisible in a screenshot: a wall between
 * two rooms emitted twice produces z-fighting that only shows at certain angles,
 * and a doorway with no header above it looks like a wall that stopped rather
 * than a door.
 */
import { readFileSync } from "node:fs";

import { DOOR_HEIGHT, EXTERIOR_THICKNESS, INTERIOR_THICKNESS, wallsForLevel } from "../src/lib/model/walls";
import { autoOpenings } from "../src/lib/plan/autolayout";
import { boundsOf } from "../src/lib/plan/geometry";
import { parseProperty } from "../src/lib/schema";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

/**
 * Load a fixture the way the app does.
 *
 * Through the schema, not `JSON.parse` alone. The demo house predates the
 * `level` field and relies on the schema default to get one — read raw, every
 * room comes back with `level: undefined`, and a test asking for level 0 finds
 * an empty house while still reporting that walls were built. Bypassing the
 * parse meant testing a code path the app never takes.
 */
const load = (path: string): Plan => {
  const doc = parseProperty(JSON.parse(readFileSync(path, "utf8")));
  // The bundled samples store openings; the two-storey one derives them.
  const openings = doc.plan.openings.length ? doc.plan.openings : autoOpenings(doc.plan.rooms);
  return { ...doc.plan, openings };
};

/** Do two wall solids occupy the same space? */
function overlaps(a: ReturnType<typeof wallsForLevel>[number], b: typeof a): boolean {
  if (a.angleDeg !== b.angleDeg) return false;
  if (a.base !== b.base) return false;

  const axis = a.angleDeg === 0 ? 0 : 1;
  const across = axis === 0 ? 1 : 0;
  const aAlong = a.center[axis];
  const bAlong = b.center[axis];
  const aAcross = a.center[across];
  const bAcross = b.center[across];

  const alongOverlap =
    Math.min(aAlong + a.length / 2, bAlong + b.length / 2) -
    Math.max(aAlong - a.length / 2, bAlong - b.length / 2);
  const acrossOverlap =
    Math.min(aAcross + a.thickness / 2, bAcross + b.thickness / 2) -
    Math.max(aAcross - a.thickness / 2, bAcross - b.thickness / 2);

  if (acrossOverlap <= 0.02) return false;

  // A duplicated wall covers substantially the same run twice. A few
  // centimetres of overlap is a junction: walls are carried past their ends to
  // fill the corner they turn, so two collinear neighbours meeting at a corner
  // now share a sliver by design. Judging that by an absolute threshold would
  // make the corner fix look like the bug it exists to fix.
  return alongOverlap > Math.min(a.length, b.length) * 0.5;
}

for (const [name, path] of [
  ["demo house", "public/properties/demo-house/property.json"],
  ["two-storey", "public/properties/two-storey/property.json"],
] as Array<[string, string]>) {
  const plan = load(path);
  const levels = [...new Set(plan.rooms.map((r) => r.level))];

  for (const level of levels) {
    const walls = wallsForLevel(plan, level);
    const label = `${name} L${level}`;

    check(`${label}: walls were built`, walls.length > 0);

    // The headline claim: a shared wall exists once.
    let doubled = 0;
    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        if (overlaps(walls[i], walls[j])) doubled++;
      }
    }
    check(`${label}: no wall is built twice`, doubled === 0, `${doubled} overlapping pairs`);

    // Every wall has real thickness, and outside walls are thicker than inside.
    const thicknesses = new Set(walls.map((w) => w.thickness));
    check(
      `${label}: thicknesses are interior or exterior`,
      [...thicknesses].every((t) => t === INTERIOR_THICKNESS || t === EXTERIOR_THICKNESS),
      [...thicknesses].join(", "),
    );
    check(`${label}: some walls are interior`, walls.some((w) => !w.exterior));
    check(`${label}: some walls are exterior`, walls.some((w) => w.exterior));

    // Doorways: one header per opening on this storey, sitting above the gap.
    const onLevel = plan.openings.filter(
      (o) => o.kind !== "stairs" && o.between.some((id) =>
        plan.rooms.some((r) => r.id === id && r.level === level)),
    );
    const headers = walls.filter((w) => w.header);
    check(
      `${label}: every doorway gets a header`,
      headers.length >= onLevel.length,
      `${headers.length} headers for ${onLevel.length} doorways`,
    );
    check(
      `${label}: headers sit above door height`,
      headers.every((h) => Math.abs(h.base - DOOR_HEIGHT) < 1e-6),
    );
    check(
      `${label}: full-height walls start at the floor`,
      walls.filter((w) => !w.header).every((w) => w.base === 0),
    );
  }
}

// A doorway must actually leave a gap: the wall run either side of it, plus the
// header, should be shorter than the unbroken wall would have been.
{
  const plan = load("public/properties/demo-house/property.json");
  const withDoors = wallsForLevel(plan, 0).filter((w) => !w.header);
  const withoutDoors = wallsForLevel({ ...plan, openings: [] }, 0).filter((w) => !w.header);
  const total = (ws: typeof withDoors) => ws.reduce((s, w) => s + w.length, 0);

  check(
    "doorways remove wall",
    total(withDoors) < total(withoutDoors) - 1,
    `${total(withDoors).toFixed(1)}m with doors against ${total(withoutDoors).toFixed(1)}m without`,
  );
}

// Corners close.
//
// Two boxes meeting at a right angle leave the outer quadrant empty, and on the
// demo house that was a 200mm square hole at every corner of the building - you
// could see straight through it when orbiting past. It is exactly the kind of
// fault that a screenshot from the wrong angle says nothing about, so it is
// probed against the geometry rather than looked at.
for (const fixture of ["demo-house", "two-storey"]) {
  const plan = load(`public/properties/${fixture}/property.json`);

  for (const level of [...new Set(plan.rooms.map((r) => r.level))]) {
    const boxes = wallsForLevel(plan, level)
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
    if (boxes.length === 0) continue;

    const solid = (x: number, y: number) =>
      boxes.some((b) => x >= b.x0 - 1e-9 && x <= b.x1 + 1e-9 && y >= b.y0 - 1e-9 && y <= b.y1 + 1e-9);

    // Every corner of every room, probed just outside it on the diagonal -
    // which is precisely where the quadrant went missing.
    let holes = 0;
    let probes = 0;
    for (const room of plan.rooms.filter((r) => r.level === level)) {
      const b = boundsOf(room.polygon);
      for (const [cx, cy] of [
        [b.x0, b.y0],
        [b.x1, b.y0],
        [b.x0, b.y1],
        [b.x1, b.y1],
      ]) {
        const sx = cx === b.x0 ? -1 : 1;
        const sy = cy === b.y0 ? -1 : 1;
        probes++;
        if (!solid(cx + sx * 0.03, cy + sy * 0.03)) holes++;
      }
    }
    check(
      `${fixture} level ${level}: no open corners`,
      holes === 0,
      `${holes} of ${probes} room corners let daylight through`,
    );
  }
}

console.log(
  failures === 0
    ? "WALLS OK - shared walls built once, real thickness, doorways cut with headers above, corners closed"
    : `WALLS BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
