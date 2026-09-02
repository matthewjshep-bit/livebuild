/**
 * The builder's edit actions, on the review screen.
 *
 * These are the corrections nothing can make for you - a hallway running the
 * wrong way, a storey the photos cannot reveal, a wall you actually measured -
 * so they have to stay within reach of the finished plan rather than behind an
 * "advanced" door.
 *
 * The size fields are the newest of them and the reason they exist is worth
 * saying: dragging a rectangle over a satellite photograph cannot land on a
 * number anybody would write down, so a room came out 12.7 feet wide because
 * that is where the mouse stopped. Typing a measurement somebody took with a
 * tape is the whole point.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, build, freshStart } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).slice(0, 4).map((f) => join(dir, f));

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await freshStart(page, base);
await addPhotos(page, files);
const arrived = await build(page);

await page.getByRole("button", { name: "+ Add room" }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Hallway", exact: true }).click();
await page.waitForTimeout(500);

await page.getByRole("button", { name: /^Rotate/ }).click();
await page.waitForTimeout(400);

// --- a room can be given a size rather than dragged to one ---
const widthField = page.getByLabel("Width in feet");
const depthField = page.getByLabel("Depth in feet");
const hasFields = (await widthField.count()) === 1 && (await depthField.count()) === 1;
await widthField.fill("12.5");
await widthField.press("Enter");
await depthField.fill("9");
await depthField.press("Enter");
await page.waitForTimeout(500);

const sized = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
  // The last one: the drawing already had a hallway, and the one just added is
  // appended to the plan.
  const room = (doc?.plan.rooms ?? []).filter((r) => /hallway/i.test(r.label)).pop();
  if (!room) return null;
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const ft = (m) => m / 0.3048;
  return {
    width: Math.round(ft(Math.max(...xs) - Math.min(...xs)) * 100) / 100,
    depth: Math.round(ft(Math.max(...ys) - Math.min(...ys)) * 100) / 100,
  };
});

await page.getByRole("button", { name: "+ Add floor" }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "Bedroom", exact: true }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: "shots/50-builder.png" });

const floors = await page.evaluate(() =>
  [...document.querySelectorAll("button")]
    .map((b) => b.textContent?.trim() ?? "")
    .filter((t) => /^(Ground floor|Upstairs|Basement)/.test(t)),
);

await page.getByRole("button", { name: "Undo" }).click();
await page.waitForTimeout(400);

// Half an inch of slack: the store round-trips through JSON and feet are not
// what the plan is kept in.
const near = (a, b) => Math.abs(a - b) < 0.05;
const typedSize = Boolean(sized) && near(sized.width, 12.5) && near(sized.depth, 9);

const ok = arrived && floors.length >= 2 && hasFields && typedSize && errors.length === 0;

console.log(
  JSON.stringify(
    {
      floorTabs: floors,
      sized,
      errors: errors.slice(0, 3),
      verdict: ok
        ? `BUILDER WORKS - added a room, rotated it, typed it to ${sized.width} x ${sized.depth} ft, and created ${floors.length} storeys from the review screen`
        : `BUILDER FAILED - fields=${hasFields} sized=${JSON.stringify(sized)}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ok ? 0 : 1);
