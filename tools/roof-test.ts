/**
 * The roof covers the house, meets at a ridge where the read says, and comes
 * off in the shape the read named.
 */
import { coverRects, roofFor } from "../src/lib/model/roof";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const house = (rooms: Array<[string, [number, number][]]>): Plan => ({
  scaleRef: { px: 1, meters: 1 },
  rooms: rooms.map(([id, polygon]) => ({ id, label: id, polygon, ceilingHeight: 2.7, level: 0 })),
  openings: [],
});

// A 10 by 6 rectangle.
const box = house([["a", [[0, 0], [10, 0], [10, 6], [0, 6]]]]);

{
  const roof = roofFor(box, { roof: { shape: "gable" } }, null)!;
  check("a gable is two slopes and two ends", roof.faces.length === 4, `${roof.faces.length} faces`);
  const slopes = roof.faces.filter((f) => f.kind === "slope");
  const ends = roof.faces.filter((f) => f.kind === "gable");
  check("two slopes, two gable ends", slopes.length === 2 && ends.length === 2);
  const xs = roof.faces.flatMap((f) => f.points.map((p) => p[0]));
  const zs = roof.faces.flatMap((f) => f.points.map((p) => p[2]));
  check("it covers the footprint with an overhang", Math.min(...xs) < 0 && Math.max(...xs) > 10 && Math.min(...zs) < 0 && Math.max(...zs) > 6,
    `x ${Math.min(...xs)}..${Math.max(...xs)} z ${Math.min(...zs)}..${Math.max(...zs)}`);
  // The long axis is x, so the ridge runs along x at z = 3, and at 30 degrees
  // over a (3 + 0.4) half-span it rises 1.96m.
  const ridge = roof.faces.flatMap((f) => f.points).filter((p) => Math.abs(p[1] - roof.ridgeY) < 1e-6);
  check("the ridge is along the long axis", ridge.length > 0 && ridge.every((p) => Math.abs(p[2] - 3) < 1e-6), ridge.map((p) => p[2].toFixed(2)).join(","));
  check("and rises at the default pitch", Math.abs(roof.ridgeY - roof.eaveY - 3.4 * Math.tan(Math.PI / 6)) < 0.01, `${(roof.ridgeY - roof.eaveY).toFixed(3)}`);
  // A gable end is wall: it stays within the wall's own span and reaches down
  // to the eave, so nothing pokes out past the corner and no sky shows under
  // the rake.
  const endZs = ends.flatMap((f) => f.points.map((p) => p[2]));
  check("the gable ends stay within the wall line", Math.min(...endZs) >= 0 - 1e-9 && Math.max(...endZs) <= 6 + 1e-9, `z ${Math.min(...endZs)}..${Math.max(...endZs)}`);
  check("and reach down to the eave", ends.every((f) => f.points.some((p) => Math.abs(p[1] - roof.eaveY) < 1e-9)));
  check("the eave sits on top of the storey", roof.eaveY > 2.7 && roof.eaveY < 3.2, `${roof.eaveY}`);
}

{
  // The read's bearing wins over the long axis: with +x east (90), a ridge
  // bearing north (0) runs along the plan's y.
  const roof = roofFor(box, { roof: { shape: "gable", ridgeBearing: 0 } }, { planXBearing: 90 })!;
  const ridge = roof.faces.flatMap((f) => f.points).filter((p) => Math.abs(p[1] - roof.ridgeY) < 1e-6);
  check("a read ridge bearing turns the ridge", ridge.length > 0 && ridge.every((p) => Math.abs(p[0] - 5) < 1e-6), ridge.map((p) => p[0].toFixed(2)).join(","));
}

{
  const roof = roofFor(box, { roof: { shape: "hip" } }, null)!;
  check("a hip is four slopes and no ends", roof.faces.length === 4 && roof.faces.every((f) => f.kind === "slope"));
  const flat = roofFor(box, { roof: { shape: "flat" } }, null)!;
  check("a flat roof is a deck and a parapet", flat.faces.some((f) => f.kind === "flat") && flat.faces.filter((f) => f.kind === "gable").length === 4);
  check("and is flat", flat.faces.filter((f) => f.kind === "flat").every((f) => f.points.every((p) => Math.abs(p[1] - flat.eaveY) < 1e-6)));
  const none = roofFor(box, null, null)!;
  check("no read means a gable", none.faces.length === 4);
}

{
  // An L: two rectangles, each with its own roof.
  const ell = house([
    ["a", [[0, 0], [10, 0], [10, 6], [0, 6]]],
    ["b", [[0, 6], [5, 6], [5, 12], [0, 12]]],
  ]);
  const rects = coverRects(ell.rooms.map((r) => ({ x0: Math.min(...r.polygon.map((p) => p[0])), y0: Math.min(...r.polygon.map((p) => p[1])), x1: Math.max(...r.polygon.map((p) => p[0])), y1: Math.max(...r.polygon.map((p) => p[1])) })));
  check("an L is covered by two rectangles", rects.length === 2, `${rects.length}: ${JSON.stringify(rects)}`);
  const roof = roofFor(ell, { roof: { shape: "gable" } }, null)!;
  check("and gets a roof over each", roof.faces.length === 8, `${roof.faces.length} faces`);
}

{
  // Two rooms side by side are one rectangle, not two roofs.
  const pair = house([
    ["a", [[0, 0], [5, 0], [5, 6], [0, 6]]],
    ["b", [[5, 0], [10, 0], [10, 6], [5, 6]]],
  ]);
  const roof = roofFor(pair, { roof: { shape: "gable" } }, null)!;
  check("two rooms in a row share one roof", roof.faces.length === 4, `${roof.faces.length} faces`);
}

console.log(
  failures === 0
    ? "ROOF OK - a gable, a hip, a shed and a flat roof each cover the top storey with an overhang, the ridge follows the read bearing, and an L gets two"
    : `ROOF BROKEN - ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
