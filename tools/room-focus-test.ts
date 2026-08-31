/**
 * Looking at one room, and costing only that room.
 *
 * Two of these three would fail silently. A camera framed slightly wrong still
 * shows a house; a walker dropped in the wrong place still walks. But a room
 * priced with the house's total is a number somebody quotes, and it would be
 * wrong by the cost of a roof - so the costing rule is pinned hardest.
 */
import { buildBom } from "../src/lib/bom/build";
import { roomScope } from "../src/lib/bom/pickable";
import { blocked, collidersFor } from "../src/lib/model/collide";
import { frameRoom, walkStartFor } from "../src/lib/model/focus";
import { boundsOf } from "../src/lib/plan/autolayout";
import { layoutFromSpec } from "../src/lib/plan/autolayout";
import { pointInPolygon } from "../src/lib/plan/geometry";
import type { Plan } from "../src/lib/schema";
import { M_PER_FT } from "../src/lib/units";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const built = layoutFromSpec({
  rooms: [
    { label: "Living Room", level: 0 },
    { label: "Kitchen", level: 0 },
    { label: "Bathroom", level: 0 },
    { label: "Hallway", level: 0 },
    { label: "Stairs", level: 0 },
    { label: "Primary Bedroom", level: 1 },
    { label: "Bedroom 2", level: 1 },
    { label: "Stairs", level: 1 },
  ],
});
const plan: Plan = {
  scaleRef: { px: 1, meters: M_PER_FT },
  rooms: built.rooms,
  openings: built.openings,
};

const room = (label: string) => {
  const found = plan.rooms.find((r) => r.label === label);
  if (!found) throw new Error(`no room ${label}`);
  return found;
};

// --- Framing ---------------------------------------------------------------

for (const label of ["Living Room", "Bathroom", "Primary Bedroom"]) {
  const r = room(label);
  const framing = frameRoom(plan, r);
  const b = boundsOf(r.polygon);

  check(
    `${label}: the camera looks at the middle of the room`,
    Math.abs(framing.center[0] - (b.x0 + b.x1) / 2) < 1e-9 &&
      Math.abs(framing.center[2] - (b.y0 + b.y1) / 2) < 1e-9,
    `${framing.center}`,
  );
  check(`${label}: it looks above the floor, not at it`, framing.center[1] > 0);
  // Standing further off than the room is wide is what keeps the lens out of
  // the wall it is pointing at.
  check(
    `${label}: it stands outside the room`,
    framing.distance > Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2,
    `${framing.distance.toFixed(2)}m`,
  );
  check(`${label}: it looks down, not up`, framing.elevation > 0 && framing.elevation < Math.PI / 2);
}

const living = frameRoom(plan, room("Living Room"));
const bath = frameRoom(plan, room("Bathroom"));
check(
  "a large room is framed from further out than a small one",
  living.distance > bath.distance,
  `${living.distance.toFixed(2)} vs ${bath.distance.toFixed(2)}`,
);
check(
  "a tiny room does not put the camera inside its own walls",
  bath.distance >= 4.5,
  `${bath.distance.toFixed(2)}m`,
);

// An upstairs room is framed above a downstairs one, or the camera looks at
// the floor below through the one you asked for.
check(
  "an upstairs room is framed upstairs",
  frameRoom(plan, room("Primary Bedroom")).center[1] > living.center[1],
);

// --- Where a walker lands --------------------------------------------------

for (const label of ["Living Room", "Kitchen", "Bathroom", "Primary Bedroom"]) {
  const r = room(label);
  const start = walkStartFor(plan, r);

  check(`${label}: the walker starts on that room's storey`, start.level === r.level);
  check(
    `${label}: the walker starts inside the room`,
    pointInPolygon(start.position, r.polygon),
    `${start.position} not in ${label}`,
  );
  check(
    `${label}: the walker does not start inside a wall`,
    !blocked(collidersFor(plan, r.level), start.position[0], start.position[1]),
  );
  check(`${label}: the yaw is a real angle`, Number.isFinite(start.yaw));
}

// Facing down the length of the room rather than at the nearest wall. A room
// wider than it is deep should be faced along x.
const wide = plan.rooms.find((r) => {
  const b = boundsOf(r.polygon);
  return b.x1 - b.x0 > (b.y1 - b.y0) * 1.2;
});
if (wide) {
  const { yaw } = walkStartFor(plan, wide);
  // Camera looks down -Z; yaw about Y gives direction (-sin, 0, -cos).
  const dx = -Math.sin(yaw);
  const dy = -Math.cos(yaw);
  check(
    `${wide.label}: a wide room is faced along its length`,
    Math.abs(dx) > Math.abs(dy),
    `direction (${dx.toFixed(2)}, ${dy.toFixed(2)})`,
  );
}

// --- Costing, which is the one that would be quoted ------------------------

const condition: Record<string, Record<string, "poor" | "dated" | "good">> = {};
for (const r of plan.rooms) condition[r.id] = { floor: "poor", walls: "dated" };
const bom = buildBom(plan, condition, {}, { roof: "poor", hvac: "dated" });

check("the fixture actually has whole-house costs to confuse things with", bom.houseTotal > 0);
check("and room costs too", bom.rooms.some((r) => r.total > 0));

for (const r of bom.rooms) {
  const scope = roomScope(bom, r.roomId);
  check(`${r.label}: a scope is returned`, scope !== null);
  if (!scope) continue;

  check(`${r.label}: the total is the room's own`, scope.total === r.total, `${scope.total} vs ${r.total}`);
  check(
    `${r.label}: the total is not the house's`,
    bom.total === r.total || scope.total !== bom.total,
    `${scope.total} equals the house total ${bom.total}`,
  );
  check(
    `${r.label}: material and labour add up to the total`,
    Math.abs(scope.material + scope.labour - scope.total) < 0.01,
  );
  const lines = r.assemblies.flatMap((a) => a.lines);
  check(
    `${r.label}: no whole-house line leaks in`,
    lines.every((line) => !line.id.startsWith("house:")),
    lines.filter((l) => l.id.startsWith("house:")).map((l) => l.id).join(", "),
  );
  check(`${r.label}: the line count is the room's`, scope.lineCount === lines.length);
}

// The invariant that makes all of the above safe: rooms plus house is the house.
const roomSum = bom.rooms.reduce((sum, r) => sum + r.total, 0);
check(
  "every room's total plus the whole-house total is the house total",
  Math.abs(roomSum + bom.houseTotal - bom.total) < 0.01,
  `${roomSum.toFixed(2)} + ${bom.houseTotal.toFixed(2)} vs ${bom.total.toFixed(2)}`,
);
check(
  "the house carries costs no room does",
  bom.houseTotal > 0 && roomSum < bom.total,
  `rooms ${roomSum.toFixed(0)} of ${bom.total.toFixed(0)}`,
);

// Windows are counted per room and priced house-wide, so the room's own cost
// cannot include them. Carrying the count is what lets the view say so.
const glazed = bom.rooms.find((r) => r.takeoff.windowCount > 0);
if (glazed) {
  const scope = roomScope(bom, glazed.roomId)!;
  check(
    `${glazed.label}: the window count is carried so it can be explained`,
    scope.windowCount === glazed.takeoff.windowCount && scope.windowCount > 0,
    `${scope.windowCount}`,
  );
}

check("an unknown room has no scope", roomScope(bom, "nope") === null);
check("no room at all has no scope", roomScope(bom, null) === null);

console.log(
  failures === 0
    ? `ROOM FOCUS OK - ${plan.rooms.length} rooms framed and walkable, and each costs its own scope (rooms ${Math.round(roomSum)} + house ${Math.round(bom.houseTotal)} = ${Math.round(bom.total)})`
    : `ROOM FOCUS BROKEN - ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
