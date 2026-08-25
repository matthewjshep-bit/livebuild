/**
 * The scope pane follows what you are looking at.
 *
 * Three behaviours, and the third is the one that makes it a tool rather than a
 * readout: clicking a surface shows that item, walking into a room shows that
 * room, and changing a grade moves the money without leaving the model.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";

/** A local property with a plausible condition set, so there is scope to show. */
const seed = async (page) => {
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const doc = await (await fetch("/properties/demo-house/property.json")).json();
    const by = {
      "Living Room": { floor: "dated", walls: "dated", ceiling: "fair", trim: "dated", lighting: "dated" },
      Kitchen: { floor: "poor", walls: "dated", ceiling: "fair", trim: "dated", lighting: "dated",
                 cabinets: "dated", counters: "poor", appliances: "poor", backsplash: "poor" },
      Hallway: { floor: "dated", walls: "dated", ceiling: "good", trim: "fair", lighting: "dated" },
      Bedroom: { floor: "poor", walls: "dated", ceiling: "fair", trim: "fair", lighting: "dated" },
      Bathroom: { floor: "poor", walls: "poor", ceiling: "dated", trim: "poor", lighting: "dated",
                  vanity: "poor", bathing: "dated", toilet: "poor", tile: "poor" },
    };
    const condition = {};
    for (const r of doc.plan.rooms) if (by[r.label]) condition[r.id] = by[r.label];
    localStorage.setItem("mattermatt:property:demo-house",
      JSON.stringify({ ...doc, condition, houseCondition: {}, rates: {} }));
    localStorage.setItem("mattermatt:index", JSON.stringify(["demo-house"]));
  });
};

/**
 * Read the pane itself, not the page.
 *
 * An earlier version counted lines of `innerText` and read the header's buttons
 * instead - the same mistake that once made a test report a model failure that
 * was really a scraping failure.
 */
const paneState = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector("[data-scope-pane]");
    if (!pane) return null;
    return {
      heading: pane.getAttribute("data-heading"),
      total: Number(pane.getAttribute("data-total")),
      hasCondition: /CONDITION/i.test(pane.textContent ?? ""),
      lines: pane.textContent?.match(/@ \$/g)?.length ?? 0,
    };
  });

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await seed(page);

// --- 1. Clicking a surface in the dollhouse ---
await page.goto(`${base}/tour/demo-house`, { waitUntil: "networkidle" });
await page.waitForTimeout(4500);

let clicked = null;
for (let y = 380; y <= 640 && !clicked; y += 28) {
  for (let x = 360; x <= 940; x += 40) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(120);
    if (await page.evaluate(() => /Full scope/.test(document.body.innerText))) {
      clicked = await paneState(page);
      break;
    }
  }
}
await page.screenshot({ path: "shots/P1-pane-surface.png" });

// --- 2. Changing a grade moves the money, in place ---
let regraded = null;
if (clicked) {
  const before = clicked.total;
  const select = page.locator("select").first();
  const current = await select.inputValue();
  // To "good" specifically. Flooring triggers on both dated and poor, so
  // swapping between them is a no-op - the honest way to prove condition drives
  // cost is to grade something as needing nothing.
  await select.selectOption("good");
  await page.waitForTimeout(700);
  const after = await paneState(page);
  regraded = { before, after: after?.total ?? null, from: current };
  // Put it back so the walk-in check sees the seeded state.
  await select.selectOption(current);
  await page.waitForTimeout(400);
}

// --- 3. Walking into a room shows that room, unasked ---
const firstNode = await page.evaluate(() => {
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:demo-house"));
  return doc.nodes[0].id;
});
await page.goto(`${base}/tour/demo-house?node=${firstNode}`, { waitUntil: "networkidle" });
await page.waitForTimeout(5000);
const inside = await paneState(page);
await page.screenshot({ path: "shots/P2-pane-inside.png" });

// --- 4. A published tour must not expose costs to a visitor ---
// Simulated by the absence of a stored property: the viewer gets no editing
// callbacks, so no pane.
const visitor = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const visitorPage = await visitor.newPage();
await visitorPage.goto(`${base}/tour/demo-house`, { waitUntil: "networkidle" });
await visitorPage.waitForTimeout(3500);
const visitorSeesPane = await visitorPage.evaluate(() =>
  /Full scope|CONDITION/i.test(document.body.innerText),
);

const moved = regraded && regraded.after === 0 && regraded.before > 0;
const ok =
  !!clicked &&
  clicked.hasCondition &&
  moved &&
  !!inside &&
  errors.length === 0;

console.log(
  JSON.stringify(
    {
      clickedSurface: clicked,
      regraded,
      standingInARoom: inside,
      bundledViewerSeesPane: visitorSeesPane,
      errors: errors.slice(0, 3),
      verdict: ok
        ? `SCOPE PANE OK - clicking a surface shows "${clicked.heading}" with its condition, ` +
          `grading it good dropped $${regraded.before} to $${regraded.after}, and walking in shows "${inside.heading}"`
        : `FAILED - clicked=${!!clicked} moved=${moved} inside=${!!inside} errors=${errors.length}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ok ? 0 : 1);
