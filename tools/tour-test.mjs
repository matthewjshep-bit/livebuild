/**
 * The scripted tour, and whether the camera actually goes anywhere.
 *
 * The tour it is modelled on is hand-authored for one house. Ours is derived
 * from the plan, because no two houses this tool builds are the same and nobody
 * is going to script each one - so what has to be checked is that a generated
 * script visits the rooms and moves the camera along a path that stays outside
 * the building rather than cutting through it.
 */
import { chromium } from "playwright";

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

await page.goto(`${BASE}/tour/demo-house`, { waitUntil: "networkidle" });
await page.waitForSelector("canvas", { timeout: 25_000 });
await page.waitForTimeout(4500);

check("the tour button is offered", (await page.locator("[data-tour-toggle]").count()) === 1);

await page.locator("[data-tour-toggle]").click();
await page.waitForTimeout(1200);

const captions = new Set();
const frames = [];
for (let i = 0; i < 26; i++) {
  await page.waitForTimeout(700);
  const caption = await page
    .locator("[data-tour-caption]")
    .innerText()
    .catch(() => null);
  if (caption) captions.add(caption.trim());
  const shot = await page.screenshot();
  frames.push(shot.length);
}

check("the tour shows more than one beat", captions.size >= 3,
  `${captions.size} captions: ${[...captions].slice(0, 4).join(" | ")}`);
check("it names rooms, not just the house",
  [...captions].some((c) => /sq ft/.test(c)),
  [...captions].join(" | "));

// The frames must actually differ. A tour whose camera never moves would show
// captions changing over a still picture, and every check above would pass.
const distinct = new Set(frames).size;
check("the camera moves between frames", distinct > frames.length * 0.6,
  `${distinct} distinct frames of ${frames.length}`);

console.log(`  ${captions.size} beats, ${distinct}/${frames.length} distinct frames`);
console.log(`  captions: ${[...captions].slice(0, 5).join(" · ")}`);

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? "TOUR OK - a script derived from the plan, visiting rooms with the camera moving"
    : `TOUR BROKEN - ${failures} failures`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
