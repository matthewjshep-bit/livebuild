/**
 * Reshaping an existing tour must not quietly gut it.
 *
 * `layoutFromFootprint` mints fresh room ids, and a tour's photographs and
 * condition grades are both keyed by room id. So the obvious implementation -
 * lay the rooms out again, keep the result - orphans every photograph and
 * detaches every grade, with no error and a plan that looks *better* than
 * before. That is the failure this file exists to catch.
 */

import { reshapeProperty, reshapeRooms } from "../src/lib/plan/reshape";
import type { Property, Room } from "../src/lib/schema";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const square = (x: number, y: number): [number, number][] => [
  [x, y],
  [x + 3, y],
  [x + 3, y + 3],
  [x, y + 3],
];

function room(id: string, label: string, level = 0, x = 0, y = 0): Room {
  return { id, label, polygon: square(x, y), ceilingHeight: 2.7, level };
}

console.log("\nidentities survive the new geometry");

// What the tour has now, and what the packer hands back: same rooms, new ids,
// new positions, and in a different order because the arrangement pass reorders.
const existing = [
  room("r1", "Kitchen", 0, 0, 0),
  room("r2", "Bedroom 1", 0, 4, 0),
  room("r3", "Bedroom 2", 0, 8, 0),
  room("outside", "Outside", 0, 0, 9),
];
const laid = [
  room("r1", "Bedroom 2", 0, 20, 20),
  room("r2", "Kitchen", 0, 30, 20),
  room("r3", "Bedroom 1", 0, 40, 20),
  room("r4", "Outside", 0, 20, 40),
];

const { rooms, added, dropped } = reshapeRooms(existing, laid);

check("every room keeps the id it had", rooms.every((r) => existing.some((e) => e.id === r.id && e.label === r.label)));
check("nothing is reported added", added.length === 0, added.join(","));
check("nothing is reported dropped", dropped.length === 0, dropped.join(","));
check("the new geometry is the one kept", rooms.find((r) => r.label === "Kitchen")?.polygon[0][0] === 30);
check("ids are still unique", new Set(rooms.map((r) => r.id)).size === rooms.length);

// The reorder is the trap: matching by position rather than by label would give
// Bedroom 2 the Kitchen's id, so the kitchen photographs would show a bedroom.
check("the id follows the label, not the position", rooms.find((r) => r.label === "Bedroom 2")?.id === "r3");
check("and the outside room keeps its own id", rooms.find((r) => r.label === "Outside")?.id === "outside");

console.log("\nduplicate labels still pair one-to-one");

const twins = [room("a", "Bedroom"), room("b", "Bedroom"), room("c", "Bedroom")];
const twinsLaid = [room("x", "Bedroom"), room("y", "Bedroom"), room("z", "Bedroom")];
const paired = reshapeRooms(twins, twinsLaid);
check("three identical labels keep three distinct ids", new Set(paired.rooms.map((r) => r.id)).size === 3);
check("and they are the original three", paired.rooms.every((r) => ["a", "b", "c"].includes(r.id)));
check("none is reported dropped", paired.dropped.length === 0);

console.log("\nthe same label on another floor is another room");

const stacked = [room("down", "Bathroom", 0), room("up", "Bathroom", 1)];
const stackedLaid = [room("n1", "Bathroom", 1), room("n2", "Bathroom", 0)];
const byLevel = reshapeRooms(stacked, stackedLaid);
check("level 1 keeps the upstairs id", byLevel.rooms.find((r) => r.level === 1)?.id === "up");
check("level 0 keeps the downstairs id", byLevel.rooms.find((r) => r.level === 0)?.id === "down");

console.log("\nphotographs and grades come through");

const property = {
  id: "house",
  label: "A House",
  plan: { scaleRef: { px: 1, meters: 0.3048 }, rooms: existing, openings: [] },
  nodes: [
    { id: "n1", roomId: "r1", photo: "idb:a", position: [0, 0] as [number, number], heading: 0 },
    { id: "n2", roomId: "r3", photo: "idb:b", position: [8, 0] as [number, number], heading: 0 },
    { id: "n3", roomId: "outside", photo: "idb:c", position: [0, 9] as [number, number], heading: 0 },
  ],
  condition: { r1: { cabinets: "dated" }, r3: { flooring: "good" } },
  site: { lat: 37.2, lon: -122.0, planXBearing: 90 },
} as unknown as Property;

const result = reshapeProperty(property, { rooms: laid, openings: [] }, 117);
const ids = new Set(result.property.plan.rooms.map((r) => r.id));

check("every viewpoint still resolves to a room", result.property.nodes.every((n) => ids.has(n.roomId)));
check("the kitchen photo is still in the kitchen", result.property.plan.rooms.find((r) => r.id === result.property.nodes[0].roomId)?.label === "Kitchen");
check("the exterior photo is still outside", result.property.plan.rooms.find((r) => r.id === result.property.nodes[2].roomId)?.label === "Outside");
check("every graded room still exists", Object.keys(result.property.condition ?? {}).every((id) => ids.has(id)));
check("the grades are the same grades", (result.property.condition as Record<string, Record<string, string>>).r1.cabinets === "dated");
check("no viewpoint was moved or dropped", result.property.nodes.length === 3);
check("the plan's new bearing is recorded", result.property.site?.planXBearing === 117);
check("but the site is still the same place", result.property.site?.lat === 37.2);

console.log("\na room the layout could not place is kept, not lost");

// If the new layout omits a room, its photographs would otherwise point at
// nothing. It keeps its old geometry instead.
const short = reshapeProperty(property, { rooms: laid.filter((r) => r.label !== "Outside"), openings: [] });
const shortIds = new Set(short.property.plan.rooms.map((r) => r.id));
check("the unplaced room is reported", short.dropped.includes("Outside"), short.dropped.join(","));
check("but it is still in the plan", shortIds.has("outside"));
check("so its photograph still resolves", short.property.nodes.every((n) => shortIds.has(n.roomId)));

console.log("\na genuinely new room is allowed in");

const extra = reshapeRooms(existing, [...laid, room("r9", "Garage")]);
check("it is reported as added", extra.added.includes("Garage"));
check("and it keeps the minted id", extra.rooms.find((r) => r.label === "Garage")?.id === "r9");
check("without colliding with an inherited one", new Set(extra.rooms.map((r) => r.id)).size === extra.rooms.length);

console.log(`\nverdict: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
