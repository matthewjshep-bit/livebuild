/**
 * A drawn plan is used as drawn, or refused with somewhere to look.
 *
 * This is the gate that lets a hand-drawn layout skip the packer entirely, so
 * it is the only thing standing between a drawing and the exact-fill invariant.
 * The failure it exists to prevent is silent: a gap left inside the building is
 * a room with no doorways into it, and nothing shows that until somebody walks
 * the tour and hits a dead end. Every case below is a shape somebody will
 * actually draw.
 */
import { checkDrawn, drawableBoundary, fitToBuilding } from "../src/lib/plan/drawn";
import { decompose, prepareFootprint } from "../src/lib/plan/footprint";
import { rectangle, signedArea } from "../src/lib/plan/geometry";

import type { Room, Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const room = (id: string, x: number, y: number, w: number, h: number, level = 0): Room => ({
  id,
  label: id,
  polygon: rectangle(x, y, w, h),
  ceilingHeight: 2.7,
  level,
});

/** The union of the accepted rooms, as area, to prove the partition is exact. */
const covered = (rooms: Room[]) =>
  rooms
    .flatMap((r) => decompose(r.polygon))
    .reduce((sum, r) => sum + (r.x1 - r.x0) * (r.y1 - r.y0), 0);

const RECT: Vec2[] = [[0, 0], [10, 0], [10, 6], [0, 6]];

// --- a drawing that tiles its outline is taken exactly as drawn ---
{
  const drawn = [room("a", 0, 0, 6, 6), room("b", 6, 0, 4, 3), room("c", 6, 3, 4, 3)];
  const result = checkDrawn(drawn, RECT, 0);
  check("a clean drawing is accepted", result.ok, result.ok ? "" : result.why);
  if (result.ok) {
    check("it covers the outline exactly", Math.abs(covered(result.rooms) - 60) < 1e-6,
      `${covered(result.rooms)}`);
    check("nothing was moved", result.snapped === 0, `${result.snapped}`);
    // The whole point: the user's sizes survive. The packer would have resized
    // these to typical areas and made the 6x6 room a bedroom-sized box.
    const a = result.rooms.find((r) => r.id === "a")!;
    check("the drawn size is kept", Math.abs(a.polygon[2][0] - 6) < 1e-9);
  }
}

// --- a hole in the middle is refused, and located ---
{
  // b stops 1m short of c, leaving a 4x1 strip belonging to nobody.
  const drawn = [room("a", 0, 0, 6, 6), room("b", 6, 0, 4, 2), room("c", 6, 3, 4, 3)];
  const result = checkDrawn(drawn, RECT, 0);
  check("a hole is refused", !result.ok);
  if (!result.ok) {
    check("the gap is located", result.gaps.length === 1, JSON.stringify(result.gaps));
    check("and merged into one rectangle",
      result.gaps.length === 1 &&
        Math.abs((result.gaps[0].x1 - result.gaps[0].x0) * (result.gaps[0].y1 - result.gaps[0].y0) - 4) < 1e-6,
      JSON.stringify(result.gaps));
    check("the reason names the area", /belongs to no room/.test(result.why), result.why);
  }
}

// --- two rooms on the same ground is refused ---
{
  const drawn = [room("a", 0, 0, 7, 6), room("b", 6, 0, 4, 6)];
  const result = checkDrawn(drawn, RECT, 0);
  check("an overlap is refused", !result.ok);
  if (!result.ok) check("the overlap is located", result.overlaps.length === 1,
    JSON.stringify(result.overlaps));
}

// --- drawing outside the building is refused ---
{
  const drawn = [room("a", 0, 0, 6, 6), room("b", 6, 0, 4, 6), room("shed", 10, 0, 3, 3)];
  const result = checkDrawn(drawn, RECT, 0);
  check("an overhang is refused", !result.ok);
  if (!result.ok) check("the overhang is located", result.overhangs.length >= 1,
    JSON.stringify(result.overhangs));
}

// --- nearly-touching walls are one wall, and the outline never moves ---
{
  // b is drawn 8cm short of a and 6cm over the right-hand boundary.
  const drawn = [room("a", 0, 0, 6, 6), room("b", 6.08, 0, 3.98, 6)];
  const result = checkDrawn(drawn, RECT, 0);
  check("a sloppy drawing is squared up and accepted", result.ok, result.ok ? "" : result.why);
  if (result.ok) {
    check("coordinates moved", result.snapped > 0);
    check("still exact after snapping", Math.abs(covered(result.rooms) - 60) < 1e-6,
      `${covered(result.rooms)}`);
    const b = result.rooms.find((r) => r.id === "b")!;
    const a = result.rooms.find((r) => r.id === "a")!;
    const bx = b.polygon.map((p) => p[0]);
    const ax = a.polygon.map((p) => p[0]);
    // The footprint wins: b was pulled back to the boundary, not the boundary out to b.
    check("the outline did not move", Math.abs(Math.max(...bx) - 10) < 1e-9, `${Math.max(...bx)}`);
    // Neither interior wall is privileged, so they meet at their mean rather
    // than one of them dragging the other. What matters is that they meet.
    check("the shared wall closed", Math.abs(Math.min(...bx) - Math.max(...ax)) < 1e-9,
      `${Math.max(...ax)} vs ${Math.min(...bx)}`);
  }
}

// --- an L-shaped outline is no harder than a rectangle ---
{
  // A 10x6 with a 4x3 bite out of the top right.
  const ell: Vec2[] = [[0, 0], [10, 0], [10, 3], [6, 3], [6, 6], [0, 6]];
  const drawn = [room("a", 0, 0, 6, 6), room("b", 6, 0, 4, 3)];
  const result = checkDrawn(drawn, ell, 0);
  check("an L-shaped house is accepted", result.ok, result.ok ? "" : result.why);
  if (result.ok) check("and covered exactly", Math.abs(covered(result.rooms) - 48) < 1e-6,
    `${covered(result.rooms)}`);

  // The same rooms in a rectangle would leave the bite uncovered.
  const wrong = checkDrawn(drawn, RECT, 0);
  check("the same drawing in a bigger outline is refused", !wrong.ok);
}

// --- an L-shaped room, which applyShapeEdits can produce ---
{
  const ellRoom: Room = {
    id: "a", label: "a", ceilingHeight: 2.7, level: 0,
    polygon: [[0, 0], [6, 0], [6, 3], [10, 3], [10, 6], [0, 6]],
  };
  const drawn = [ellRoom, room("b", 6, 0, 4, 3)];
  const result = checkDrawn(drawn, RECT, 0);
  check("a non-rectangular room is handled", result.ok, result.ok ? "" : result.why);
  if (result.ok) check("and still tiles exactly", Math.abs(covered(result.rooms) - 60) < 1e-6,
    `${covered(result.rooms)}`);
}

// --- storeys are independent ---
{
  const drawn = [
    room("g1", 0, 0, 6, 6), room("g2", 6, 0, 4, 6),
    room("u1", 0, 0, 10, 6, 1),
  ];
  const ground = checkDrawn(drawn, RECT, 0);
  const upper = checkDrawn(drawn, RECT, 1);
  check("the ground floor is judged alone", ground.ok, ground.ok ? "" : ground.why);
  check("the upper floor is judged alone", upper.ok, upper.ok ? "" : upper.why);
  if (ground.ok) check("and does not include the upstairs", ground.rooms.length === 2);
}

// --- an empty floor is a refusal, not a pass ---
{
  const result = checkDrawn([room("a", 0, 0, 6, 6)], RECT, 1);
  check("an empty floor is refused", !result.ok);
  if (!result.ok) check("and says so plainly", /Nothing is drawn/.test(result.why), result.why);
}

// --- the boundary is what the packer can build on, not the raw outline ---
{
  // A 12x8 house with a 1.0 x 1.4m porch. The porch is 15 sqft, under the
  // packer's 25 sqft floor, so it is dropped from `rects` while staying in
  // `outline`. Drawn against the raw outline it is a gap nobody can ever fill,
  // because it is smaller than the smallest room allowed - and Continue would
  // never enable on any house with a porch.
  const withPorch: Vec2[] = [
    [0, 0], [12, 0], [12, 8], [7, 8], [7, 9.4], [6, 9.4], [6, 8], [0, 8],
  ];
  const rects = decompose(withPorch).filter(
    (r) => (r.x1 - r.x0) * (r.y1 - r.y0) / (0.3048 * 0.3048) >= 25,
  );
  const footprint = {
    outline: withPorch,
    rects,
    areaSqft: 97.4 / (0.3048 * 0.3048),
    rotationDeg: 0,
    vertices: { raw: 8, simplified: 8 },
  };

  const boundary = drawableBoundary(footprint);
  check("a boundary is offered", boundary.ok, boundary.ok ? "" : boundary.why);
  if (boundary.ok) {
    check("it excludes the dropped porch",
      Math.abs(Math.abs(signedArea(boundary.outline)) - 96) < 1e-6,
      `${Math.abs(signedArea(boundary.outline))}`);
    check("and the clipping is explained", boundary.note !== null, `${boundary.note}`);

    // The whole point: one room filling the buildable ground is accepted.
    const drawn = [room("a", 0, 0, 12, 8)];
    check("a room filling it is accepted", checkDrawn(drawn, boundary.outline, 0).ok);
    // Against the raw outline the same drawing is an unfixable gap.
    check("the raw outline would have blocked forever", !checkDrawn(drawn, withPorch, 0).ok);
  }
}

// --- a footprint with nothing buildable is refused rather than drawn against ---
{
  const boundary = drawableBoundary({
    outline: [[0, 0], [1, 0], [1, 1], [0, 1]],
    rects: [],
    areaSqft: 10,
    rotationDeg: 0,
    vertices: { raw: 4, simplified: 4 },
  });
  check("an unbuildable footprint is refused", !boundary.ok);
}

// --- a mess of a drawing can be fitted to the building in one go ---
//
// The gate refuses a drawing that leaves a hole, and it is right to. But
// dragging rectangles until they exactly tile an irregular outline is not
// something a person can do - every nudge opens a gap on one side while closing
// another. A gate nobody can satisfy is a trap, so this is the way out: keep
// the arrangement, throw away the sizes, let the packer do what it has always
// done.
{
  const m = 1 / 111_320;
  const ring: Array<[number, number]> = [
    [0, 0], [0, 18 * m], [11 * m, 18 * m], [11 * m, 0],
  ].map(([a, b]) => [37 + a, -122 + b] as [number, number]);
  const fp = prepareFootprint(ring, undefined, 6);

  // Deliberately awful: overlapping, gapped, and one room off the building.
  const drawn = [
    room("a", 0, 0, 7, 5),
    room("b", 6, 0, 6, 4),
    room("c", 1, 6, 5, 5),
    room("d", 40, 40, 3, 3),
  ];
  const before = checkDrawn(drawn, fp.outline, 0);
  check("the mess is refused first", !before.ok);

  const fitted = fitToBuilding(drawn, fp, 0);
  check("but it can be fitted", fitted.ok, fitted.ok ? "" : fitted.why);
  if (fitted.ok) {
    const after = checkDrawn(fitted.rooms, fp.outline, 0);
    check("and the result passes the gate", after.ok, after.ok ? "" : after.why);
    check("every room survives", fitted.rooms.length === drawn.length,
      `${fitted.rooms.length} of ${drawn.length}`);
    check("with its own label", new Set(fitted.rooms.map((r) => r.label)).size === 4);
    // Ids are carried across, so photographs and grades keyed by room id live.
    check("and its own id", drawn.every((d) => fitted.rooms.some((r) => r.id === d.id)),
      fitted.rooms.map((r) => r.id).join(","));
    // The arrangement is kept: whatever was drawn topmost is still topmost.
    const topDrawn = [...drawn].sort((x, z) => x.polygon[0][1] - z.polygon[0][1])[0].id;
    const topFitted = [...fitted.rooms].sort((x, z) => x.polygon[0][1] - z.polygon[0][1])[0].id;
    check("and the arrangement is recognisably the one drawn", topDrawn === topFitted,
      `${topDrawn} vs ${topFitted}`);
  }
}

// --- fitting refuses rather than inventing rooms it was not given ---
{
  const m = 1 / 111_320;
  const ring: Array<[number, number]> = [
    [0, 0], [0, 18 * m], [11 * m, 18 * m], [11 * m, 0],
  ].map(([a, b]) => [37 + a, -122 + b] as [number, number]);
  const fp = prepareFootprint(ring, undefined, 6);
  const fitted = fitToBuilding([], fp, 0);
  check("an empty floor cannot be fitted", !fitted.ok);
}

if (failures > 0) {
  console.error(`\nDRAWN: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  "DRAWN OK - a drawing that tiles its outline is used at the sizes drawn, sloppy walls close onto each other while the outline stays put, and a hole, an overlap or an overhang is refused with somewhere to look",
);
