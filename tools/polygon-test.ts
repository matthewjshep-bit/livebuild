/**
 * An L-shaped room is built as an L.
 *
 * Every site that used to assume a room was a rectangle failed the same way:
 * silently, with a plausible answer. Walls were drawn straight across the
 * notch, the floor spilled past them, the skirting ran through every doorway,
 * the perimeter came back short, and standing in the notch put you "in" a room
 * you were not in. Nothing threw; the house was just wrong.
 *
 * So this asserts the L specifically, against a room whose real numbers are
 * known by construction. A rectangle is a four-edge rectilinear polygon, so
 * every one of these checks also passes on the old shape - which is what makes
 * it safe to run over the bundled samples too.
 */
import {
  roomIsRectilinear,
  wallsForLevel,
} from "../src/lib/model/walls";
import { subtractRects } from "../src/lib/model/stairs";
import { roomAt } from "../src/lib/model/collide";
import { decompose } from "../src/lib/plan/footprint";
import { area, pointInPolygon, wallSegmentsForRoom } from "../src/lib/plan/geometry";
import { takeoffForRoom } from "../src/lib/bom/takeoff";
import { rectangle } from "../src/lib/plan/autolayout";
import { M_PER_FT } from "../src/lib/units";
import type { Plan, Room, Vec2 } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/**
 * An 8x6 room with a 3x2 bite taken out of its far corner.
 *
 *   (0,0) ┌───────────────┐ (8,0)
 *         │               │
 *         │               ├──── (8,4)
 *         │        (5,4)  │
 *         └───────────────┘
 *   (0,6)            (5,6)
 *
 * Area 48 - 6 = 42. Perimeter 8+4+3+2+5+6 = 28.
 */
const L: Vec2[] = [
  [0, 0],
  [8, 0],
  [8, 4],
  [5, 4],
  [5, 6],
  [0, 6],
];

const lRoom: Room = {
  id: "l",
  label: "Living Room",
  polygon: L,
  ceilingHeight: 2.7,
  level: 0,
};

/** The room filling the bite, so the storey is still a complete partition. */
const bite: Room = {
  id: "bite",
  label: "Kitchen",
  polygon: rectangle(5, 4, 3, 2),
  ceilingHeight: 2.7,
  level: 0,
};

const plan: Plan = {
  scaleRef: { px: 100, meters: 1 },
  rooms: [lRoom, bite],
  openings: [
    { id: "d1", between: ["l", "bite"], at: [6.5, 4], width: 0.9, kind: "door" },
  ],
};

// --- the shape itself ---
check("the fixture is rectilinear", roomIsRectilinear(L));
check("polygon area is 42", near(area(L), 42), `got ${area(L)}`);

// --- floors: decompose covers the room exactly, and nothing else ---
const pieces = decompose(L);
const pieceArea = pieces.reduce((s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
check("decompose covers the whole floor", near(pieceArea, 42), `got ${pieceArea}`);
check("decompose needs more than one rectangle", pieces.length > 1, `got ${pieces.length}`);
check(
  "no floor piece leaves the polygon",
  pieces.every((r) =>
    pointInPolygon([(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2], L),
  ),
);
// The bite is the neighbour's floor, and must not be covered twice.
check(
  "the notch is not floored by this room",
  !pieces.some((r) => r.x0 >= 5 - 1e-9 && r.y0 >= 4 - 1e-9 && r.x1 <= 8 + 1e-9),
);
check(
  "subtractRects still returns each piece untouched with no holes",
  near(
    pieces.flatMap((r) => subtractRects(r, [])).reduce(
      (s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0),
      0,
    ),
    42,
  ),
);

// --- walls follow the outline, including the return into the notch ---
const walls = wallsForLevel(plan, 0).filter((w) => !w.header);
const runsAlongX = walls.filter((w) => Math.abs(w.angleDeg) < 45);
const runsAlongY = walls.filter((w) => Math.abs(w.angleDeg) >= 45);
check("walls were built", walls.length > 0);
// The two edges that only exist because the room is an L: the 3m return at
// y=4 and the 2m return at x=5.
// Summed, not taken as one piece: the doorway is in the middle of this return,
// so it is correctly built as two runs either side of it.
const notchReturnM = runsAlongX
  .filter((w) => near(w.center[1], 4, 0.2))
  .reduce((s, w) => s + w.length, 0);
check(
  "walls cover the notch's horizontal return, less its doorway",
  notchReturnM > 2 && notchReturnM < 2.5,
  `got ${notchReturnM.toFixed(2)}m across ${runsAlongX.filter((w) => near(w.center[1], 4, 0.2)).length} runs; expected ~3 - 0.9 door + corner carry`,
);
check(
  "a wall runs along the notch's vertical return",
  runsAlongY.some((w) => near(w.center[0], 5, 0.2) && w.length > 1.4 && w.length < 2.6),
  runsAlongY.map((w) => `${w.center[0].toFixed(2)}@${w.length.toFixed(2)}`).join(" "),
);
// The failure this replaces: the notch filled in with wall because the room
// was built from its bounding box. Asked of the space itself rather than of any
// one wall, because the sweep now merges the L's south face and its
// neighbour's into a single building face - which is correct, and which a
// per-wall length test would read as the very bug it was written to catch.
const insideAWall = (x: number, y: number) =>
  walls.some((wall) => {
    const alongX = Math.abs(wall.angleDeg) < 45;
    const halfW = (alongX ? wall.length : wall.thickness) / 2;
    const halfD = (alongX ? wall.thickness : wall.length) / 2;
    return (
      x >= wall.center[0] - halfW &&
      x <= wall.center[0] + halfW &&
      y >= wall.center[1] - halfD &&
      y <= wall.center[1] + halfD
    );
  });
check("the notch is open floor, not walled over", !insideAWall(6.5, 5));
check("the middle of the L is open floor", !insideAWall(2, 2));
// Clear of the doorway, which is centred at x=6.5 and 0.9 wide.
check("the shared return really is solid wall beside its door", insideAWall(5.4, 4));
check("and open where the door is", !insideAWall(6.5, 4));

// --- skirting follows the outline and stops at the doorway ---
const segments = wallSegmentsForRoom(lRoom, plan.openings);
const skirtingM = segments.reduce(
  (s, seg) => s + Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]),
  0,
);
check("skirting follows the real perimeter, less the door", near(skirtingM, 28 - 0.9, 1e-6),
  `got ${skirtingM.toFixed(3)}`);
check(
  "every skirting segment is axis-aligned",
  segments.every(
    (seg) =>
      Math.abs(seg.a[0] - seg.b[0]) < 1e-9 || Math.abs(seg.a[1] - seg.b[1]) < 1e-9,
  ),
);

// --- the takeoff measures the same room ---
const takeoff = takeoffForRoom(plan, lRoom);
check(
  "takeoff perimeter is the polygon's, not the bounding box's",
  near(takeoff.perimeterLf, 28 / M_PER_FT, 1e-3),
  `got ${takeoff.perimeterLf.toFixed(2)}ft, bounding box would be ${(28 / M_PER_FT).toFixed(2)} vs ${(2 * (8 + 6)) / M_PER_FT}`,
);
check(
  "takeoff floor area is the polygon's",
  near(takeoff.floorSqft, 42 / (M_PER_FT * M_PER_FT), 1e-3),
  `got ${takeoff.floorSqft.toFixed(2)}`,
);
check(
  "skirting and takeoff agree on the same run",
  near(takeoff.baseboardLf, skirtingM / M_PER_FT, 1e-6),
  `model ${(skirtingM / M_PER_FT).toFixed(3)} vs takeoff ${takeoff.baseboardLf.toFixed(3)}`,
);

// --- you are only in the room when you are actually in it ---
check("a point inside the L is in the room", roomAt(plan, 0, 2, 2)?.id === "l");
check("a point in the long leg is in the room", roomAt(plan, 0, 7, 2)?.id === "l");
check(
  "a point in the notch is NOT in the room",
  roomAt(plan, 0, 6.5, 5)?.id !== "l",
  `got ${roomAt(plan, 0, 6.5, 5)?.id ?? "nothing"}`,
);
check("a point in the notch is in the neighbour", roomAt(plan, 0, 6.5, 5)?.id === "bite");

// --- one wall facing two rooms is still one wall ---
//
// The packer puts a two-room row against a single larger room constantly, and
// the greedy pairing this replaced could not describe it: the long wall paired
// with the first neighbour, marked itself used, and the second neighbour found
// nothing to pair with. Both then emitted *exterior* walls, 200mm thick, offset
// to either side of the same line - a doubled partition in the middle of the
// house, z-fighting with itself and culled by the dollhouse as though it faced
// outdoors.
const tJunction: Plan = {
  scaleRef: { px: 100, meters: 1 },
  rooms: [
    { id: "wide", label: "Living Room", polygon: rectangle(0, 0, 4, 6), ceilingHeight: 2.7, level: 0 },
    { id: "top", label: "Kitchen", polygon: rectangle(4, 0, 3, 3), ceilingHeight: 2.7, level: 0 },
    { id: "bot", label: "Bedroom", polygon: rectangle(4, 3, 3, 3), ceilingHeight: 2.7, level: 0 },
  ],
  openings: [],
};
const shared = wallsForLevel(tJunction, 0).filter(
  (w) => !w.header && Math.abs(w.angleDeg) >= 45 && Math.abs(w.center[0] - 4) < 0.3,
);
check(
  "a wall facing two rooms is never emitted as exterior",
  shared.every((w) => !w.exterior),
  shared
    .map((w) => `${w.exterior ? "EXT" : "int"}@x${w.center[0].toFixed(2)} len${w.length.toFixed(1)}`)
    .join(" "),
);
check(
  "and it is one partition, at interior thickness, covering the full height",
  shared.every((w) => Math.abs(w.thickness - 0.1) < 1e-9) &&
    shared.reduce((sum, w) => sum + w.length, 0) >= 6,
  shared.map((w) => `t${w.thickness} len${w.length.toFixed(2)}`).join(" "),
);

console.log(
  failures === 0
    ? "POLYGON OK - L-shaped rooms wall the notch, floor only their own area, skirt the real perimeter less doorways, are not stood in from outside, and one wall facing two rooms stays one partition"
    : `POLYGON FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
);
process.exit(failures === 0 ? 0 : 1);
