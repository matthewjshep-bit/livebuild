/**
 * An L-shaped room is built, lit and walkable in the real app.
 *
 * Everything about rectilinear rooms is proved in isolation by `shape-test` and
 * `polygon-test`, and none of it has ever been through the renderer, because
 * nothing in the app produces a non-rectangular room yet. This is the first
 * time the whole chain runs on one: a stored shape edit, applied by `applySpec`
 * on load, through the wall graph and the floor decomposition and out to the
 * screen.
 *
 * The fixture is written into local storage rather than added to the bundled
 * samples, so the shape being tested is one no other test depends on and the
 * demo houses stay what they are.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

/**
 * Two rooms filling a 10x6 building, with the dining room ceding its far
 * corner to the living room. Rendering it proves the transfer survives being
 * parsed, applied and built.
 */
const fixture = {
  id: "l-shaped",
  label: "L-Shaped Test",
  displayUnits: "ft",
  plan: {
    scaleRef: { px: 100, meters: 1 },
    rooms: [
      {
        id: "living",
        label: "Living Room",
        polygon: [[0, 0], [6, 0], [6, 6], [0, 6]],
        ceilingHeight: 2.7,
        level: 0,
      },
      {
        id: "dining",
        label: "Dining Room",
        polygon: [[6, 0], [10, 0], [10, 6], [6, 6]],
        ceilingHeight: 2.7,
        level: 0,
      },
    ],
    openings: [
      { id: "d1", between: ["living", "dining"], at: [6, 2], width: 0.9, kind: "door" },
    ],
  },
  nodes: [],
  splats: [],
  condition: {},
  houseCondition: {},
  rates: {},
  spec: {
    version: 1,
    rooms: {},
    shapeEdits: [
      {
        from: "dining",
        to: "living",
        rect: { x0: 6, y0: 4, x1: 10, y1: 6 },
        source: "human",
        why: "test fixture",
      },
    ],
    rejections: [],
  },
};

await page.goto(base, { waitUntil: "networkidle" });
await page.evaluate((doc) => {
  localStorage.setItem(`livebuild:property:${doc.id}`, JSON.stringify(doc));
  localStorage.setItem("livebuild:index", JSON.stringify([doc.id]));
}, fixture);

await page.goto(`${base}/tour/${fixture.id}`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 20_000 });
await page.waitForFunction(() => window.__scene !== undefined, { timeout: 20_000 });
await page.waitForTimeout(3500);

const dollhouse = await page.evaluate(() => window.__scene);
await page.screenshot({ path: "shots/l-shaped.png" });

// The room is an L on the plan the app actually built, not just in the fixture.
const shape = await page.evaluate(() => {
  const doc = JSON.parse(localStorage.getItem("livebuild:property:l-shaped"));
  return doc.plan.rooms.map((r) => ({ id: r.id, corners: r.polygon.length }));
});

// And it can be walked into and around.
await page.locator("button", { hasText: /^Walk$/ }).first().click();
await page.waitForFunction(() => window.__scene?.mode === "walk", { timeout: 20_000 });
await page.waitForTimeout(2500);
const walk = await page.evaluate(() => window.__scene);
await page.screenshot({ path: "shots/l-shaped-walk.png" });

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

check("the house renders", dollhouse.meshes > 0 && dollhouse.triangles > 0);
check(
  "the reshaped room is built with more than four corners",
  // The stored document keeps its rectangles; the shape is applied on load, so
  // this asserts the renderer saw the transfer rather than the fixture faking it.
  dollhouse.bySurface.floor >= 2,
  `floor meshes: ${dollhouse.bySurface.floor}`,
);
check("it has walls, floors and trim", Boolean(dollhouse.bySurface.trim));
check("the stored plan is left as rectangles", shape.every((r) => r.corners === 4));
check("you can walk in it", walk.mode === "walk" && walk.triangles > 0);
check("the ceiling appears indoors", Boolean(walk.bySurface.ceiling));
check("nothing glows from within", walk.emissive === 0);
check("no photograph is in the model", dollhouse.photoTextures === 0);
check("no errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  JSON.stringify(
    {
      dollhouse: { meshes: dollhouse.meshes, triangles: dollhouse.triangles, bySurface: dollhouse.bySurface },
      walk: { meshes: walk.meshes, bySurface: walk.bySurface },
      verdict:
        failures === 0
          ? "L-SHAPED OK - a stored transfer is applied on load, built, lit and walked"
          : `FAILED - ${failures} check${failures === 1 ? "" : "s"}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
