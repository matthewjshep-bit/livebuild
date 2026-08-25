/**
 * Draw a floor plan with the pointer and build from it.
 *
 * The photo-of-paper route was the only way in at first, which assumed the user
 * was not already at the machine they were building on. This drives the on-screen
 * pad exactly as a mouse or stylus would: freehand boxes, typed labels, read.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, build, freshStart } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const photos = readdirSync("public/properties/demo-house/photos")
  .map((f) => join("public/properties/demo-house/photos", f));

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await freshStart(page, base);
await addPhotos(page, photos.slice(0, 3));
const arrivedFirst = await build(page);
if (!arrivedFirst) {
  console.log(JSON.stringify({ verdict: "FAILED - never reached the review screen" }, null, 2));
  await browser.close();
  process.exit(1);
}

await page.getByRole("button", { name: "Draw the layout" }).click();
await page.waitForTimeout(500);

const canvas = page.locator("canvas");
await canvas.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

// Re-measured before every interaction: opening the panel and switching tools
// both move the canvas, and a stale box silently puts clicks somewhere else.
const boxNow = async () => {
  const b = await canvas.boundingBox();
  if (!b) throw new Error("no canvas");
  return b;
};

// Freehand a box, the way a hand would: many small moves, slightly imprecise.
async function drawBox(x0, y0, x1, y1) {
  const box = await boxNow();
  const px = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const [sx, sy] = px(...corners[0]);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = px(...corners[i - 1]);
    const [bx, by] = px(...corners[i]);
    for (let s = 1; s <= 14; s++) {
      const t = s / 14;
      await page.mouse.move(
        ax + (bx - ax) * t + (Math.sin(s) * 1.5),
        ay + (by - ay) * t + (Math.cos(s) * 1.5),
      );
    }
  }
  await page.mouse.up();
  await page.waitForTimeout(120);
}

// Three rooms in a row, sharing walls.
await drawBox(0.08, 0.10, 0.46, 0.55);
await drawBox(0.46, 0.10, 0.90, 0.55);
await drawBox(0.08, 0.55, 0.90, 0.88);

await page.getByRole("button", { name: "Add a name" }).click();
async function label(fx, fy, text) {
  const box = await boxNow();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(250);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
}
await label(0.27, 0.32, "Living Room 16x14");
await label(0.68, 0.32, "Kitchen");
await label(0.49, 0.71, "Bedroom");

await page.screenshot({ path: "shots/B1-sketchpad.png" });

await page.getByRole("button", { name: "Build this layout" }).click();

let read = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000);
  read = await page.evaluate(() => /what it read from your drawing/i.test(document.body.innerText));
  if (read) break;
}
await page.screenshot({ path: "shots/B2-sketchpad-built.png" });

const result = await page.evaluate(() => {
  const t = document.body.innerText;
  const labels = [...document.querySelectorAll("svg text")]
    .map((n) => n.textContent?.trim() ?? "")
    .filter((s) => s && !/sq ft|photo/.test(s));
  return {
    rooms: [...new Set(labels)],
    doorways: Number(t.match(/(\d+) doorways/)?.[1] ?? 0),
    stranded: /not touching anything/.test(t),
  };
});

const ok = read && result.rooms.length >= 3 && result.doorways >= 2 && !result.stranded;

console.log(JSON.stringify({
  result,
  errors: errors.slice(0, 3),
  verdict: ok
    ? `SKETCHPAD WORKS - drew 3 boxes with the pointer, got ${result.rooms.length} rooms and ${result.doorways} doorways, all connected`
    : `FAILED - read=${read} rooms=${result.rooms.length} doorways=${result.doorways} stranded=${result.stranded}`,
}, null, 2));

await browser.close();
process.exit(ok ? 0 : 1);
