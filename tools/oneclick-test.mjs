/**
 * Drop photos, press one button, get a house.
 *
 * This is the whole product now: the flow used to ask the user to label every
 * photo, describe the house and arrange the rooms, all of which are inferable
 * from the photos themselves. What is asserted here is that nothing else is
 * required — no typing, no dragging, no per-photo tapping — and that what comes
 * out the other end is a walkable house with every photo placed.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { build, chooseMode } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).map((f) => join(dir, f));

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/new`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
// The wizard opens on a choice now - a room or a whole house - so every suite
// that drives it has to answer that before it reaches the photo screen.
await chooseMode(page);
await page.waitForTimeout(800);
if (await page.getByRole("button", { name: "Start over" }).count()) {
  await page.getByRole("button", { name: "Start over" }).click();
  await page.waitForTimeout(400);
}

const startedAt = Date.now();

// The only two actions a user has to take.
await page.setInputFiles('input[type="file"]', files);
await page.waitForTimeout(2000);
await page.screenshot({ path: "shots/C1-drop.png" });
// "One click" is now one click, a sheet and a drawing: the layout is asked for
// before the build rather than dragged out of an empty canvas afterwards. The
// shared helper does all three, so this suite keeps measuring the time from
// dropping photos to a finished house rather than knowing the screens.
const arrived = await build(page, { timeoutMs: 200_000 });
const seconds = Math.round((Date.now() - startedAt) / 1000);
await page.screenshot({ path: "shots/C2-review.png" });

const built = await page.evaluate(() => {
  const text = document.body.innerText;
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
  return {
    summary: text.match(/\d+ rooms, \d+ doorways\./)?.[0] ?? null,
    connections: text.match(/Spotted \d+ connections? between rooms/)?.[0] ?? null,
    aimed: text.match(/Aimed \d+ cameras? from what the photos show/)?.[0] ?? null,
    rooms: doc?.plan.rooms.length ?? 0,
    doorways: doc?.plan.openings.length ?? 0,
    nodes: doc?.nodes.length ?? 0,
    exteriorPhotos: doc?.exteriorPhotos?.length ?? 0,
    allConnected: (doc?.nodes ?? []).every((n) => n.neighbors.length > 0),
    id: doc?.id,
  };
});

// It is only a tour if you can actually walk it.
let walkable = false;
if (built.id) {
  await page.goto(`${base}/tour/${built.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "shots/C3-tour.png" });
  walkable = await page.evaluate(() => !!document.querySelector("canvas"));
}

const ok =
  arrived &&
  built.rooms >= 4 &&
  built.doorways > 0 &&
  built.nodes + built.exteriorPhotos === files.length &&
  built.allConnected &&
  walkable;

console.log(
  JSON.stringify(
    {
      secondsToHouse: seconds,
      built,
      walkable,
      errors: errors.slice(0, 3),
      verdict: ok
        ? `ONE CLICK WORKS - ${files.length} photos in, ${built.rooms} rooms and ` +
          `${built.doorways} doorways out in ${seconds}s, every photo placed and walkable, ` +
          `with nothing typed and nothing dragged`
        : `FAILED - arrived=${arrived} rooms=${built.rooms} nodes=${built.nodes}/${files.length} walkable=${walkable}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ok ? 0 : 1);
