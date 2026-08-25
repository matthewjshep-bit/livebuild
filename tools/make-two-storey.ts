/**
 * Generate the two-storey sample, reusing the demo house's photos.
 *
 * Written in TypeScript rather than alongside the Python asset generator so it
 * calls the real `autoOpenings`. Hand-authoring the doorways, or reimplementing
 * the adjacency rules in Python, would let the fixture drift from the rules the
 * app actually applies - which is exactly how this file was wrong the first
 * time: it shipped with no openings at all, on the assumption they were derived
 * on load. They are not; only the builder derives them.
 *
 *   npx tsx tools/make-two-storey.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { autoOpenings } from "../src/lib/plan/autolayout";
import type { Property, Room, TourNode, Vec2 } from "../src/lib/schema";

const OUT = "public/properties/two-storey";
const SRC = "/properties/demo-house";
const CEILING = 2.7;

const room = (
  id: string,
  label: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  level: number,
): Room => ({
  id,
  label,
  polygon: [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as Vec2[],
  ceilingHeight: CEILING,
  level,
});

const rooms: Room[] = [
  room("g_living", "Living Room", 0.0, 0.0, 5.5, 4.5, 0),
  room("g_kitchen", "Kitchen", 5.5, 0.0, 9.5, 4.5, 0),
  room("g_hall", "Hallway", 0.0, 4.5, 6.5, 6.2, 0),
  room("g_stairs", "Stairs", 6.5, 4.5, 9.5, 6.2, 0),
  // The upstairs stairwell shares the ground one's footprint - that overlap is
  // what joins the storeys.
  room("u_stairs", "Stairs", 6.5, 4.5, 9.5, 6.2, 1),
  room("u_landing", "Hallway", 0.0, 4.5, 6.5, 6.2, 1),
  room("u_bed", "Bedroom", 0.0, 0.0, 5.0, 4.5, 1),
  room("u_bath", "Bathroom", 5.0, 0.0, 9.5, 4.5, 1),
];

// Both stairwells and the upstairs landing are left unphotographed on purpose:
// that is the normal case, and the one that used to sever the tour.
const nodeSpecs: Array<[string, string, number, number, number, string]> = [
  ["n1", "g_living", 0.9, 0.9, 48.9, "living-01"],
  ["n2", "g_living", 5.0, 4.0, 229.5, "living-02"],
  ["n3", "g_kitchen", 9.0, 4.0, 219.8, "kitchen-01"],
  ["n4", "g_hall", 0.7, 5.3, 89.0, "hall-01"],
  ["n5", "u_bed", 0.8, 0.8, 48.4, "bedroom-01"],
  ["n6", "u_bath", 5.5, 0.8, 50.0, "bath-01"],
];

const nodes: TourNode[] = nodeSpecs.map(([id, roomId, x, y, heading, stem]) => ({
  id,
  roomId,
  position: [x, y] as Vec2,
  eyeHeight: 1.5,
  heading,
  pitch: 0,
  fovDeg: 78,
  photo: `${SRC}/photos/${stem}.jpg`,
  depth: `${SRC}/depth/${stem}.png`,
  parallaxBudget: 0.45,
  neighbors: [],
}));

const openings = autoOpenings(rooms);

const property: Property = {
  id: "two-storey",
  label: "Two-Storey Demo",
  displayUnits: "ft",
  plan: { scaleRef: { px: 1, meters: 0.3048 }, rooms, openings },
  nodes,
  splats: [],
  // Filled in once someone grades the property; the BOM treats an empty
  // map as 'nothing seen yet' rather than 'nothing needed'.
  condition: {},
  houseCondition: {},
  rates: {},
};

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/property.json`, JSON.stringify(property, null, 2));

const stairs = openings.filter((o) => o.kind === "stairs").length;
console.log(
  `wrote ${OUT}/property.json - ${rooms.length} rooms, ` +
    `${openings.length - stairs} doorways, ${stairs} stairs`,
);
