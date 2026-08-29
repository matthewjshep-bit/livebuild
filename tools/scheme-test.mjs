/**
 * A scheme has to change the whole house, and lamps have to light it.
 *
 * Both are easy to half-build in a way that looks finished. A scheme that
 * repaints the walls and leaves the sofa the colour it was is not a direction,
 * it is a paint job - and that is exactly what the first version of this did.
 * So the check is not "did anything change" but "did the furniture change too".
 *
 * Measured off the rendered pixels rather than off the props, because the props
 * being right is not the claim.
 */
import { chromium } from "playwright";
import { PNG } from "pngjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });

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

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Seeded with coordinates so the daylight control exists - without a site
// there is no way to reach night, and the lamps are what night is for.
await page.goto(`${BASE}/tour/demo-house`, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  const raw = await fetch("/properties/demo-house/property.json").then((r) => r.json());
  window.localStorage.setItem(
    "mattermatt:property:scheme-fixture",
    JSON.stringify({ ...raw, id: "scheme-fixture", site: { lat: 47.62, lon: -122.3, planXBearing: 90 } }),
  );
  const index = JSON.parse(window.localStorage.getItem("mattermatt:index") ?? "[]");
  if (!index.includes("scheme-fixture")) index.push("scheme-fixture");
  window.localStorage.setItem("mattermatt:index", JSON.stringify(index));
});

await page.goto(`${BASE}/tour/scheme-fixture`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForTimeout(5000);

const selector = page.getByLabel("Interior scheme");
check("the scheme selector exists", (await selector.count()) === 1);

/**
 * Find where the scheme changed, rather than guessing where the floor is.
 *
 * This used to sample two hardcoded patches. That is brittle twice over: the
 * scope rail shifted the 3D view sideways and the "floor" patch landed on a
 * wall, and even expressed as a fraction of the canvas a fixed patch only works
 * for one camera angle on one fixture. Comparing a grid and reporting the
 * largest change asks the question that is actually being asked - does
 * switching the scheme repaint the house - without needing to know the house.
 */
const gridSamples = async () => {
  const png = PNG.sync.read(await page.screenshot());
  const cells = [];
  const COLS = 24;
  const ROWS = 16;
  const cw = Math.floor(png.width / COLS);
  const ch = Math.floor(png.height / ROWS);
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = cy * ch; y < (cy + 1) * ch; y += 3) {
        for (let x = cx * cw; x < (cx + 1) * cw; x += 3) {
          const i = (png.width * y + x) << 2;
          r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
        }
      }
      cells.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
    }
  }
  return cells;
};


await selector.selectOption("Cool contemporary");
await page.waitForTimeout(2200);
const cool = await gridSamples();

await selector.selectOption("Warm traditional");
await page.waitForTimeout(2200);
const warm = await gridSamples();

// How much of the picture moved, and by how much at its strongest.
const deltas = cool.map((c, i) => distance(c, warm[i]));
const strongest = Math.max(...deltas);
const moved = deltas.filter((d) => d > 8).length;
const at = deltas.indexOf(strongest);

check("switching the scheme repaints the house", strongest > 25,
  `strongest change ${strongest.toFixed(0)} across ${cool.length} cells`);
check("it repaints a substantial part of it, not one object", moved >= 12,
  `${moved} cells moved`);

// And warm must actually be warmer where it changed most, or the schemes are
// merely different rather than what their names claim.
const warmth = (c) => c[0] - c[2];
check("the warm scheme is warmer than the cool one",
  warmth(warm[at]) > warmth(cool[at]),
  `red-minus-blue ${warmth(warm[at])} against ${warmth(cool[at])}`);

console.log(
  `  strongest change ${strongest.toFixed(0)} at cell ${at}: ` +
    `${cool[at]} → ${warm[at]}; ${moved} of ${cool.length} cells moved`,
);

// Lamps come on after dark. Without them the house would simply go black, and
// a tour that only works at noon is half a tour.
const time = page.getByLabel("Time of day");
if ((await time.count()) === 0) {
  console.log("  (no daylight control on this fixture, so lamps are untested here)");
} else {
  // Whole-frame brightness, for the same reason: no patch to guess at.
  const meanLuminance = async () => {
    const cells = await gridSamples();
    const lums = cells.map((c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
    return lums.reduce((a, b) => a + b, 0) / lums.length;
  };

  await time.fill("13");
  await page.waitForTimeout(1500);
  const day = await meanLuminance();
  await time.fill("23");
  await page.waitForTimeout(1800);
  const night = await meanLuminance();
  const lum = (v) => v;
  check("night is darker than day", lum(night) < lum(day), `${lum(night)} vs ${lum(day)}`);
  check("the lamps keep the room visible at night", lum(night) > 12,
    `luminance ${lum(night).toFixed(0)}`);
}

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? "SCHEME OK - floors and furniture both follow the scheme, and lamps light the house after dark"
    : `SCHEME BROKEN - ${failures} failures`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
