/**
 * Handing the layout to something else, without giving up the invariant.
 *
 * `packIntoFootprint` fills the building's outline exactly, and that is not a
 * tidiness preference: doorways are derived from which rooms touch, so a gap
 * left inside the building is a room nobody can reach - invisible until someone
 * walks the tour and hits a dead end.
 *
 * A `PackPlan` lets an outside source choose the arrangement. This checks that
 * it cannot buy that control at the cost of the invariant: for every valid
 * partition, the rooms still tile the outline exactly and are still rooms.
 */
import {
  type PackPlan,
  type Rect,
  packIntoFootprint,
  prepareFootprint,
  rectArea,
  validatePackPlan,
} from "../src/lib/plan/footprint";
import { M_PER_FT } from "../src/lib/units";
import type { Room } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

/** A plain rectangle, and an L. Between them, the shapes houses actually are. */
const ringRect: Array<[number, number]> = (() => {
  // 12m x 9m about a point, as lat/lon so prepareFootprint's own path is used.
  const lat = 47.6, lon = -122.3;
  const dLat = (m: number) => m / 111_320;
  const dLon = (m: number) => m / (Math.cos((lat * Math.PI) / 180) * 111_320);
  return [
    [lat, lon], [lat, lon + dLon(12)], [lat + dLat(9), lon + dLon(12)], [lat + dLat(9), lon],
  ];
})();

const LABELS = ["Living Room", "Kitchen", "Bedroom", "Bathroom", "Hallway", "Office"];

const footprint = prepareFootprint(ringRect);
check("a plain house decomposes to one rectangle", footprint.rects.length === 1, `${footprint.rects.length}`);

const areaOf = (room: Room) => {
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
};
const outlineArea = footprint.rects.reduce((s, r) => s + rectArea(r), 0);

const tiles = (rooms: Room[], where: string) => {
  const covered = rooms.reduce((s, r) => s + areaOf(r), 0);
  check(`${where}: the rooms fill the outline exactly`,
    Math.abs(covered - outlineArea) < 0.01, `covered ${covered.toFixed(3)} of ${outlineArea.toFixed(3)}`);
  check(`${where}: every room is placed`, rooms.length === LABELS.length, `${rooms.length}`);
  check(`${where}: no room is narrower than a room`,
    rooms.every((r) => {
      const xs = r.polygon.map((p) => p[0]); const ys = r.polygon.map((p) => p[1]);
      return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) > 2.0;
    }));
};

// --- The derivation still works when nothing is supplied ---
tiles(packIntoFootprint(LABELS, footprint), "derived");

// --- Several very different partitions, all of which must tile ---
const partitions: Array<[string, PackPlan]> = [
  ["two rows of three", { rows: [[[0, 1, 2], [3, 4, 5]]] }],
  ["three rows of two", { rows: [[[0, 1], [2, 3], [4, 5]]] }],
  ["uneven rows", { rows: [[[0, 1, 2], [3, 4], [5]]] }],
  ["lopsided", { rows: [[[0], [1, 2, 3, 4, 5]]] }],
  ["reversed", { rows: [[[5, 4, 3], [2, 1, 0]]] }],
];

for (const [name, plan] of partitions) {
  check(`${name} validates`, validatePackPlan(plan, LABELS, footprint.rects));
  tiles(packIntoFootprint(LABELS, footprint, 0, plan), name);
}

// --- The arrangement is actually honoured, not merely tolerated ---
const across = packIntoFootprint(LABELS, footprint, 0, { rows: [[[0, 1, 2], [3, 4, 5]]] });
const down = packIntoFootprint(LABELS, footprint, 0, { rows: [[[3, 4, 5], [0, 1, 2]]] });
const yOf = (rooms: Room[], i: number) => Math.min(...rooms[i].polygon.map((p) => p[1]));
check(
  "swapping the rows moves the rooms",
  yOf(across, 0) < yOf(across, 3) && yOf(down, 0) > yOf(down, 3),
  `${yOf(across, 0)} / ${yOf(down, 0)}`,
);

// --- Bad partitions are refused, and the packer falls back rather than breaking ---
const bad: Array<[string, PackPlan]> = [
  // Six rooms across a twelve-metre rectangle is two metres each, under
  // MIN_ROOM_DIM. Refusing it is the point: the outline would still be filled
  // exactly, with rooms nobody could stand in.
  ["a row too crowded to be rooms", { rows: [[[0, 1, 2, 3, 4, 5]]] }],
  ["a room used twice", { rows: [[[0, 0, 1], [2, 3, 4]]] }],
  ["a room left out", { rows: [[[0, 1], [2, 3]]] }],
  ["an index off the end", { rows: [[[0, 1, 2], [3, 4, 99]]] }],
  ["an empty row", { rows: [[[0, 1, 2, 3, 4, 5], []]] }],
  ["a rectangle with no rows", { rows: [[]] }],
  ["more rows than the rectangle is deep", { rows: [[[0], [1], [2], [3], [4], [5]]] }],
  ["the wrong number of rectangles", { rows: [[[0, 1, 2]], [[3, 4, 5]]] }],
];

for (const [name, plan] of bad) {
  check(`${name} is refused`, !validatePackPlan(plan, LABELS, footprint.rects));
  // And the packer still produces a whole house from it, by ignoring it.
  tiles(packIntoFootprint(LABELS, footprint, 0, plan), `falling back from ${name}`);
}

// --- A real, multi-rectangle outline behaves the same way ---
const lShape: Array<[number, number]> = (() => {
  const lat = 47.6, lon = -122.3;
  const dLat = (m: number) => m / 111_320;
  const dLon = (m: number) => m / (Math.cos((lat * Math.PI) / 180) * 111_320);
  return [
    [lat, lon], [lat, lon + dLon(14)], [lat + dLat(6), lon + dLon(14)],
    [lat + dLat(6), lon + dLon(7)], [lat + dLat(12), lon + dLon(7)], [lat + dLat(12), lon],
  ];
})();
const lFoot = prepareFootprint(lShape);
if (lFoot.rects.length >= 2) {
  const perRect: number[][] = lFoot.rects.map(() => []);
  LABELS.forEach((_, i) => perRect[i % lFoot.rects.length].push(i));
  // One row per rectangle, holding whatever landed in it.
  const planL: PackPlan = { rows: perRect.map((items) => [items]) };
  if (validatePackPlan(planL, LABELS, lFoot.rects)) {
    const rooms = packIntoFootprint(LABELS, lFoot, 0, planL);
    const covered = rooms.reduce((s, r) => s + areaOf(r), 0);
    const total = lFoot.rects.reduce((s, r) => s + rectArea(r), 0);
    check("an L-shaped house tiles too", Math.abs(covered - total) < 0.01,
      `${covered.toFixed(3)} of ${total.toFixed(3)}`);
  }
}

// --- Published rectangle order is the order the packer uses ---
const sorted = [...footprint.rects].every(
  (r, i, all) => i === 0 || rectArea(all[i - 1]) >= rectArea(r),
);
check("rects are published largest first", sorted);

console.log(
  failures === 0
    ? `PACK PLAN OK - ${partitions.length} partitions each tile the outline exactly; ${bad.length} bad ones are refused and fall back`
    : `PACK PLAN BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
