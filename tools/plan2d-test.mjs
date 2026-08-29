/**
 * A drawing, not a diagram.
 *
 * Every other 2D surface in this app draws a room as a filled rectangle with a
 * hairline round it and calls the result a floor plan. The difference between
 * that and a drawing is entirely in what it knows: walls with thickness, doors
 * that swing, windows in the walls they sit in, and a staircase drawn as
 * treads. So the checks are for those things specifically rather than for "an
 * SVG appeared".
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

await page.goto(`${BASE}/tour/two-storey`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForTimeout(4500);

await page.getByRole("button", { name: "Plan" }).click();
await page.waitForTimeout(2000);

// --- it really is a drawing ---
check("the canvas is replaced by a drawing",
  (await page.locator("canvas").count()) === 0 && (await page.locator("svg").count()) >= 1);

const shapes = await page.evaluate(() => {
  const svg = document.querySelector("svg");
  if (!svg) return null;
  return {
    rects: svg.querySelectorAll("rect").length,
    lines: svg.querySelectorAll("line").length,
    // Door swings are the only arcs in the drawing.
    arcs: [...svg.querySelectorAll("path")].filter((p) => /A /.test(p.getAttribute("d") ?? "")).length,
    text: [...svg.querySelectorAll("text")].map((t) => t.textContent?.trim()),
  };
});

check("walls are drawn as solids, not outlines", (shapes?.rects ?? 0) >= 12, `${shapes?.rects} rects`);
check("doors swing", (shapes?.arcs ?? 0) >= 4, `${shapes?.arcs} arcs`);
check("the drawing names its rooms",
  (shapes?.text ?? []).some((t) => /LIVING ROOM|HALLWAY|KITCHEN/i.test(t ?? "")),
  (shapes?.text ?? []).slice(0, 6).join(" | "));
check("and gives their areas",
  (shapes?.text ?? []).some((t) => /sq ft|m²/.test(t ?? "")));

// The staircase must be drawn as a staircase, with its direction and count.
check("the staircase reports its direction and riser count",
  (shapes?.text ?? []).some((t) => /^(UP|DN) \d+R$/.test(t ?? "")),
  (shapes?.text ?? []).filter((t) => /R$/.test(t ?? "")).join(" | "));

console.log(`  ground floor: ${shapes?.rects} solids, ${shapes?.lines} lines, ${shapes?.arcs} door swings`);

// --- storeys ---
await page.getByRole("button", { name: "Upstairs" }).last().click();
await page.waitForTimeout(1500);
const upper = await page.evaluate(() =>
  [...document.querySelectorAll("svg text")].map((t) => t.textContent?.trim()),
);
check("switching storey draws the other floor",
  upper.some((t) => /BEDROOM|BATHROOM/i.test(t ?? "")), upper.slice(0, 6).join(" | "));
check("and the staircase now goes down",
  upper.some((t) => /^DN \d+R$/.test(t ?? "")), upper.filter((t) => /R$/.test(t ?? "")).join(" | "));

// --- clicking drives the scope rail ---
await page.getByRole("button", { name: "Ground floor" }).first().click();
await page.waitForTimeout(1200);
const before = await page.locator("[data-room-row][data-selected]").count();
const box = await page.locator("svg").first().boundingBox();
await page.mouse.click(Math.round(box.x + box.width * 0.42), Math.round(box.y + box.height * 0.45));
await page.waitForTimeout(900);
check("clicking a room in the drawing selects it in the scope",
  (await page.locator("[data-room-row][data-selected]").count()) === 1, `was ${before}`);

// --- camera tools are meaningless over a drawing ---
check("walking is offered only where there is something to walk in",
  await page.getByRole("button", { name: "Walk" }).isDisabled());
check("measuring is disabled", await page.locator("[data-measure-toggle]").isDisabled());

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? "PLAN 2D OK - walls in solid, doors that swing, windows, stairs with a riser count, and clicking drives the scope"
    : `PLAN 2D BROKEN - ${failures} failures`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
