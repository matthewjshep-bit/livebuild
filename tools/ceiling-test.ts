/**
 * Ceilings, including the ones worth remembering a room for.
 *
 * A flat ceiling has to come out exactly as it always did - it is over every
 * room in every house already built, and a change there is a change everywhere.
 * Everything else is new geometry above head height, which is the hardest place
 * in a model to notice a mistake: nobody looks up in a screenshot, and a coffer
 * grid that does not tile leaves gaps you would only find by standing under it.
 *
 * So the panels are measured rather than looked at. A recessed panel and the
 * rails around it must together cover the room and overlap nowhere, which is
 * the one property that makes a coffered ceiling a ceiling rather than a set
 * of floating rectangles.
 */
import { ceilingParts } from "../src/lib/model/ceiling";
import { rectangle } from "../src/lib/plan/geometry";
import { CeilingSpec } from "../src/lib/spec/schema";

import type { Room } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

const H = 2.7;
const room = (w: number, d: number): Room => ({
  id: "r",
  label: "Living Room",
  polygon: rectangle(0, 0, w, d),
  ceilingHeight: H,
  level: 0,
});

/** Plan area of every part of a kind, and whether any two of them overlap. */
const survey = (parts: ReturnType<typeof ceilingParts>, kinds: string[]) => {
  const of = parts.filter((p) => kinds.includes(p.kind));
  const area = of.reduce((sum, p) => sum + p.size[0] * p.size[2], 0);
  let overlaps = false;
  for (let i = 0; i < of.length; i++) {
    for (let j = i + 1; j < of.length; j++) {
      const a = of[i];
      const b = of[j];
      const dx = Math.abs(a.center[0] - b.center[0]) - (a.size[0] + b.size[0]) / 2;
      const dz = Math.abs(a.center[2] - b.center[2]) - (a.size[2] + b.size[2]) / 2;
      const dy = Math.abs(a.center[1] - b.center[1]) - (a.size[1] + b.size[1]) / 2;
      if (dx < -1e-6 && dz < -1e-6 && dy < -1e-6) overlaps = true;
    }
  }
  return { area, overlaps, count: of.length };
};

// --- flat, which must not have changed ---
const flat = ceilingParts(room(5, 4), null, [], H);
check("a flat ceiling is one slab", flat.length === 1, `${flat.length} parts`);
check("covering the room", near(survey(flat, ["panel"]).area, 20, 1e-6));
check("at the ceiling height", near(flat[0].center[1] - flat[0].size[1] / 2, H, 1e-6));
check("and nothing hangs from it", flat.every((p) => p.kind === "panel"));

// A stairwell still takes a bite out of it.
const holed = ceilingParts(room(5, 4), null, [{ x0: 3, y0: 2, x1: 5, y1: 4 }], H);
check(
  "a stairwell is cut out of it",
  near(survey(holed, ["panel"]).area, 20 - 4, 1e-6),
  `${survey(holed, ["panel"]).area}`,
);

// --- beamed ---
const beamed = ceilingParts(
  room(5, 4),
  CeilingSpec.parse({ kind: "beamed", beams: { count: 4, axis: "x", widthM: 0.14, dropM: 0.2 } }),
  [],
  H,
);
const beams = beamed.filter((p) => p.kind === "beam");
check("beams are drawn", beams.length === 4, `${beams.length}`);
check(
  "they hang below the ceiling, not through it",
  beams.every((b) => b.center[1] + b.size[1] / 2 <= H + 1e-6 && b.center[1] - b.size[1] / 2 > H - 0.4),
  beams.map((b) => (b.center[1] + b.size[1] / 2).toFixed(2)).join(" "),
);
check(
  "they span the room and are evenly spaced",
  beams.every((b) => near(b.size[0], 5, 1e-6)) &&
    near(beams[1].center[2] - beams[0].center[2], beams[2].center[2] - beams[1].center[2], 1e-6),
);
check("the ceiling itself is still there", beamed.some((p) => p.kind === "panel"));
check("and beams do not overlap each other", !survey(beamed, ["beam"]).overlaps);

// Asking for more beams than fit gets as many as fit.
const crowded = ceilingParts(
  room(5, 4),
  CeilingSpec.parse({ kind: "beamed", beams: { count: 24, axis: "x" } }),
  [],
  H,
);
check(
  "a room cannot have more beams than it has room for",
  crowded.filter((p) => p.kind === "beam").length <= 8,
  `${crowded.filter((p) => p.kind === "beam").length}`,
);

// --- tray ---
const tray = ceilingParts(room(6, 5), CeilingSpec.parse({ kind: "tray" }), [], H);
const trayPanels = tray.filter((p) => p.kind === "panel");
check("a tray has a border and a raised centre", trayPanels.length > 1, `${trayPanels.length}`);
check(
  "the two together cover the room exactly",
  near(survey(tray, ["panel"]).area, 30, 1e-6),
  `${survey(tray, ["panel"]).area}`,
);
check("and do not overlap", !survey(tray, ["panel"]).overlaps);
check(
  "the centre is higher than the border",
  Math.max(...trayPanels.map((p) => p.center[1])) >
    Math.min(...trayPanels.map((p) => p.center[1])),
);
check("the step is closed", tray.filter((p) => p.kind === "side").length === 4);

// --- coffered ---
const coffered = ceilingParts(room(6, 5), CeilingSpec.parse({ kind: "coffered" }), [], H);
check("coffers are sunk", coffered.filter((p) => p.kind === "panel").length > 4);
check("with rails between them", coffered.filter((p) => p.kind === "rail").length > 0);
check(
  "panels and rails together cover the room",
  near(survey(coffered, ["panel", "rail"]).area, 30, 1e-4),
  `${survey(coffered, ["panel", "rail"]).area.toFixed(4)}`,
);
check(
  "and nothing overlaps anything",
  !survey(coffered, ["panel", "rail"]).overlaps,
);

// --- a room too small to set anything out in ---
const cupboard = ceilingParts(room(1.2, 1.0), CeilingSpec.parse({ kind: "tray" }), [], H);
check(
  "a cupboard gets a flat ceiling however it was described",
  cupboard.length === 1 && cupboard[0].kind === "panel",
  `${cupboard.length} parts`,
);

console.log(
  failures === 0
    ? "CEILING OK - flat is unchanged, beams hang below and space evenly, trays and coffers tile their room exactly with no overlap, and a cupboard stays flat"
    : `CEILING FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
);
process.exit(failures === 0 ? 0 : 1);
