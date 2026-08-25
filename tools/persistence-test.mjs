/**
 * Does work survive leaving the page?
 *
 * The reported failure was "the photos I uploaded and progress I made did not
 * save", and there were two separate causes. Both are checked here, because
 * both are invisible until you come back and find the work gone.
 *
 *   A - reload partway through the wizard, expecting photos and room labels back
 *   B - leave while depth is still computing, expecting a way to finish it
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

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const offered = await page.getByRole("button", { name: "Pick up where I left off" }).count();
let restored = null;
if (offered) {
  await page.getByRole("button", { name: "Pick up where I left off" }).click();
  await page.waitForTimeout(1500);
  restored = await page.evaluate(() => ({
    thumbnails: document.querySelectorAll("img").length,
    canBuild: [...document.querySelectorAll("button")].some((b) =>
      /Build my tour/.test(b.textContent ?? ""),
    ),
  }));
}

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

const draftKept = restored && restored.thumbnails > 0 && restored.canBuild;

console.log(
  JSON.stringify(
    {
      A_resumeOffered: !!offered,
      A_restored: restored,
      B_rescue: rescue,
      errors: errors.slice(0, 3),
      // Depth finishing on its own is not a failure - there is simply nothing
      // to rescue. The claim is only that *unfinished* work is offered a way on.
      verdict:
        draftKept && arrived && (rescue.offersToFinish || rescue.withDepth === rescue.nodes)
          ? rescue.offersToFinish
            ? "PERSISTENCE OK - a reload keeps the photos; an interrupted tour offers to finish"
            : `PERSISTENCE OK - a reload keeps the photos; depth had already completed (${rescue.withDepth}/${rescue.nodes})`
          : `FAILED - draftKept=${!!draftKept} arrived=${arrived} offers=${rescue.offersToFinish} depth=${rescue.withDepth}/${rescue.nodes}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(draftKept && arrived && (rescue.offersToFinish || rescue.withDepth === rescue.nodes) ? 0 : 1);
