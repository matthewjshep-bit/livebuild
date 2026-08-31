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

import { addPhotos, build, freshStart, savedProperty } from "./lib/flow.mjs";

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
const restored = await page.evaluate(() => ({
  thumbnails: document.querySelectorAll("img").length,
  canBuild: [...document.querySelectorAll("button")].some((b) =>
    /Build my tour/.test(b.textContent ?? ""),
  ),
  gated: /You have a tour in progress/.test(document.body.innerText),
}));

// --- B: leave while depth is still running ---
const arrived = await build(page);
// Depth continues on the review screen; leaving now strands it.
await page.waitForTimeout(2000);

const saved = await savedProperty(page);
await page.goto(`${base}/tour/${saved?._id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

const rescue = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
  return {
    offersToFinish: /still flat|Adding 3D depth/.test(document.body.innerText),
    nodes: doc?.nodes.length ?? 0,
    withDepth: doc?.nodes.filter((n) => n.depth).length ?? 0,
  };
});
await page.screenshot({ path: "shots/61-finish-offer.png" });

const draftKept =
  onHomePage && restored.thumbnails > 0 && restored.canBuild && !restored.gated;

console.log(
  JSON.stringify(
    {
      A_onHomePageWhileImporting: onHomePage,
      A_restored: restored,
      B_rescue: rescue,
      errors: errors.slice(0, 3),
      // Depth finishing on its own is not a failure - there is simply nothing
      // to rescue. The claim is only that *unfinished* work is offered a way on.
      verdict:
        draftKept && arrived && (rescue.offersToFinish || rescue.withDepth === rescue.nodes)
          ? rescue.offersToFinish
            ? "PERSISTENCE OK - an unfinished tour is already saved and listed; an interrupted one offers to finish"
            : `PERSISTENCE OK - an unfinished tour is already saved and listed; depth had already completed (${rescue.withDepth}/${rescue.nodes})`
          : `FAILED - draftKept=${!!draftKept} arrived=${arrived} offers=${rescue.offersToFinish} depth=${rescue.withDepth}/${rescue.nodes}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(draftKept && arrived && (rescue.offersToFinish || rescue.withDepth === rescue.nodes) ? 0 : 1);
