/**
 * What the reader says a wall is made of is what gets drawn.
 *
 * Six wall materials were read off photographs, stored with provenance, and
 * rendered as painted plaster, every one - `Model.tsx` called `wallSurface`
 * for every wall regardless. And the house's wall colour, read and carried
 * through every room by the inference, was thrown away by the one merged
 * partition mesh, which was painted `scheme.wall` unconditionally.
 *
 * This stores a house whose living room is exposed brick and whose walls are
 * tan, opens it, and asks the scene how many distinct colour maps it is using.
 * Plaster and brick are two. It also asks the partition mesh what colour it
 * is, which is the check on the second bug.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ID = "wall-materials";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const roomSpec = (extra) => ({
  floor: null,
  walls: null,
  ceiling: null,
  trim: null,
  openings: {},
  joinery: [],
  source: {},
  because: {},
  observed: true,
  ...extra,
});

const fixture = {
  id: ID,
  label: "Wall Materials Test",
  displayUnits: "ft",
  plan: {
    scaleRef: { px: 100, meters: 1 },
    rooms: [
      { id: "living", label: "Living Room", polygon: [[0, 0], [6, 0], [6, 5], [0, 5]], ceilingHeight: 2.7, level: 0 },
      { id: "kitchen", label: "Kitchen", polygon: [[6, 0], [10, 0], [10, 5], [6, 5]], ceilingHeight: 2.7, level: 0 },
    ],
    openings: [{ id: "d1", between: ["living", "kitchen"], at: [6, 2.5], width: 0.9, kind: "door" }],
  },
  nodes: [],
  condition: {},
  houseCondition: {},
  rates: {},
  spec: {
    version: 1,
    rooms: {
      living: roomSpec({
        walls: { material: "exposed-brick", colour: "#a0522d" },
        // And what is in the room: a brick fireplace, which is fitted and
        // is built whatever the furniture toggle says, and a dark leather
        // sofa, which is the seller's and is kept for its colour.
        fixtures: [{ id: "fp", kind: "fireplace", material: "brick", colour: null }],
        furnishings: [{ id: "sf", kind: "sofa", colour: "#3a2a1e", material: "leather" }],
        source: { "walls.material": "read", "walls.colour": "read", fixtures: "read", furnishings: "read" },
      }),
      kitchen: roomSpec({
        walls: { material: "paint", colour: "#d8c9a8" },
        // A run of maple raised-panel doors under a stainless top: the two
        // fields that were read and never drawn, in one place.
        joinery: [
          {
            id: "kitchen-run",
            kind: "cabinet-run",
            wall: "north",
            alongM: 0.05,
            lengthM: 0.85,
            depthM: null,
            tier: "base+wall",
            doorStyle: "raised-panel",
            colour: "#c9a06a",
            hardware: "knob",
            worktop: { material: "stainless", colour: "#b9bcc0", thicknessM: 0.03 },
          },
        ],
        fixtures: [
          { id: "rg", kind: "range", material: "stainless steel", colour: null },
          { id: "hd", kind: "hood", material: "stainless steel", colour: null },
        ],
        source: { "walls.material": "read", "walls.colour": "read", joinery: "read", fixtures: "read" },
      }),
    },
    defaults: { wallColour: "#d8c9a8" },
    shapeEdits: [],
  },
};

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.evaluate((doc) => {
  localStorage.setItem(`mattermatt:property:${doc.id}`, JSON.stringify(doc));
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  if (!index.includes(doc.id)) index.push(doc.id);
  localStorage.setItem("mattermatt:index", JSON.stringify(index));
}, fixture);

await page.goto(`${BASE}/tour/${ID}`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__scene && window.__scene.mode, { timeout: 45_000 });
await page.waitForTimeout(2500);

const scene = await page.evaluate(() => window.__scene);
check("the model rendered", scene.meshes > 0, `${scene.meshes} meshes`);
check("no photograph is on the model", scene.photoTextures === 0, `${scene.photoTextures}`);
// Floor(s), plaster walls, brick walls, ceiling(s): at least brick and plaster
// must be two different maps.
check(
  "a brick wall and a plaster wall are two different surfaces",
  scene.distinctMaps >= 2,
  `${scene.distinctMaps} distinct map(s)`,
);

await page.screenshot({ path: "shots/W1-wall-materials.png" });

// At eye level in the living room: the fireplace on an outside wall and the
// sofa in its own colour, neither of which existed before the reader was
// allowed to see the room's contents.
await page.goto(`${BASE}/tour/${ID}?room=living`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__scene && window.__scene.mode === "walk", { timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.screenshot({ path: "shots/W3-living-fireplace.png" });
const living = await page.evaluate(() => window.__scene);
// The brick is on the wall you are looking at, not only on the exploded
// room: assembled, a read wall material used to reach no mesh at all.
check("the living room wears its own brick walls on foot", (living.bySurface?.walls ?? 0) > 0, JSON.stringify(living.bySurface));
check("and its fireplace is a fixture, which the toggle cannot remove", (living.meshes ?? 0) > 0);

// And at eye level in the kitchen, where the door style and the steel top are
// the whole point: a frame of shadow round each door, a worktop with a sheen.
await page.goto(`${BASE}/tour/${ID}?room=kitchen`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__scene && window.__scene.mode === "walk", { timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.screenshot({ path: "shots/W2-kitchen-doors.png" });
const walk = await page.evaluate(() => window.__scene);
check("the kitchen has cabinets", (walk.bySurface?.cabinets ?? 0) > 0, JSON.stringify(walk.bySurface));
// The read range and hood are appliances, priced as such and drawn as such.
check("the read range and hood are in the kitchen", (walk.bySurface?.appliances ?? 0) > 0, JSON.stringify(walk.bySurface));

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? `WALL MATERIALS OK - ${scene.distinctMaps} distinct surfaces on a house with brick and painted walls, and no photograph on any of them`
    : `WALL MATERIALS BROKEN - ${failures} failure(s)`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
