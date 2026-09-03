/**
 * Furniture stays inside its room and never blocks a door.
 *
 * The door rule is the one that matters. A sofa across the only doorway is the
 * most obviously wrong thing this could produce, and it would be wrong in the
 * dollhouse *and* in the walk graph, which routes people through that doorway.
 */
import { readFileSync } from "node:fs";

import { furnishRoom } from "../src/lib/model/furniture";
import { fixturesFor } from "../src/lib/model/fixtures";
import { piecesFor } from "../src/lib/model/staging";
import { EMPTY_ROOM_SPEC, type RoomSpec } from "../src/lib/spec/schema";
import { autoOpenings } from "../src/lib/plan/autolayout";
import { boundsOf } from "../src/lib/plan/geometry";
import { roomKind } from "../src/lib/plan/room-kind";
import { parseProperty } from "../src/lib/schema";
import type { Plan } from "../src/lib/schema";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const load = (path: string): Plan => {
  const doc = parseProperty(JSON.parse(readFileSync(path, "utf8")));
  const openings = doc.plan.openings.length ? doc.plan.openings : autoOpenings(doc.plan.rooms);
  return { ...doc.plan, openings };
};

const CLEARANCE = 0.75;
let furnishedRooms = 0;
let totalPieces = 0;

for (const path of [
  "public/properties/demo-house/property.json",
  "public/properties/two-storey/property.json",
]) {
  const plan = load(path);

  for (const room of plan.rooms) {
    const pieces = furnishRoom(plan, room);
    if (pieces.length > 0) furnishedRooms++;
    totalPieces += pieces.length;

    const b = boundsOf(room.polygon);
    const width = b.x1 - b.x0;
    const depth = b.y1 - b.y0;

    const doors = plan.openings
      .filter((o) => o.kind !== "stairs" && o.between.includes(room.id))
      .map((o) => [o.at[0] - b.x0, o.at[1] - b.y0] as [number, number]);

    for (const piece of pieces) {
      for (const box of piece.boxes) {
        const [cx, cy, cz] = box.center;
        const [sx, sy, sz] = box.size;

        check(
          `${room.label}: ${piece.kind} has positive size`,
          sx > 0 && sy > 0 && sz > 0,
          `${sx.toFixed(2)} x ${sy.toFixed(2)} x ${sz.toFixed(2)}`,
        );
        check(
          `${room.label}: ${piece.kind} is inside the room`,
          cx - sx / 2 > -0.15 && cx + sx / 2 < width + 0.15 &&
          cz - sz / 2 > -0.15 && cz + sz / 2 < depth + 0.15,
          `box at ${cx.toFixed(2)},${cz.toFixed(2)} in a ${width.toFixed(1)}x${depth.toFixed(1)} room`,
        );
        check(
          `${room.label}: ${piece.kind} sits on or above the floor`,
          cy - sy / 2 > -0.01,
        );

        // The rule that matters.
        for (const door of doors) {
          const nx = Math.max(cx - sx / 2, Math.min(door[0], cx + sx / 2));
          const nz = Math.max(cz - sz / 2, Math.min(door[1], cz + sz / 2));
          check(
            `${room.label}: ${piece.kind} does not block a doorway`,
            Math.hypot(door[0] - nx, door[1] - nz) >= CLEARANCE - 0.01,
            `${Math.hypot(door[0] - nx, door[1] - nz).toFixed(2)}m from a door`,
          );
        }
      }
    }
  }
}

check("rooms actually got furnished", furnishedRooms >= 6, `${furnishedRooms} rooms`);

// Same house twice must give the same furniture; a room that rearranged itself
// between renders would read as instability rather than variety.
{
  const plan = load("public/properties/demo-house/property.json");
  const room = plan.rooms.find((r) => roomKind(r.label) === "living")!;
  const a = JSON.stringify(furnishRoom(plan, room));
  const b = JSON.stringify(furnishRoom(plan, room));
  check("furnishing is deterministic", a === b);
}

// A room too small for its furniture gets none, rather than a squeezed-in bed.
{
  const tiny: Plan = {
    scaleRef: { px: 1, meters: 0.3048 },
    openings: [],
    rooms: [
      {
        id: "t1",
        label: "Bedroom",
        polygon: [[0, 0], [1.5, 0], [1.5, 1.5], [0, 1.5]],
        ceilingHeight: 2.7,
        level: 0,
      },
    ],
  };
  check("a room too small gets no furniture", furnishRoom(tiny, tiny.rooms[0]).length === 0);
}

/**
 * The garage, which is where the door rule was not being enforced.
 *
 * Every other builder refuses to place a piece across a doorway; `garage` took
 * the doorways as an argument and never looked at them. It is the worst room to
 * miss - a car is the largest object the model places, and a garage commonly
 * has a side door onto a narrow wall.
 *
 * Two garages, differing only in width. The car is 1.8m wide and centred, so a
 * side door is 1.6m clear of it in a 5m bay and 0.6m from it in a 3m one -
 * either side of the 0.75m clearance every other room is held to.
 */
{
  const garageOfWidth = (width: number): Plan => ({
    scaleRef: { px: 1, meters: 0.3048 },
    rooms: [
      {
        id: "g1",
        label: "Garage",
        polygon: [[0, 0], [width, 0], [width, 6], [0, 6]],
        ceilingHeight: 2.7,
        level: 0,
      },
      // Something for the doorway to lead to, so it is a door and not a wall.
      {
        id: "g2",
        label: "Hallway",
        polygon: [[width, 0], [width + 3, 0], [width + 3, 6], [width, 6]],
        ceilingHeight: 2.7,
        level: 0,
      },
    ],
    openings: [
      { id: "o1", kind: "door", between: ["g1", "g2"], at: [width, 3], width: 0.9 },
    ],
  });

  const roomy = garageOfWidth(5);
  const narrow = garageOfWidth(3);
  check(
    "a garage with room beside the car still gets one",
    furnishRoom(roomy, roomy.rooms[0]).length > 0,
  );
  check(
    "and a garage whose side door the car would block gets none",
    furnishRoom(narrow, narrow.rooms[0]).length === 0,
  );
}

// --- what the photograph saw in the room gets built ---
//
// The reader was told to ignore contents outright, so a brick fireplace had
// no field to land in and a sofa's colour was never asked. Two things follow
// from asking: a fixture is placed where a fixture goes, and a furnishing is
// the colour it was seen.
{
  const living = {
    id: "living",
    label: "Living Room",
    polygon: [[0, 0], [6, 0], [6, 5], [0, 5]] as [number, number][],
    ceilingHeight: 2.7,
    level: 0,
  };
  const kitchen = {
    id: "kitchen",
    label: "Kitchen",
    polygon: [[6, 0], [10, 0], [10, 5], [6, 5]] as [number, number][],
    ceilingHeight: 2.7,
    level: 0,
  };
  const two: Plan = {
    scaleRef: { px: 1, meters: 0.3048 },
    rooms: [living, kitchen],
    openings: [{ id: "d", kind: "door", between: ["living", "kitchen"], at: [6, 2.5], width: 0.9 }],
  };
  const withFireplace: RoomSpec = {
    ...EMPTY_ROOM_SPEC,
    fixtures: [{ id: "f", kind: "fireplace", material: "brick", colour: null }],
  };

  const pieces = fixturesFor(living, withFireplace, two);
  const fire = pieces.find((p) => p.kind === "fireplace");
  check("a read fireplace is built", Boolean(fire));
  if (fire) {
    // The living room's east wall is the one it shares with the kitchen. A
    // chimney on a partition is a chimney in the middle of the house.
    const xs = fire.boxes.map((b) => b.center[0]);
    check("and it stands on an outside wall, not the one shared with the kitchen",
      Math.max(...xs) < 6 - 0.5, `max x ${Math.max(...xs).toFixed(2)} of a 6m room`);
    check("in brick", fire.boxes.some((b) => b.colour === "#8b4a3a"), fire.boxes.map((b) => b.colour).join(", "));
    check("with a firebox darker than its surround", fire.boxes.some((b) => b.colour === "#1e1a17"));
  }

  const withSofa: RoomSpec = {
    ...EMPTY_ROOM_SPEC,
    furnishings: [{ id: "s", kind: "sofa", colour: "#3a2a1e", material: "leather" }],
  };
  const sofa = furnishRoom(two, living, withSofa).find((p) => p.kind === "sofa");
  check("the sofa is the colour the photograph saw", Boolean(sofa) && sofa!.boxes.some((b) => b.colour === "#3a2a1e"),
    sofa?.boxes.map((b) => b.colour).join(", "));
  check("and leather is less matte than the default", Boolean(sofa) && sofa!.boxes.some((b) => b.finish && b.finish.roughness < 0.7));

  // A read fridge means the generic slab must not also stand there.
  const withFridge: RoomSpec = {
    ...EMPTY_ROOM_SPEC,
    fixtures: [{ id: "r", kind: "fridge", material: "stainless steel", colour: null }],
  };
  const staged = piecesFor(two, kitchen, true, withFridge);
  check("a read fridge replaces the generic one", !staged.some((p) => p.kind === "fridge"),
    staged.map((p) => p.kind).join(", "));
}

console.log(
  failures === 0
    ? `FURNITURE OK - ${totalPieces} pieces across ${furnishedRooms} rooms, all inside their room and clear of every doorway - the garage included; a read fireplace stands on an outside wall and a read sofa keeps its colour`
    : `FURNITURE BROKEN - ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
