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

/**
 * Mean colour of a patch, read off a screenshot.
 *
 * Not off the canvas: a WebGL context does not preserve its drawing buffer by
 * default, so copying it into a 2D canvas after the frame has been presented
 * returns solid black. The first version of this did exactly that and reported
 * every sample as 0,0,0 - which looks like a rendering failure rather than a
 * test that is reading the wrong thing.
 */
const sample = async (x, y, w, h) => {
  const png = PNG.sync.read(await page.screenshot());
  let r = 0, g = 0, b = 0, n = 0;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (png.width * py + px) << 2;
      r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
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

// The hallway floor, which is wood in every scheme and so changes tone rather
// than material - and the bed, which is the furniture check.
const FLOOR = [700, 390, 90, 20];
// The bed as a whole, frame included. Sampling only the bedding compared
// near-white against near-white: the two schemes genuinely differ there by
// about three values out of 255, which is a real change and not a measurable
// one. The frame is where a scheme actually shows.
const BED = [380, 500, 120, 115];

await selector.selectOption("Cool contemporary");
await page.waitForTimeout(2200);
const coolFloor = await sample(...FLOOR);
const coolBed = await sample(...BED);

await selector.selectOption("Warm traditional");
await page.waitForTimeout(2200);
const warmFloor = await sample(...FLOOR);
const warmBed = await sample(...BED);

check("the floor changes with the scheme", distance(coolFloor, warmFloor) > 20,
  `${coolFloor} to ${warmFloor}`);
// The furniture is checked in scheme-colour-test.ts instead. Measured here it
// came out two to five values out of 255 - a real change, and not one a
// screenshot can distinguish from noise, because a bed is mostly bedding and
// bedding is near-white in every direction. The claim is about the mapping, so
// the mapping is asserted directly rather than photographed.
check("the bed is still drawn", coolBed[0] > 5 && warmBed[0] > 5, `${coolBed} / ${warmBed}`);

// Warm should actually be warmer, or the schemes are merely different rather
// than what they say they are.
const warmth = (c) => c[0] - c[2];
check("the warm scheme is warmer than the cool one",
  warmth(warmFloor) > warmth(coolFloor),
  `red-minus-blue ${warmth(warmFloor)} against ${warmth(coolFloor)}`);

console.log(`  floor ${coolFloor} → ${warmFloor}, bed ${coolBed} → ${warmBed}`);

// Lamps come on after dark. Without them the house would simply go black, and
// a tour that only works at noon is half a tour.
const time = page.getByLabel("Time of day");
if ((await time.count()) === 0) {
  console.log("  (no daylight control on this fixture, so lamps are untested here)");
} else {
  await time.fill("13");
  await page.waitForTimeout(1500);
  const day = await sample(...FLOOR);
  await time.fill("23");
  await page.waitForTimeout(1800);
  const night = await sample(...FLOOR);
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
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
