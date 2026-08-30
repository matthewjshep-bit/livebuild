/**
 * When a photograph is shown, and when the model is shown instead.
 *
 * The rule is small and entirely numeric, which is exactly why it is worth
 * pinning here rather than in a browser: a regression would not throw, it would
 * quietly stop putting photography in the walkthrough, or - worse - start
 * showing a shell from somewhere it tears.
 */
import {
  SHELL_MOUNT_M,
  TOUR_REACH_M,
  WALK_REACH_M,
  nodeEye,
  shellProximity,
} from "../src/lib/render/proximity";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const node = {
  position: [5, 4] as [number, number],
  eyeHeight: 1.5,
  parallaxBudget: 0.45,
};

const at = (x: number, y: number, z: number) => ({ x, y, z });
/** Distances go through `Math.hypot`, so the boundary cases land a rounding
 *  error either side of it rather than exactly on it. */
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const eye = nodeEye(node, 0);
const walkAt = (d: number) => shellProximity(node, 0, at(eye[0] + d, eye[1], eye[2]), WALK_REACH_M);

// --- Solid where it is honest ---
check("solid standing in it", near(walkAt(0), 1), `${walkAt(0)}`);
check(
  "solid out to the parallax budget",
  near(walkAt(node.parallaxBudget), 1),
  `${walkAt(node.parallaxBudget)}`,
);

// --- Gone before it tears ---
// 1.5m off-node was measured filling the frame with a smeared close-up. The
// fade must be over well before there.
check("gone by 1.5m", walkAt(1.5) === 0, `${walkAt(1.5)}`);
check("gone by the mount radius", walkAt(SHELL_MOUNT_M) === 0, `${walkAt(SHELL_MOUNT_M)}`);

// --- Monotone in between, so it fades rather than flickers ---
let monotone = true;
let previous = 2;
for (let d = 0; d <= 2; d += 0.05) {
  const value = walkAt(d);
  if (value > previous + 1e-9) monotone = false;
  previous = value;
}
check("fades monotonically with distance", monotone);

// --- Height counts, so a storey up is not standing in it ---
const upstairs = shellProximity(node, 0, at(eye[0], eye[1] + 3, eye[2]), WALK_REACH_M);
check("a storey up shows nothing", upstairs === 0, `${upstairs}`);

// --- A generous budget earns a wider fade than the floor ---
const generous = { ...node, parallaxBudget: 1.2 };
const wide = shellProximity(generous, 0, at(eye[0] + 1.5, eye[1], eye[2]), WALK_REACH_M);
check("a wide budget reaches past the floor", wide > 0, `${wide}`);

// --- The tour reaches further than a walker, and still lands solid ---
const tourFar = shellProximity(node, 0, at(eye[0] + 3, eye[1], eye[2]), TOUR_REACH_M);
check("the tour dissolves in from further out", tourFar > 0, `${tourFar}`);
check(
  "the tour reaches further than a walker",
  tourFar > walkAt(3),
  `${tourFar} vs ${walkAt(3)}`,
);
check(
  "the tour is solid on arrival",
  near(shellProximity(node, 0, at(...eye), TOUR_REACH_M), 1),
);

// --- The floor of a storey moves the eye with it ---
const upper = shellProximity(node, 3, at(eye[0], eye[1] + 3, eye[2]), WALK_REACH_M);
check("a node upstairs is solid from upstairs", near(upper, 1), `${upper}`);

console.log(
  failures === 0
    ? `SHELL PROXIMITY OK - solid to ${node.parallaxBudget}m, gone by ${Math.max(WALK_REACH_M, node.parallaxBudget * 2.5)}m on foot, ${TOUR_REACH_M}m on tour`
    : `SHELL PROXIMITY BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
