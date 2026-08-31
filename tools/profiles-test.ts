/**
 * A moulding ends up against the wall, the right way up, and in the room.
 *
 * The transform is three rotations' worth of opportunity to be subtly wrong,
 * and every way of being wrong looks the same from a distance: the skirting is
 * simply not where it should be. Inside the plaster, lying on its side, or
 * running off down the room are all "the profile didn't work" in a screenshot
 * and all completely different bugs.
 *
 * So this measures the bounding box. A run against a known wall has a known
 * extent in all three axes, and asserting that is the whole of the geometry.
 */
import * as THREE from "three";

import { profileShape, runGeometry } from "../src/lib/model/profiles";
import type { TrimProfile } from "../src/lib/spec/schema";
import type { Segment } from "../src/lib/plan/geometry";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

const box = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return { min: b.min, max: b.max };
};

const PROFILES: TrimProfile[] = ["square", "chamfer", "ogee", "stepped", "colonial"];

// --- the section itself ---
for (const kind of PROFILES) {
  const shape = profileShape(kind, 0.14, 0.02);
  const points = shape.getPoints(8);
  check(`${kind}: the section is closed and has area`, points.length >= 4);
  check(
    `${kind}: the section stays inside its declared height and depth`,
    points.every((p) => p.x >= -1e-9 && p.x <= 0.02 + 1e-9 && p.y >= -1e-9 && p.y <= 0.14 + 1e-9),
    points.map((p) => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`).join(" "),
  );
}

/**
 * A 4m room from (0,0) to (4,3). The south wall runs along z=3 from x=4 to
 * x=0, wound so the room is on its left; inward is therefore -z.
 */
const southWall: Segment = { a: [4, 3], b: [0, 3] };
const H = 0.14;
const D = 0.02;

const south = runGeometry("square", southWall, {
  height: H,
  depth: D,
  baseY: 0,
  inward: [0, -1],
})!;
check("a run is produced", Boolean(south));

const s = box(south);
check("it stands on the floor", near(s.min.y, 0, 1e-6), `${s.min.y}`);
check("it is exactly as tall as asked", near(s.max.y - s.min.y, H, 1e-6), `${s.max.y - s.min.y}`);
check("it spans the whole wall", near(s.max.x - s.min.x, 4, 1e-6), `${s.max.x - s.min.x}`);
check(
  "it sits against the wall, not through it",
  near(s.max.z, 3, 1e-6) && near(s.min.z, 3 - D, 1e-6),
  `z ${s.min.z.toFixed(4)}..${s.max.z.toFixed(4)}, wall at 3, room is z<3`,
);

// The same wall wound the other way must produce the same solid. A run's
// direction is an accident of which room's polygon it came off.
const reversed = runGeometry("square", { a: [0, 3], b: [4, 3] }, {
  height: H,
  depth: D,
  baseY: 0,
  inward: [0, -1],
})!;
const r = box(reversed);
check(
  "winding does not matter",
  near(r.min.x, s.min.x, 1e-6) &&
    near(r.max.x, s.max.x, 1e-6) &&
    near(r.min.z, s.min.z, 1e-6) &&
    near(r.max.z, s.max.z, 1e-6),
  `reversed z ${r.min.z.toFixed(4)}..${r.max.z.toFixed(4)}`,
);

// A wall on the other axis.
const west = runGeometry("square", { a: [0, 0], b: [0, 3] }, {
  height: H,
  depth: D,
  baseY: 0,
  inward: [1, 0],
})!;
const w = box(west);
check(
  "a run on the other axis is turned to match",
  near(w.max.z - w.min.z, 3, 1e-6) && near(w.max.x - w.min.x, D, 1e-6),
  `x ${(w.max.x - w.min.x).toFixed(4)} z ${(w.max.z - w.min.z).toFixed(4)}`,
);
check("and grows into the room", near(w.min.x, 0, 1e-6), `x from ${w.min.x}`);

// Raised runs, for crown moulding.
const crown = runGeometry("ogee", southWall, {
  height: 0.1,
  depth: 0.08,
  baseY: 2.6,
  inward: [0, -1],
})!;
const c = box(crown);
check("a raised run starts where it was put", near(c.min.y, 2.6, 1e-6), `${c.min.y}`);

// Mitre allowance.
const mitred = runGeometry("square", southWall, {
  height: H,
  depth: D,
  baseY: 0,
  inward: [0, -1],
  extend: 0.02,
})!;
const m = box(mitred);
check(
  "the mitre allowance lengthens the run at both ends",
  near(m.max.x - m.min.x, 4 + 0.04, 1e-6),
  `${(m.max.x - m.min.x).toFixed(4)}`,
);

// Degenerate inputs return nothing rather than something broken.
check(
  "a zero-length run makes nothing",
  runGeometry("square", { a: [1, 1], b: [1, 1] }, { height: H, depth: D, baseY: 0, inward: [0, -1] }) === null,
);
check(
  "a zero-height run makes nothing",
  runGeometry("square", southWall, { height: 0, depth: D, baseY: 0, inward: [0, -1] }) === null,
);

// Cost. A skirting run is on every wall of every room, so its triangle count
// is multiplied by the whole house.
const triangles = south.getAttribute("position").count / 3;
check("a plain run is cheap", triangles <= 40, `${triangles} triangles`);
const ogeeTriangles =
  runGeometry("ogee", southWall, { height: H, depth: D, baseY: 0, inward: [0, -1] })!.getAttribute(
    "position",
  ).count / 3;
check("and a moulded one is not much worse", ogeeTriangles <= 120, `${ogeeTriangles} triangles`);

console.log(
  failures === 0
    ? `PROFILES OK - sections stay in section, runs stand on the floor against their wall and grow into the room, either winding, on either axis`
    : `PROFILES FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
);
process.exit(failures === 0 ? 0 : 1);
