/**
 * Generate the showcase sample: one house with every field the build can
 * now fill, so the live site always shows the current build quality.
 *
 * Nothing here is rendered geometry. It is the *data* a finished build
 * carries - a plan, photographs, the site with its frame, streets and
 * neighbours, what the map said of the outside, and what the photographs
 * said of every room and of the outside - and the renderer derives the rest
 * at view time. So the same file shows more with every deploy, which is the
 * point of having it: whatever ships, `/tour/showcase` is what it looks like.
 *
 * Reuses the demo house's photographs for the rooms' evidence panel; the
 * specs are authored to the house those photographs would belong to - maple
 * shaker kitchen on cherry, oak living room with a brick fireplace and a
 * dark leather sofa, grey lap siding under a shingled gable, a maple and a
 * pine in the garden. Validated with the app's own parser before it is
 * written, so a wrong field fails here and not on the live site.
 *
 *   npx tsx tools/make-showcase.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { autoOpenings } from "../src/lib/plan/autolayout";
import { planToLatLon } from "../src/lib/site/frame";
import { parseProperty } from "../src/lib/schema";
import type { Property, Room, TourNode, Vec2 } from "../src/lib/schema";

const OUT = "public/properties/showcase";
const PHOTOS = "/properties/demo-house/photos";
const CEILING = 2.7;

const room = (id: string, label: string, x0: number, y0: number, x1: number, y1: number): Room => ({
  id,
  label,
  polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Vec2[],
  ceilingHeight: CEILING,
  level: 0,
});

// A 10 by 10 single storey: living and kitchen across the front, a hall,
// two bedrooms and a bathroom behind.
const rooms: Room[] = [
  room("living", "Living Room", 0, 0, 6, 5),
  room("kitchen", "Kitchen", 6, 0, 10, 5),
  room("hall", "Hallway", 0, 5, 10, 6.5),
  room("primary", "Primary Bedroom", 0, 6.5, 4.5, 10),
  room("bedroom", "Bedroom", 4.5, 6.5, 7.5, 10),
  room("bath", "Bathroom", 7.5, 6.5, 10, 10),
];

const nodeSpecs: Array<[string, string, number, number, number, string]> = [
  ["n1", "living", 0.9, 0.9, 48.9, "living-01"],
  ["n2", "living", 5.2, 4.2, 229.5, "living-02"],
  ["n3", "kitchen", 9.2, 4.2, 219.8, "kitchen-01"],
  ["n4", "hall", 0.7, 5.75, 89, "hall-01"],
  ["n5", "primary", 0.8, 7.3, 48.4, "bedroom-01"],
  ["n6", "bath", 8, 7.3, 120, "bath-01"],
];
const nodes: TourNode[] = nodeSpecs.map(([id, roomId, x, y, heading, stem]) => ({
  id,
  roomId,
  position: [x, y] as Vec2,
  eyeHeight: 1.5,
  heading,
  pitch: 0,
  fovDeg: 78,
  photo: `${PHOTOS}/${stem}.jpg`,
  neighbors: [],
}));

/**
 * The site. A frame with no turn whose centre is the middle of the house,
 * so plan metres are metres east and south of that point; the streets and
 * the neighbours are authored in plan metres and projected back to the map
 * through the same inverse the tour uses forward, so they land where they
 * were drawn.
 */
const LAT = 47.6231;
const LON = -122.2969;
const frame = { centre: { lat: LAT, lon: LON }, rotationDeg: 0, offset: [-5, -5] as Vec2, scale: 1 };
const geo = (p: Vec2) => planToLatLon(frame, p);
const ring = (x0: number, y0: number, x1: number, y1: number) =>
  ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Vec2[]).map(geo);

const site = {
  lat: LAT,
  lon: LON,
  planXBearing: 90,
  frame,
  streets: [
    // Along the front, split at a junction like a real road.
    { name: "Maple Street", kind: "residential", ways: [[geo([-40, -12]), geo([5, -12])], [geo([5, -12]), geo([50, -12])]] },
    { name: "Oak Avenue", kind: "tertiary", ways: [[geo([24, -40]), geo([24, 40])]] },
  ],
  buildings: [
    { ring: ring(-18, 0, -10, 9), kind: null, levels: 2 },
    { ring: ring(15, -1, 21, 8), kind: null, heightM: 5 },
    { ring: ring(-4, -24, 6, -16), kind: null, levels: 1 },
    { ring: ring(-14, 14, -6, 22), kind: null, levels: 1 },
    // The house's own garage, on the lot.
    { ring: ring(11, 2, 14, 8), kind: "garage" },
  ],
  attribution: ["Map data © OpenStreetMap contributors (ODbL)"],
};

/** What the map said of the outside. The photographs' reading overrides its colours. */
const exterior = {
  storeys: 1,
  roof: { shape: "gable", ridgeBearing: 90, pitchDeg: 30, material: "asphalt shingle", colour: "#4a4744" },
  walls: { material: "wood siding", colour: "#9aa0a3" },
  frontDoorBearing: 350,
  garage: { bearing: 90, bays: 1 },
  source: "map",
  imageryDate: null,
  confidence: "high",
  attribution: ["Building outline © OpenStreetMap contributors (ODbL)"],
};

const read = (paths: string[]) => Object.fromEntries(paths.map((p) => [p, "read"]));
const inferred = (paths: string[]) => Object.fromEntries(paths.map((p) => [p, "inferred"]));

/** What the photographs said of each room, and of the outside. */
const spec = {
  version: 1,
  defaults: { trim: { baseboardM: 0.09, profile: "square", colour: "#f4f4f2" }, ceilingM: { "0": 2.7 }, wallColour: "#d8c9a8", ceilingColour: "#f6f5f2" },
  rooms: {
    living: {
      floor: { material: "wood", colour: "#c2a173" },
      walls: { material: "paint", colour: "#d8c9a8" },
      ceiling: { kind: "flat", colour: "#f6f5f2" },
      trim: { baseboardM: 0.09, profile: "square", colour: "#f4f4f2" },
      fixtures: [{ id: "living-fireplace", kind: "fireplace", material: "brick", colour: null }],
      furnishings: [
        { id: "living-sofa", kind: "sofa", colour: "#3a2a1e", material: "leather" },
        { id: "living-rug", kind: "rug", colour: "#8a7a66", material: "fabric" },
      ],
      source: read(["floor.material", "floor.colour", "walls.material", "walls.colour", "ceiling.colour", "trim.colour", "fixtures", "furnishings"]),
      observed: true,
    },
    kitchen: {
      floor: { material: "wood", colour: "#6b3f2a" },
      walls: { material: "paint", colour: "#e8e0cf" },
      ceiling: { kind: "flat", colour: "#f6f5f2" },
      trim: { baseboardM: 0.09, profile: "square", colour: "#f4f4f2" },
      joinery: [
        {
          id: "kitchen-run",
          kind: "cabinet-run",
          wall: "north",
          alongM: 0.05,
          lengthM: 0.85,
          depthM: null,
          tier: "base+wall",
          doorStyle: "shaker",
          colour: "#c9a06a",
          hardware: "bar",
          worktop: { material: "quartz", colour: "#e9e6df", thicknessM: 0.03 },
        },
      ],
      fixtures: [
        { id: "kitchen-range", kind: "range", material: "stainless steel", colour: null },
        { id: "kitchen-hood", kind: "hood", material: "stainless steel", colour: null },
        { id: "kitchen-fridge", kind: "fridge", material: "stainless steel", colour: null },
      ],
      source: read(["floor.material", "floor.colour", "walls.material", "walls.colour", "joinery", "fixtures"]),
      observed: true,
    },
    hall: {
      floor: { material: "wood", colour: "#c2a173" },
      walls: { material: "paint", colour: "#d8c9a8" },
      source: inferred(["floor.material", "floor.colour", "walls.colour"]),
      because: { "floor.material": "The living room and the kitchen it joins are both wood." },
      observed: false,
    },
    primary: {
      floor: { material: "carpet", colour: "#9c9083" },
      walls: { material: "paint", colour: "#cfd6d2" },
      furnishings: [{ id: "primary-bed", kind: "bed", colour: "#5a4a3a", material: "fabric" }],
      source: read(["floor.material", "floor.colour", "walls.colour", "furnishings"]),
      observed: true,
    },
    bedroom: {
      floor: { material: "carpet", colour: "#9c9083" },
      walls: { material: "paint", colour: "#d8c9a8" },
      source: inferred(["floor.material", "floor.colour", "walls.colour"]),
      observed: false,
    },
    bath: {
      floor: { material: "tile", colour: "#d9d4cc" },
      walls: { material: "tile", colour: "#e6e2da" },
      joinery: [
        { id: "bath-vanity", kind: "vanity", wall: "south", alongM: 0.1, lengthM: 0.5, tier: "base", doorStyle: "slab", colour: "#f2f0eb", hardware: "bar", worktop: { material: "quartz", colour: "#f4f2ee", thicknessM: 0.03 } },
      ],
      source: read(["floor.material", "floor.colour", "walls.material", "walls.colour", "joinery"]),
      observed: true,
    },
  },
  exterior: {
    siding: { material: "cedar lap siding", finish: "lap", colour: "#9aa0a3" },
    roof: { shape: "gable", material: "asphalt shingle", colour: "#4a4744" },
    trim: { colour: "#f4f2ec" },
    door: { colour: "#7a2e2a" },
    features: [
      { id: "outside-0", kind: "tree", material: "maple", colour: null, side: "left", alongStreet: false, size: "l" },
      { id: "outside-1", kind: "tree", material: "pine", colour: null, side: "right", alongStreet: false, size: "m" },
      { id: "outside-2", kind: "fence", material: "timber", colour: "#f0ede6", side: null, alongStreet: true, size: null },
      { id: "outside-3", kind: "porch", material: "concrete", colour: null, side: null, alongStreet: false, size: null },
      { id: "outside-4", kind: "driveway", material: "asphalt", colour: null, side: "left", alongStreet: false, size: null },
      { id: "outside-5", kind: "shrub", material: null, colour: null, side: "both", alongStreet: false, size: "s" },
      { id: "outside-6", kind: "hedge", material: null, colour: null, side: "front", alongStreet: true, size: null },
    ],
    source: read(["siding.material", "siding.finish", "siding.colour", "roof.material", "roof.colour", "trim.colour", "door.colour", "features"]),
    observed: true,
    notes: "Grey cedar lap siding under a dark asphalt gable; white trim; a dark red door; a mature maple to the left and a pine to the right; a white picket fence along the street.",
  },
};

const property = parseProperty({
  id: "showcase",
  label: "Showcase House",
  kind: "house",
  displayUnits: "ft",
  plan: { scaleRef: { px: 1, meters: 0.3048 }, rooms, openings: autoOpenings(rooms) },
  nodes,
  exteriorPhotos: [],
  condition: {},
  houseCondition: {},
  rates: {},
  site,
  exterior,
  spec,
} as unknown as Property);

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/property.json`, JSON.stringify(property, null, 2));
console.log(
  `wrote ${OUT}/property.json - ${property.plan.rooms.length} rooms, ${property.plan.openings.length} doorways, ` +
    `${property.nodes.length} photographs, ${property.site?.streets?.length ?? 0} streets, ${property.site?.buildings?.length ?? 0} buildings, ` +
    `${Object.values(property.spec?.rooms ?? {}).filter((r) => r.observed).length} rooms read, ${property.spec?.exterior?.features.length ?? 0} things outside`,
);
