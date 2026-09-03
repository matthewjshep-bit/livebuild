/**
 * Can you actually get into the house?
 *
 * Clicking a room marker should put you inside that room, on foot. This used
 * to click a photograph's ring and check the active node changed; there are no
 * photographs in the model any more, so the equivalent question is whether a
 * marker on the floor drops you into the room it marks.
 *
 * Driven as real clicks at the canvas rather than as state changes, because
 * the failure this catches is a marker that is drawn but not hittable - which
 * has happened twice, both times because something else got in front of it.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/tour/demo-house`, { waitUntil: "networkidle" });

// Wait for the scene to exist rather than for a fixed number of seconds. Under
// SwiftShader the first frame can take noticeably longer than a flat sleep
// allows, and every click then lands before there is anything to hit - which
// reports "nothing responded" for a tour that was merely still loading.
await page.waitForSelector("canvas", { timeout: 20_000 });
await page.waitForFunction(
  () => {
    const c = document.querySelector("canvas");
    return c instanceof HTMLCanvasElement && c.width > 0 && c.height > 0;
  },
  { timeout: 20_000 },
);
await page.waitForFunction(() => window.__scene?.markers > 0, { timeout: 20_000 });
// And then let the opening camera flight finish. The readout is published once
// a second, so the first one that carries markers at all can still describe
// the view the camera was easing away from - and every click then lands where
// a marker used to be.
await page.waitForTimeout(2500);

const markers = await page.evaluate(() => window.__scene.markers);

// Clicks are aimed at the canvas, not at the page: the scope rail moves the 3D
// view sideways, and a hardcoded page x lands on the rail.
const canvas = await page.locator("canvas").boundingBox();
const at = (fx, fy) => [
  Math.round(canvas.x + canvas.width * fx),
  Math.round(canvas.y + canvas.height * fy),
];

const room = () => new URL(page.url()).searchParams.get("room");

// Click the markers where they actually are.
//
// The scene reports each one's projected screen position, so this aims rather
// than sweeps. A grid of guesses at a target half a metre across is how a test
// ends up flaky in a way that says nothing about the code.
// Positions are re-read before every click, not gathered once up front.
//
// The scene publishes them once a second, so a list fetched at the top is up to
// a second stale - and under SwiftShader, with the house now carrying its
// joinery, a second is several frames of a camera that may still be easing.
// Clicking a marker's former position is indistinguishable from the marker not
// responding, which is how this went intermittently red about one run in three.
//
// On-screen only: a house framed close projects some of its markers past the
// edge of the viewport, and clicking at a negative fraction lands on the
// browser chrome rather than the canvas.
const onScreen = (points) =>
  points.filter(([fx, fy]) => fx > 0.02 && fx < 0.98 && fy > 0.02 && fy < 0.98);

let entered = null;
outer: for (let attempt = 0; attempt < 3 && !entered; attempt++) {
  const points = onScreen(await page.evaluate(() => window.__scene.markerAt));
  for (const [fx, fy] of points) {
    const [x, y] = at(fx, fy);
    await page.mouse.click(x, y);
    await page.waitForTimeout(700);
    if (room()) {
      entered = { at: [fx, fy], room: room() };
      break outer;
    }
  }
  // Let the readout publish again before trying the fresh positions.
  await page.waitForTimeout(1200);
}

// Getting in is half of it; the walker has to actually own the camera.
let walking = false;
if (entered) {
  // Wait for the scene to say it is describing the walk, rather than waiting a
  // fixed time and hoping - the readout publishes once a second.
  await page.waitForFunction(() => window.__scene?.mode === "walk", { timeout: 15_000 });
  walking = await page.evaluate(() => Boolean(document.querySelector("[data-walk-ui]")));
  await page.screenshot({ path: "shots/11-after-walk.png" });
}

const photos = await page.evaluate(() => window.__scene.photoTextures);

// Standing in a room is not a selection.
//
// Walking in sets a whole-room pick so the scope rail can follow you, and that
// used to light every surface in the room from within. `emissive` is added
// after all lighting, so on a wall it was a faint tint and on the ceiling - the
// dimmest surface in any room, since nothing shines up at it - it was most of
// what you saw. Every interior had a blue ceiling, and it survived turning off
// every light in the scene while I hunted for it.
const emissive = await page.evaluate(() => window.__scene.emissive);

console.log(JSON.stringify({
  markers,
  entered,
  walking,
  photoTextures: photos,
  emissive,
  errors,
  verdict:
    entered && walking
      ? `WALK WORKS - clicked into ${entered.room} on foot, ${markers} markers drawn`
      : entered
        ? "PARTIAL - entered the room but the walker never took the camera"
        : "WALK FAILED - no room marker responded to a click",
}, null, 2));

await browser.close();
// Only meaningful once we are actually in a room. The sweep above clicks until
// a marker responds, and a click that lands on geometry instead legitimately
// selects that fitting - so a stray selection left over from a *failed* entry
// is the entry failing, not the glow misbehaving.
const glowing = entered ? emissive : 0;
if (glowing !== 0) {
  console.log(
    `  FAIL nothing should glow from within while merely standing in a room — ${glowing} surface(s) do`,
  );
}
process.exit(entered && walking && glowing === 0 && errors.length === 0 ? 0 : 1);
