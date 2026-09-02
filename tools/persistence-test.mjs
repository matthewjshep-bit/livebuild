/**
 * Does work survive leaving the page?
 *
 * The reported failure was "the photos I uploaded and progress I made did not
 * save", and there were two separate causes. Both are checked here, because
 * both are invisible until you come back and find the work gone.
 *
 *   A - reload partway through the wizard, expecting photos and room labels back
 *   B - leave while depth is still computing, expecting a way to finish it
 *
 * A used to be checked through a resume prompt: reload, and the wizard offered
 * to pick up where you left off. That prompt is gone, and its absence is an
 * improvement rather than a regression - it was a gate with only two ways
 * through, one of which deleted the photographs of a *finished* tour, and it
 * appeared after every build because the draft it read was rewritten moments
 * after being cleared. The claim it was standing in for is stronger and is what
 * is checked now: leave partway through and the tour is already on the home
 * page, still holding its photographs, with nothing to dismiss.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, build, chooseMode, freshStart, savedProperty } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).slice(0, 3).map((f) => join(dir, f));

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

// --- A: reload before building ---
await freshStart(page, base);
await addPhotos(page, files);
await page.waitForTimeout(600);

// The tour exists the moment there are photographs in it, so it is on the home
// page before anything has been built.
const importing = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  return index[index.length - 1] ?? null;
});

await page.goto(`${base}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const listed = await page.evaluate(() => document.body.innerText);
const onHomePage = /still importing/.test(listed);

// And reopening it by id brings the photographs back, with no prompt in the way.
await page.goto(`${base}/new?id=${importing}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
// Reopening restores the work, not the screen, so the mode choice is answered
// again like any other visit before the photographs are on show.
await chooseMode(page);
await page.waitForTimeout(1500);
const restored = await page.evaluate(() => ({
  thumbnails: document.querySelectorAll("img").length,
  canBuild: Boolean(document.querySelector('[data-testid="continue-from-photos"]')),
  gated: /You have a tour in progress/.test(document.body.innerText),
}));

// --- B: leave the moment the tour is on screen ---
//
// This used to leave while the depth pass was still running, and check that
// the tour offered to finish it. There is no depth pass any more - photographs
// are read to build the house rather than rendered inside it - so what is left
// to prove is the part that always mattered: the house is on disk by the time
// the review screen appears, and opening it fresh finds a whole tour with its
// photographs still attached.
const arrived = await build(page);
await page.waitForTimeout(2000);

const saved = await savedProperty(page);
await page.goto(`${base}/tour/${saved?._id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

const rescue = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
  return {
    rooms: doc?.plan.rooms.length ?? 0,
    photos: doc?.nodes.length ?? 0,
    // Every photograph has to still point at a room that exists. A re-layout
    // mints new room ids, and an orphaned photograph is invisible rather than
    // broken - so it is the loss this check is here to catch.
    orphaned:
      doc?.nodes.filter(
        (n) => !doc.plan.rooms.some((r) => r.id === n.roomId),
      ).length ?? 0,
    rendered: Boolean(document.querySelector("canvas")),
  };
});
await page.screenshot({ path: "shots/61-reopened.png" });

const draftKept =
  onHomePage && restored.thumbnails > 0 && restored.canBuild && !restored.gated;

console.log(
  JSON.stringify(
    {
      A_onHomePageWhileImporting: onHomePage,
      A_restored: restored,
      B_rescue: rescue,
      errors: errors.slice(0, 3),
      verdict:
        draftKept && arrived && rescue.rooms > 0 && rescue.rendered && rescue.orphaned === 0
          ? `PERSISTENCE OK - an unfinished tour is saved and listed; reopened cold it rebuilt ${rescue.rooms} rooms with ${rescue.photos} photos attached`
          : `FAILED - draftKept=${!!draftKept} arrived=${arrived} rooms=${rescue.rooms} rendered=${rescue.rendered} orphaned=${rescue.orphaned}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(
  draftKept && arrived && rescue.rooms > 0 && rescue.rendered && rescue.orphaned === 0 ? 0 : 1,
);
