/**
 * Upload a drawing, get a layout.
 *
 * The end-to-end version of `sketch-test.ts`: that one runs on a recorded
 * reading, this one calls the model live and drives the actual UI. It also
 * checks the label-tolerance path — the sketch says "Bath" and "Bedroom" while
 * the photos were tagged from a different vocabulary, which is exactly the
 * mismatch that used to drop photos silently.
 *
 * The photo of paper is an alternative to the pen rather than a replacement for
 * a finished layout now, so this arrives at the drawing stage and hands it a
 * photograph instead of drawing. The layout it produces is what the house is
 * then built from, which is why this no longer rebuilds anything.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, freshStart, waitForHouse } from "./lib/flow.mjs";

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
await page.getByTestId("continue-from-photos").click();
await page.waitForTimeout(700);
await page.getByTestId("build-from-sheet").click();
await page.waitForTimeout(800);

const arrivedFirst = (await page.getByTestId("drawing-board").count()) === 1;
if (!arrivedFirst) {
  console.log(JSON.stringify({ verdict: "FAILED - never reached the drawing stage" }, null, 2));
  await browser.close();
  process.exit(1);
}

// The pen is the default; this suite covers the photo-of-paper route beside it.
await page.getByTestId("import-sketch").click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "Photo of paper" }).click();
await page.waitForTimeout(300);
await page.setInputFiles('input[accept="image/*"]', sketch);
await page.screenshot({ path: "shots/A1-sketch-read.png" });

// Reading a sketch is a high-effort vision call, and the whole build runs after
// it. Landing on the fitted plan is the signal that the reading was accepted.
let read = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(3000);
  read = await page.evaluate(() => /Does this look right/.test(document.body.innerText));
  if (read) break;
}

const after = await page.evaluate(() => {
  const t = document.body.innerText;
  const labels = [...document.querySelectorAll("svg text")]
    .map((n) => n.textContent?.trim() ?? "")
    .filter((s) => s && !/sq ft|photo/.test(s));
  return {
    doorways: Number(t.match(/(\d+) doorways/)?.[1] ?? 0),
    labels: [...new Set(labels)],
    stranded: /not touching anything/.test(t),
  };
});

// The layout is what the house is built from now, so finish the build and look
// at what came out rather than at a layout swapped in underneath one.
await page.getByTestId("build-from-layout").click();
const finished = await waitForHouse(page);
await page.screenshot({ path: "shots/A2-sketch-built.png" });

// `finished` stays on this side of the bridge. It used to be read inside this
// closure, which the browser evaluates in its own scope - so every run threw
// `ReferenceError: finished is not defined` and none of the checks below ever
// ran. The suite reported a crash rather than a result, which is why it looked
// like an infrastructure problem rather than a bug in itself.
const built = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
  return {
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

const ok = read && finished && drewSixRooms && connected && photosPlaced;

console.log(
  JSON.stringify(
    {
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
