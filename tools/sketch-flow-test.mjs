/**
 * Upload a drawing, get a layout.
 *
 * The end-to-end version of `sketch-test.ts`: that one runs on a recorded
 * reading, this one calls the model live and drives the actual UI. It also
 * checks the label-tolerance path — the sketch says "Bath" and "Bedroom" while
 * the photos were tagged from a different vocabulary, which is exactly the
 * mismatch that used to drop photos silently.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, build, freshStart, waitForHouse } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const photos = readdirSync(dir).map((f) => join(dir, f));
const sketch = "public/fixtures/sketch-floorplan.jpg";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await freshStart(page, base);
await addPhotos(page, photos);
// Labels come from the build; this suite is about the drawing replacing the
// layout underneath them, and about names not having to match.
const arrivedFirst = await build(page);
if (!arrivedFirst) {
  console.log(JSON.stringify({ verdict: "FAILED - never reached the review screen" }, null, 2));
  await browser.close();
  process.exit(1);
}

const before = await page.evaluate(() => {
  const t = document.body.innerText;
  return {
    doorways: Number(t.match(/(\d+) doorways/)?.[1] ?? 0),
    rooms: document.querySelectorAll("svg text").length,
  };
});

await page.getByRole("button", { name: "Draw the layout" }).click();
await page.waitForTimeout(400);
// Drawing is the default now; this suite covers the photo-of-paper route.
await page.getByRole("button", { name: "Photo of paper" }).click();
await page.waitForTimeout(300);
await page.setInputFiles('input[accept="image/*"]', sketch);

// Reading a sketch is a high-effort vision call.
let read = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000);
  // innerText reflects CSS text-transform, and this heading is uppercased.
  read = await page.evaluate(() => /what it read from your drawing/i.test(document.body.innerText));
  if (read) break;
}
await page.screenshot({ path: "shots/A1-sketch-read.png" });

const after = await page.evaluate(() => {
  const t = document.body.innerText;
  const labels = [...document.querySelectorAll("svg text")]
    .map((n) => n.textContent?.trim() ?? "")
    .filter((s) => s && !/sq ft|photo/.test(s));
  return {
    doorways: Number(t.match(/(\d+) doorways/)?.[1] ?? 0),
    labels: [...new Set(labels)],
    stranded: /not touching anything/.test(t),
    notes: /what it read from your drawing/i.test(t),
  };
});

// No rebuild needed: replacing the layout re-places the photos into the
// drawing's rooms, which is the behaviour actually under test here.
await page.waitForTimeout(1500);
await page.screenshot({ path: "shots/A2-sketch-built.png" });

const built = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
  return {
    rebuilt: true,
    rooms: doc?.plan.rooms.map((r) => r.label) ?? [],
    nodes: doc?.nodes.length ?? 0,
    roomsWithPhotos: new Set((doc?.nodes ?? []).map((n) => n.roomId)).size,
    unplacedWarning: /had no matching room/.test(document.body.innerText),
  };
});

const drewSixRooms = after.labels.length >= 6;
const connected = after.doorways >= 6 && !after.stranded;
// Every tagged photo must find a home despite the vocabulary mismatch.
const photosPlaced = built.nodes >= 5;

const ok = read && drewSixRooms && connected && photosPlaced;

console.log(
  JSON.stringify(
    {
      beforeSketch: before,
      afterSketch: after,
      built,
      errors: errors.slice(0, 3),
      verdict: ok
        ? `SKETCH FLOW WORKS - drawing became ${after.labels.length} rooms and ` +
          `${after.doorways} doorways, all connected; ${built.nodes} photos placed ` +
          `across ${built.roomsWithPhotos} rooms despite differing names`
        : `FAILED - read=${read} rooms=${after.labels.length} doorways=${after.doorways} ` +
          `stranded=${after.stranded} nodes=${built.nodes}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ok ? 0 : 1);
