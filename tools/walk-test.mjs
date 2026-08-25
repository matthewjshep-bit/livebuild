/**
 * Can you actually walk the tour?
 *
 * Clicking a ring should move you to that viewpoint. This drives real clicks at
 * the floor and checks the active node changed - the one behaviour that makes
 * this a tour rather than a gallery.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/tour/demo-house?node=n1`, { waitUntil: "networkidle" });

// Wait for the scene to exist rather than for a fixed number of seconds.
//
// A flat 3.5s sleep made this fail about one run in three: under SwiftShader
// the first frame can take noticeably longer, and every click in the sweep then
// landed before there was anything to hit - which reported "no ring responded"
// for a tour that was merely still loading. Nothing about the walk was broken.
await page.waitForSelector("canvas", { timeout: 20_000 });
await page.waitForFunction(
  () => {
    const c = document.querySelector("canvas");
    return c instanceof HTMLCanvasElement && c.width > 0 && c.height > 0;
  },
  { timeout: 20_000 },
);
await page.waitForTimeout(2500);

const activeNode = () => new URL(page.url()).searchParams.get("node");
const start = activeNode();

// n2 sits almost exactly where n1 is looking, so its ring should be on the
// floor near the middle of the frame. Sweep down the centre line to find it,
// and sweep more than once - the rings fade in, so an early pass can cross the
// right pixel a moment too soon.
let moved = null;
for (let attempt = 0; attempt < 3 && !moved; attempt++) {
  for (const y of [600, 640, 678, 700, 730, 760]) {
    await page.mouse.click(640, y);
    await page.waitForTimeout(900);
    if (activeNode() !== start) {
      moved = { at: [640, y], to: activeNode() };
      break;
    }
  }
  if (!moved) await page.waitForTimeout(2000);
}

let returned = null;
if (moved) {
  await page.waitForTimeout(1400);
  await page.screenshot({ path: "shots/11-after-walk.png" });
  // The node just left should now be a neighbour, so a step back must exist.
  for (const y of [600, 660, 700, 740]) {
    await page.mouse.click(640, y);
    await page.waitForTimeout(900);
    if (activeNode() !== moved.to) {
      returned = activeNode();
      break;
    }
  }
}

console.log(JSON.stringify({
  start,
  moved,
  steppedBackTo: returned,
  errors,
  verdict: moved
    ? `WALK WORKS - ${start} -> ${moved.to}${returned ? ` -> ${returned}` : ""}`
    : "WALK FAILED - no ring responded to a click",
}, null, 2));

await browser.close();
process.exit(moved && errors.length === 0 ? 0 : 1);
