/**
 * A floor covers its own room.
 *
 * `decompose` has been the only way from a polygon to a floor, and it is
 * rectilinear-only: given a square turned seven degrees it uses the polygon's
 * own x and y values as gridlines and returns a staircase that does not cover
 * the shape. Silently. This is the replacement, and the property that matters is
 * the boring one - the triangles add up to the polygon.
 */
import { area, pointInPolygon, signedArea } from "../src/lib/plan/geometry";
import { cleanPolygon, covers, interiorPoint, triangles, triangulate } from "../src/lib/model/tessellate";
import type { Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const turn = (poly: Vec2[], deg: number): Vec2[] => {
  const r = (deg * Math.PI) / 180;
  return poly.map(([x, y]) => [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]);
};

const SQUARE: Vec2[] = [[0, 0], [4, 0], [4, 3], [0, 3]];
const ELL: Vec2[] = [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]];
const TEE: Vec2[] = [[0, 0], [9, 0], [9, 3], [6, 3], [6, 8], [3, 8], [3, 3], [0, 3]];
const HEX: Vec2[] = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = (i * Math.PI) / 3;
  return [3 * Math.cos(a), 3 * Math.sin(a)] as Vec2;
});

// --- the property that matters, at every angle ---
for (const [name, poly] of [["square", SQUARE], ["L", ELL], ["T", TEE], ["hexagon", HEX]] as const) {
  for (const deg of [0, 7, 30, 45, 63, 90, 137]) {
    const turned = turn(poly, deg);
    check(`${name} at ${deg}deg is covered`, covers(turned), `area ${area(turned).toFixed(4)}`);
  }
  // And wound the other way, because a caller should not have to know.
  check(`${name} reversed is covered`, covers([...poly].reverse()));
}

// --- every triangle is inside the room ---
{
  for (const [name, poly] of [["L", ELL], ["T", TEE]] as const) {
    let outside = 0;
    for (const [a, b, c] of triangles(poly)) {
      const centre: Vec2 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
      if (!pointInPolygon(centre, poly)) outside++;
    }
    check(`no ${name} triangle strays outside the room`, outside === 0, `${outside}`);
  }
}

// --- every triangle faces the same way ---
{
  const signs = new Set(triangles(ELL).map(([a, b, c]) => Math.sign(signedArea([a, b, c]))));
  check("triangles are wound consistently", signs.size === 1, [...signs].join(","));
}

// --- indices address the caller's own polygon ---
{
  const idx = triangulate(ELL);
  const inRange = idx.every((t) => t.every((i) => i >= 0 && i < ELL.length));
  check("indices point into the polygon given", inRange, JSON.stringify(idx));
  check("an L needs four triangles", idx.length === ELL.length - 2, `${idx.length}`);
}

// --- degenerate input is refused, not guessed at ---
{
  check("a duplicated vertex is cleaned away", cleanPolygon([[0, 0], [0, 0], [4, 0], [4, 3]]).length === 3);
  check("a collinear run is cleaned away",
    cleanPolygon([[0, 0], [2, 0], [4, 0], [4, 3], [0, 3]]).length === 4);
  check("a line is not a room", triangulate([[0, 0], [4, 0], [8, 0]]).length === 0);
  check("two points are not a room", triangulate([[0, 0], [4, 0]]).length === 0);
  // A bow tie crosses itself and has no honest triangulation.
  check("a self-crossing shape is refused",
    triangulate([[0, 0], [4, 4], [4, 0], [0, 4]]).length === 0);
}

// --- a point that is genuinely inside ---
{
  // The L's bounding-box centre is [3, 3], which sits exactly on its notch.
  const p = interiorPoint(ELL);
  check("an L-shaped room gets an interior point", pointInPolygon(p, ELL),
    `${p.map((v) => v.toFixed(2)).join(", ")}`);
  for (const deg of [7, 30, 63]) {
    const turned = turn(ELL, deg);
    check(`and still does at ${deg}deg`, pointInPolygon(interiorPoint(turned), turned));
  }
  check("a hexagon too", pointInPolygon(interiorPoint(HEX), HEX));
}

// --- a very thin room still works ---
{
  const corridor: Vec2[] = [[0, 0], [12, 0], [12, 0.9], [0, 0.9]];
  check("a corridor is covered", covers(corridor));
  check("and has an interior point", pointInPolygon(interiorPoint(corridor), corridor));
}

if (failures > 0) {
  console.error(`\nTESSELLATE: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  "TESSELLATE OK - squares, Ls, Ts and hexagons are covered exactly at every angle, triangles stay inside and face one way, degenerate shapes are refused, and an L-shaped room yields a point actually inside it",
);
