/**
 * Turning a real compass bearing into the plan's own frame.
 *
 * Three conventions meet here and two of them are mirrored against each other,
 * which makes this the single easiest thing in the codebase to get silently
 * backwards. Nothing throws when it is wrong; a house simply faces the other
 * way, and every house faces *some* way, so it looks fine.
 *
 * - The footprint is projected with +x east and **+y south**.
 * - `planXBearing` is the compass bearing of plan +x, set to 90 + rotationDeg.
 * - `TourNode.heading` runs clockwise from plan +y.
 */
import { compassToPlanHeading } from "../src/lib/listing/pose";
import { bearingToPlanHeading, planFromBearing } from "../src/lib/model/sun";
import { headingToPlanDir } from "../src/lib/plan/geometry";
import type { Site } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;
const nearDir = (a: readonly [number, number], b: readonly [number, number]) =>
  near(a[0], b[0], 1e-9) && near(a[1], b[1], 1e-9);

// --- An unrotated building: plan +x is east, so plan +y is south. ---
const square: Site = { lat: 47.6, lon: -122.3, planXBearing: 90 };

check("east is plan +x", nearDir(planFromBearing(square, 90), [1, 0]), `${planFromBearing(square, 90)}`);
check("south is plan +y", nearDir(planFromBearing(square, 180), [0, 1]), `${planFromBearing(square, 180)}`);
check("north is plan -y", nearDir(planFromBearing(square, 0), [0, -1]), `${planFromBearing(square, 0)}`);
check("west is plan -x", nearDir(planFromBearing(square, 270), [-1, 0]), `${planFromBearing(square, 270)}`);

// The projection is +y south, so a heading of 0 - which points along plan +y -
// is looking south, not north. Getting this backwards is the classic error.
check("heading 0 looks south", near(bearingToPlanHeading(square, 180), 0), `${bearingToPlanHeading(square, 180)}`);
check("heading 90 looks east", near(bearingToPlanHeading(square, 90), 90), `${bearingToPlanHeading(square, 90)}`);
check("heading 180 looks north", near(bearingToPlanHeading(square, 0), 180), `${bearingToPlanHeading(square, 0)}`);
check("heading 270 looks west", near(bearingToPlanHeading(square, 270), 270), `${bearingToPlanHeading(square, 270)}`);

// --- A rotated building. This is where a pinned planXBearing goes wrong. ---
//
// 78 degrees is the `concord-house` fixture's own rotation, so this is the
// live case rather than an invented one.
const turned: Site = { lat: 42.46, lon: -71.35, planXBearing: 90 + 78 };

check(
  "the plan's own +x axis is its bearing",
  nearDir(planFromBearing(turned, turned.planXBearing), [1, 0]),
  `${planFromBearing(turned, turned.planXBearing)}`,
);
check(
  "a rotated building does not answer like an unrotated one",
  !near(bearingToPlanHeading(turned, 0), bearingToPlanHeading(square, 0)),
  "rotation was ignored",
);
check(
  "the rotation shows up exactly once",
  near(
    ((bearingToPlanHeading(turned, 0) - bearingToPlanHeading(square, 0)) % 360 + 360) % 360,
    78,
  ),
  `${bearingToPlanHeading(turned, 0)} vs ${bearingToPlanHeading(square, 0)}`,
);

// --- Round trip: a bearing to a heading and back to the same direction. ---
let roundTripped = true;
for (const site of [square, turned]) {
  for (let bearing = 0; bearing < 360; bearing += 15) {
    const viaHeading = headingToPlanDir(bearingToPlanHeading(site, bearing));
    const direct = planFromBearing(site, bearing);
    if (!nearDir(viaHeading, direct)) roundTripped = false;
  }
}
check("bearing → heading → direction agrees with bearing → direction", roundTripped);

// --- The room-frame lookalike is genuinely different, and must stay labelled. ---
check(
  "the room-frame converter matches only an unrotated plan",
  near(compassToPlanHeading(0), bearingToPlanHeading(square, 0)) &&
    !near(compassToPlanHeading(0), bearingToPlanHeading(turned, 0)),
  `room-frame ${compassToPlanHeading(0)}, square ${bearingToPlanHeading(square, 0)}, turned ${bearingToPlanHeading(turned, 0)}`,
);

console.log(
  failures === 0
    ? "BEARINGS OK - compass to plan space holds for a squared and a rotated building, and the room-frame converter is not mistaken for it"
    : `BEARINGS BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
