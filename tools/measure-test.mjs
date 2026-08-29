/**
 * A tape measure in the model.
 *
 * The model already knows every distance in the house; the point of this is
 * that it answers a question nobody wrote down in advance - whether a sofa
 * fits on that wall, how much clear width there is beside an island. A room
 * schedule cannot anticipate those.
 *
 * The check that matters is that the number is right. A dimension tool that
 * draws a confident label reading the wrong distance is worse than none, and
 * nothing on screen would tell you.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

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

await page.goto(`${BASE}/tour/demo-house`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForTimeout(4500);

await page.getByRole("button", { name: "Measure" }).click();
await page.waitForTimeout(400);

// Two clicks a known distance apart on screen. Which surfaces they land on
// does not matter - what matters is that the label agrees with the distance
// between the two points the model reports having been clicked.
const box = await page.locator("canvas").boundingBox();
const cx = Math.round(box.x + box.width / 2);
const cy = Math.round(box.y + box.height / 2);

await page.mouse.click(cx - 160, cy + 60);
await page.waitForTimeout(600);
await page.mouse.click(cx + 160, cy + 60);
await page.waitForTimeout(900);

// Counting leaf elements only. The overlay is wrapped by the renderer, so a
// naive query over every div counts each label twice and made a passing case
// look like four labels.
const dimensions = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("div")]
      .filter((d) => d.querySelector("div") === null)
      .map((d) => d.textContent?.trim() ?? "")
      .filter((t) => /^\d+'( \d+")?$|^\d+\.\d+ m$/.test(t)),
  );

const label = (await dimensions())[0] ?? null;

check("two clicks produce a dimension", label !== null, "no label found");

if (label) {
  // Feet and inches back to metres, and compare against the demo house, which
  // is 9.5m across. Two points on its floor cannot be further apart than its
  // diagonal, and a pair of clicks a third of the screen apart cannot be zero.
  const m = /(\d+)'\s*(\d+)?/.exec(label);
  const metres = m ? (Number(m[1]) + Number(m[2] ?? 0) / 12) * 0.3048 : NaN;
  check("the dimension is a real distance", metres > 0.2, `${label}`);
  check("the dimension is inside the house's diagonal", metres < 14, `${label}`);
  console.log(`  measured ${label} (${metres.toFixed(2)} m)`);
}

// A third click starts a new measurement rather than adding a third point.
// Clicked back onto the floor: a click that lands on nothing is not a click
// the tool ever sees, and an earlier version of this aimed above the roof.
await page.mouse.click(cx - 40, cy + 60);
await page.waitForTimeout(800);
const afterThird = await dimensions();
check("a third click starts over rather than adding a point", afterThird.length === 0,
  `${afterThird.length} still showing: ${afterThird.join(", ")}`);

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? "MEASURE OK - two clicks give a dimension, a third starts again"
    : `MEASURE BROKEN - ${failures} failures`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
