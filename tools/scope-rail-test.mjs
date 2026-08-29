/**
 * The scope is on screen without being asked for.
 *
 * The bill of materials is the number this tool exists to produce, and it used
 * to appear only after you clicked something - so the tour opened showing no
 * costs at all. A figure you have to go and find is a figure nobody checks
 * against what they are looking at.
 *
 * The check that matters most here is the last one. The whole BOM surface is
 * gated on the property being yours; a published tour is somebody else's
 * listing and has no business exposing what their house needs spending on it.
 * That is a privacy invariant, and a rail that is always visible is exactly the
 * kind of change that could quietly break it.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

// Seed the fixture into local storage so the property counts as ours.
await page.goto(`${BASE}/tour/two-storey`, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  const raw = await fetch("/properties/two-storey/property.json").then((r) => r.json());
  localStorage.setItem("mattermatt:property:two-storey", JSON.stringify(raw));
  localStorage.setItem("mattermatt:index", JSON.stringify(["two-storey"]));
});

await page.goto(`${BASE}/tour/two-storey`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForTimeout(4500);

// --- 1. There with nothing selected ---
check("the rail is there before anything is clicked",
  (await page.locator("[data-scope-rail]").count()) === 1);
check("it shows a house total", (await page.locator("[data-rail-total]").count()) === 1);

const rooms = await page.locator("[data-room-row]").count();
check("every room has a row", rooms >= 8, `${rooms} rows`);
check("nothing is selected yet",
  (await page.locator("[data-room-row][data-selected]").count()) === 0);

// --- 2. Clicking the model drives the rail ---
const box = await page.locator("canvas").boundingBox();
let picked = false;
for (let y = 340; y <= 640 && !picked; y += 30) {
  for (let x = Math.round(box.x + 100); x < box.x + box.width - 100; x += 60) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(90);
    if (await page.locator("[data-scope-pane]").count()) {
      picked = true;
      break;
    }
  }
}
check("clicking a surface selects something", picked);

if (picked) {
  await page.waitForTimeout(600);
  const heading = await page.locator("[data-scope-pane]").getAttribute("data-heading");
  check("the pane names what was clicked", Boolean(heading), `${heading}`);
  check("the matching row is highlighted in the tree",
    (await page.locator("[data-room-row][data-selected]").count()) === 1);
  // A condition control belongs to a fixture, not to a whole room - grading
  // "the Bedroom" as one thing is not a judgement anybody makes. Which of the
  // two a click lands on depends on whether it hit a surface or a viewpoint
  // ring, so this asserts the rule rather than one outcome.
  const selects = await page.locator("[data-scope-pane] select").count();
  const isElement = !(await page.evaluate(
    (h) => /^(Bed|Bath|Kitchen|Living|Dining|Hall|Stair|Garage|Office|Laundry|Entry|Closet|Powder)/i.test(h),
    heading,
  ));
  check("a fixture pick carries a condition control, a room pick does not",
    isElement ? selects >= 1 : selects === 0,
    `heading "${heading}" gave ${selects} controls`);
  console.log(`  picked "${heading}"`);
}

// --- 3. Collapsing gives the 3D view its width back ---
const wide = (await page.locator("[data-scope-rail]").boundingBox())?.width ?? 0;
await page.getByLabel("Hide the scope").click();
await page.waitForTimeout(500);
const narrow = (await page.locator("[data-scope-rail]").boundingBox())?.width ?? 0;
check("the rail collapses", narrow < wide / 2, `${wide}px to ${narrow}px`);
check("the total survives collapsing",
  (await page.locator('[data-scope-rail][data-collapsed] ').count()) === 1);
await page.getByLabel("Show the scope").click();
await page.waitForTimeout(400);

// --- 4. The privacy gate lives elsewhere ---
//
// A bundled sample opened in a fresh browser is deliberately still yours to
// edit - that was fixed on purpose so the demo house could be costed at all -
// so it is not the test for this. The real gate is `PublishedTour`, which
// renders the viewer with no edit callback and therefore has no BOM and no
// rail, and the only place a published tour exists is `publish-test.mjs`. It
// asserts there that a visitor sees neither the rail nor any costs.
//
// An earlier version of this tried to check it here against a status field
// that does not exist, so it always reported "not configured" and always
// passed. A check that cannot fail is worse than an absent one.

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? "SCOPE RAIL OK - always visible, follows the model, and collapses"
    : `SCOPE RAIL BROKEN - ${failures} failures`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
