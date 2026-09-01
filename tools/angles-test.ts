/**
 * Which directions a drawing is built on.
 *
 * The half of "snap to the most probable shape, but keep real angles" that
 * decides what probable means. Two failures matter and both are silent: a
 * family straddling zero degrees averaging to the perpendicular, and a genuine
 * 30 degree wing being dragged square because the house around it is square.
 */
import { FOLD, angleGap, dominantAngles, ringAngle, snapToFamily, type Segment } from "../src/lib/plan/angles";
import { dominantAngle } from "../src/lib/plan/footprint";
import type { Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

/** A segment of the given length at the given angle, with optional wobble. */
function seg(deg: number, length = 4, wobble = 0, at: Vec2 = [0, 0]): Segment {
  const r = ((deg + wobble) * Math.PI) / 180;
  return { a: at, b: [at[0] + Math.cos(r) * length, at[1] + Math.sin(r) * length] };
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// --- a wobbly square plan has one family, not eight ---
{
  const wobbles = [0.8, -1.1, 0.4, -0.6, 1.3, -0.9, 0.2, -1.4];
  const segments = wobbles.map((w, i) => seg(i % 2 === 0 ? 0 : 90, 5, w));
  const family = dominantAngles(segments);
  check("a wobbly square plan is one family", family.modes.length === 1,
    `${family.modes.length} modes`);
  check("and it explains everything", family.explained > 0.99, `${family.explained.toFixed(2)}`);
  check("the fold is a quarter turn", FOLD === 90);
}

// --- a family straddling zero does not average to the perpendicular ---
//
// The doubling exists for this. Walls at 179 and 1 degree are two degrees
// apart, not a hundred and seventy-eight, and averaging them the naive way
// gives 90 - which is perpendicular to every wall in the set.
{
  const segments = [seg(179), seg(1), seg(178.5), seg(1.5), seg(0), seg(179.5)];
  const family = dominantAngles(segments, { toleranceDeg: 8 });
  check("they are one direction, not several", family.modes.length === 1,
    family.modes.map((m) => m.degrees.toFixed(1)).join(", "));
  // Measured as a gap on the fold, because 89.9 and 0 are the same direction
  // there - a quarter turn is a whole circle for a wall.
  const gap = Math.abs(angleGap(family.modes[0].degrees, 0));
  check("and that direction is zero, not the perpendicular", gap < 3,
    `${family.modes[0].degrees.toFixed(2)} is ${gap.toFixed(2)} off zero`);
}

// --- a genuine wing survives ---
{
  // A square house, plus a wing at 30 degrees carrying a real share of the wall.
  const square = [seg(0, 8), seg(90, 8), seg(0, 8), seg(90, 8)];
  const wing = [seg(30, 7), seg(120, 7), seg(30, 7)];
  const family = dominantAngles([...square, ...wing]);
  const has = (deg: number) => family.modes.some((m) => Math.abs(angleGap(m.degrees, deg)) < 6);
  check("the square part is a family", has(0), family.modes.map((m) => m.degrees.toFixed(1)).join(", "));
  // The wing's own walls are at 30 and 120, which is a perpendicular pair like
  // any other - so it is one family at 30, not two.
  check("and the wing is a second one", has(30),
    family.modes.map((m) => m.degrees.toFixed(1)).join(", "));
  check("two families in all", family.modes.length === 2, `${family.modes.length}`);
}

// --- snapping straightens without sliding ---
{
  const family = dominantAngles([seg(0, 6), seg(90, 6), seg(0, 6), seg(90, 6)]);
  const wonky = seg(3.4, 5, 0, [2, 2]);
  const before: Vec2 = [(wonky.a[0] + wonky.b[0]) / 2, (wonky.a[1] + wonky.b[1]) / 2];
  const { segment: after, snapped } = snapToFamily(wonky, family);
  check("a nearly-square wall is snapped", snapped);
  const mid: Vec2 = [(after.a[0] + after.b[0]) / 2, (after.a[1] + after.b[1]) / 2];
  check("about its own middle, so it does not slide",
    Math.hypot(mid[0] - before[0], mid[1] - before[1]) < 1e-9,
    `moved ${Math.hypot(mid[0] - before[0], mid[1] - before[1]).toFixed(6)}`);
  const length = Math.hypot(after.b[0] - after.a[0], after.b[1] - after.a[1]);
  check("and keeps its length", near(length, 5, 1e-9), `${length}`);
}

// --- a wall genuinely off on its own keeps its angle ---
{
  const family = dominantAngles([seg(0, 9), seg(90, 9), seg(0, 9), seg(90, 9)]);
  const oddity = seg(41, 4);
  const { snapped } = snapToFamily(oddity, family, 12);
  check("a wall 41 degrees off everything is left alone", !snapped);
}

// --- ringAngle answers exactly what dominantAngle always did ---
{
  const rings: Vec2[][] = [
    [[0, 0], [10, 0], [10, 6], [0, 6]],
    [[0, 0], [8, 3], [5, 8], [-3, 5]],
    [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]],
  ];
  for (const [i, ring] of rings.entries()) {
    check(`ring ${i} keeps its old angle`, ringAngle(ring) === dominantAngle(ring),
      `${ringAngle(ring)} vs ${dominantAngle(ring)}`);
  }
  // Including at a rotation, which is the case that actually feeds the sun.
  for (const deg of [7, 23, 47]) {
    const turned: Vec2[] = rings[0].map(([x, y]) => {
      const r = (deg * Math.PI) / 180;
      return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
    });
    check(`a ring at ${deg}deg keeps its old angle`,
      ringAngle(turned) === dominantAngle(turned),
      `${ringAngle(turned)} vs ${dominantAngle(turned)}`);
  }
}

// --- nothing in, nothing out ---
{
  const family = dominantAngles([]);
  check("no segments yields no modes", family.modes.length === 0);
  const s = seg(17);
  check("and snapping is then a no-op", snapToFamily(s, family).segment === s);
}

if (failures > 0) {
  console.error(`\nANGLES: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  "ANGLES OK - a wobbly square plan is one family, walls either side of zero are one direction rather than the perpendicular, a genuine 30 degree wing survives, snapping turns a wall about its own middle, and ringAngle answers exactly what dominantAngle always did",
);
