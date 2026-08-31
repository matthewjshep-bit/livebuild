/**
 * Can you actually get upstairs?
 *
 * The cross-storey case has two failure modes that a still frame hides: the
 * way up is not marked at all, or it is marked somewhere nobody would go -
 * metres overhead, in the ceiling. Both used to be tested by clicking a
 * photograph's ring; there are no photographs in the model now, so this tests
 * the two ways that are left.
 *
 * Route 1 is the minimap, which is the deliberate way to reach a floor you are
 * not on. Route 2 is the stair marker: standing downstairs, the chevron at the
 * foot of the flight has to be drawn on the storey you are standing on, which
 * is the whole point of the placement logic it comes from.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const room = () => new URL(page.url()).searchParams.get("room");

const settle = async () => {
  await page.waitForSelector("canvas", { timeout: 20_000 });
  await page.waitForFunction(() => window.__scene !== undefined, { timeout: 20_000 });
  await page.waitForTimeout(2500);
};

// --- Route 1: the minimap, switched to the upstairs plan ---
await page.goto(`${base}/tour/two-storey`, { waitUntil: "networkidle" });
await settle();

// Scoped to the map. "Upstairs" also names a button in the header's floor
// filter, and clicking that one filters the dollhouse without ever telling the
// map anything - so an unscoped lookup silently tested the wrong control.
const minimap = page.locator("[data-minimap]");
await minimap.locator("[data-minimap-level='1']").click();
await page.waitForTimeout(600);
// Rooms are the click target on the map now, not the photographs in them.
const upstairsRoom = await minimap.locator("rect[data-room]").last().getAttribute("data-room");
await minimap.locator("rect[data-room]").last().click({ force: true });
await page.waitForTimeout(1600);
const viaMinimap = room();
const reachedTheRightRoom = viaMinimap === upstairsRoom;

// --- Route 2: the stair marker, on foot downstairs ---
await page.goto(`${base}/tour/two-storey`, { waitUntil: "networkidle" });
await settle();

// Show the ground floor on its own before clicking into it.
//
// Stacked, the upstairs slab is between the camera and every ground-floor
// marker: the markers are drawn without depth testing so they stay *visible*
// through it, but a click is a ray and the ray stops at the slab. Picking a
// storey is what the floor filter is for, and it is what a person does before
// trying to get into a downstairs room anyway.
await page.getByRole("button", { name: /^Ground floor$/ }).first().click();
// Long enough for the camera to finish reframing *and* for the readout to be
// rewritten afterwards. It publishes once a second, so a shorter wait can hand
// back marker positions from the view the camera was leaving.
await page.waitForTimeout(3000);

// Now get on our feet: the stair chevron is a walk-mode affordance, because in
// the dollhouse the staircase is visible as a staircase and needs no sign.
//
// Read the marker positions *after* the floor switch, not before: filtering to
// one storey changes which markers exist and reframes the camera, so points
// gathered earlier describe a view that is no longer on screen.
const points = (await page.evaluate(() => window.__scene.markerAt)).filter(
  ([fx, fy]) => fx > 0.02 && fx < 0.98 && fy > 0.02 && fy < 0.98,
);
const canvas = await page.locator("canvas").boundingBox();
const at = ([fx, fy]) => [
  Math.round(canvas.x + canvas.width * fx),
  Math.round(canvas.y + canvas.height * fy),
];
let onFoot = null;
for (const point of points) {
  const [x, y] = at(point);
  await page.mouse.click(x, y);
  await page.waitForTimeout(600);
  if (room()) {
    onFoot = room();
    break;
  }
}

// Now the stair chevron should be drawn, on the floor being stood on.
//
// The count is checked against a range, not just against zero. On foot the
// room markers are gone and only the stairs are marked, so standing on the
// ground floor of a two-storey house there is exactly one - the way up. A
// reading of four would mean the room markers were still being counted, which
// is what a too-short wait here used to produce: the readout publishes once a
// second, so it can still be describing the dollhouse we just left.
let stairMarkers = null;
let walking = false;
if (onFoot) {
  // Wait for the readout to be describing the walk, rather than waiting a
  // fixed time and hoping. The counts below are only meaningful once it is.
  await page.waitForFunction(() => window.__scene?.mode === "walk", { timeout: 15_000 });
  stairMarkers = await page.evaluate(() => window.__scene.markers);
  walking = await page.evaluate(() => Boolean(document.querySelector("[data-walk-lock]")));
}

const photos = await page.evaluate(() => window.__scene.photoTextures);
await page.screenshot({ path: "shots/45-after-stairs.png" });

const ok =
  reachedTheRightRoom &&
  Boolean(onFoot) &&
  walking &&
  stairMarkers !== null &&
  stairMarkers >= 1 &&
  stairMarkers <= 2 &&
  errors.length === 0;

console.log(JSON.stringify({
  viaMinimap,
  reachedTheRightRoom,
  onFoot,
  walking,
  stairMarkers,
  photoTextures: photos,
  errors,
  verdict: ok
    ? `UPSTAIRS WORKS - map reached ${viaMinimap}, on foot in ${onFoot} with ${stairMarkers} stair marker(s)`
    : "UPSTAIRS FAILED - " +
      [
        reachedTheRightRoom ? null : `the minimap reached ${viaMinimap ?? "nothing"}`,
        onFoot ? null : "no room marker put us on our feet",
        walking ? null : "the walker never took the camera",
        stairMarkers !== null && stairMarkers >= 1 && stairMarkers <= 2
          ? null
          : `expected one way up, the scene reported ${stairMarkers} marker(s)`,
      ]
        .filter(Boolean)
        .join("; "),
}, null, 2));

await browser.close();
process.exit(ok ? 0 : 1);
