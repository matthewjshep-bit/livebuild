/**
 * A room can change shape; the building cannot.
 *
 * The whole design rests on one invariant: a shape edit moves floor between two
 * rooms, so the outside of the house comes out identical whatever the rooms do
 * among themselves. If that ever stops being true the failure is close to
 * undetectable - the building silently grows or shrinks, and the exterior no
 * longer matches the outline the satellite gave, which is the one thing in this
 * model that was actually surveyed.
 *
 * The second failure this guards is worse because it is invisible from outside
 * as well: a transfer that leaves a gap between the rooms creates a void in the
 * middle of the house that nothing can reach. `packIntoFootprint` has a comment
 * about exactly that, and it is the reason nothing here is allowed to break its
 * exact fill.
 */
import { applyShapeEdits, exteriorFingerprint, MIN_ROOM_M } from "../src/lib/plan/shape";
import { outlineOf } from "../src/lib/plan/outline";
import { decompose } from "../src/lib/plan/footprint";
import { area, pointInPolygon } from "../src/lib/plan/geometry";
import { rectangle } from "../src/lib/plan/autolayout";
import { roomIsRectilinear } from "../src/lib/model/walls";
import type { Plan, Room, Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

// --- the outline primitive on its own ---
const single = outlineOf([{ x0: 0, y0: 0, x1: 4, y1: 3 }]);
check("one rectangle traces to four corners", single?.length === 4, `${single?.length}`);
check("with the winding every producer uses", (single && area(single) > 0) === true);

const ell = outlineOf([
  { x0: 0, y0: 0, x1: 4, y1: 2 },
  { x0: 0, y0: 2, x1: 2, y1: 4 },
]);
check("two rectangles meeting along an edge trace to an L", ell?.length === 6, `${ell?.length}`);
check("the L has the right area", ell !== null && near(area(ell), 8 + 4, 1e-6), `${ell && area(ell)}`);
check("and is rectilinear", ell !== null && roomIsRectilinear(ell));
check(
  "a rectangle set round-trips through decompose",
  ell !== null && near(decompose(ell).reduce((s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0), 0), 12, 1e-6),
);

// Two rectangles touching only at a corner have no single outline, and saying
// so is better than inventing one.
check(
  "a pinch point is refused rather than guessed at",
  outlineOf([
    { x0: 0, y0: 0, x1: 2, y1: 2 },
    { x0: 2, y0: 2, x1: 4, y1: 4 },
  ]) === null,
);

// --- transfers ---
const room = (id: string, label: string, x: number, y: number, w: number, h: number): Room => ({
  id,
  label,
  polygon: rectangle(x, y, w, h),
  ceilingHeight: 2.7,
  level: 0,
});

/** Two rooms filling a 10x6 building exactly. */
const base: Plan = {
  scaleRef: { px: 100, meters: 1 },
  rooms: [room("living", "Living Room", 0, 0, 6, 6), room("dining", "Dining Room", 6, 0, 4, 6)],
  openings: [],
};

const before = exteriorFingerprint(base, 0);
const beforeArea = base.rooms.reduce((s, r) => s + area(r.polygon), 0);

// The dining room cedes its bottom corner to the living room.
const good = applyShapeEdits(base, [
  { from: "dining", to: "living", rect: { x0: 6, y0: 4, x1: 10, y1: 6 }, source: "read", why: "" },
]);

check("a valid transfer is applied", good.applied === 1, JSON.stringify(good.rejections));
check("and nothing is rejected", good.rejections.length === 0);

const living = good.plan.rooms.find((r) => r.id === "living")!;
const dining = good.plan.rooms.find((r) => r.id === "dining")!;

check("the receiving room becomes an L", living.polygon.length === 6, `${living.polygon.length}`);
check("the donor becomes a rectangle again", dining.polygon.length === 4, `${dining.polygon.length}`);
check("both stay rectilinear", roomIsRectilinear(living.polygon) && roomIsRectilinear(dining.polygon));

check(
  "floor area is conserved exactly",
  near(good.plan.rooms.reduce((s, r) => s + area(r.polygon), 0), beforeArea, 1e-6),
  `${good.plan.rooms.reduce((s, r) => s + area(r.polygon), 0)} vs ${beforeArea}`,
);
check(
  "and the outside of the building is untouched",
  exteriorFingerprint(good.plan, 0) === before,
);
check(
  "the transferred ground now belongs to the receiver",
  pointInPolygon([8, 5] as Vec2, living.polygon) && !pointInPolygon([8, 5] as Vec2, dining.polygon),
);
check(
  "and no longer to the donor",
  !pointInPolygon([8, 5] as Vec2, dining.polygon),
);

// --- everything that must be refused ---
const rejected = (edit: Parameters<typeof applyShapeEdits>[1] extends (infer T)[] | null | undefined ? T : never) =>
  applyShapeEdits(base, [edit]);

const reachesOutside = rejected({
  from: "dining",
  to: "living",
  rect: { x0: 6, y0: 4, x1: 12, y1: 6 },
  source: "read",
  why: "",
});
check(
  "a piece reaching outside the building is refused",
  reachesOutside.applied === 0,
  reachesOutside.rejections[0]?.reason,
);

const notTouching = rejected({
  from: "living",
  to: "dining",
  rect: { x0: 0, y0: 0, x1: 2, y1: 2 },
  source: "read",
  why: "",
});
check(
  "a piece that does not touch the receiver is refused",
  notTouching.applied === 0,
  notTouching.rejections[0]?.reason,
);

const takesAll = rejected({
  from: "dining",
  to: "living",
  rect: { x0: 6, y0: 0, x1: 10, y1: 6 },
  source: "read",
  why: "",
});
check(
  "taking the whole of a room is refused",
  takesAll.applied === 0,
  takesAll.rejections[0]?.reason,
);

const leavesSliver = rejected({
  from: "dining",
  to: "living",
  rect: { x0: 6, y0: 0, x1: 8.5, y1: 6 },
  source: "read",
  why: "",
});
check(
  `leaving a room narrower than ${MIN_ROOM_M}m is refused`,
  leavesSliver.applied === 0,
  leavesSliver.rejections[0]?.reason,
);

const gone = rejected({
  from: "dining",
  to: "nowhere",
  rect: { x0: 6, y0: 4, x1: 10, y1: 6 },
  source: "read",
  why: "",
});
check("an edit naming a room that no longer exists is refused", gone.applied === 0);

check(
  "and every refusal says why",
  [reachesOutside, notTouching, takesAll, leavesSliver, gone].every(
    (r) => r.rejections.every((x) => x.reason.length > 0),
  ),
);

// --- nothing at all is a valid answer ---
check("no edits leaves the plan alone", applyShapeEdits(base, []).plan === base);
check("and so does an absent list", applyShapeEdits(base, null).plan === base);

console.log(
  failures === 0
    ? "SHAPE OK - a transfer reshapes both rooms, conserves the floor exactly, leaves the building's outline identical, and every impossible edit is refused with a reason"
    : `SHAPE FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
);
process.exit(failures === 0 ? 0 : 1);
