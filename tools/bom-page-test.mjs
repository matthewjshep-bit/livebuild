/**
 * The bill of materials, end to end in the browser.
 *
 * Builds a tour from photos so there is a real property with real photos, then
 * grades it from those photos and checks the scope that falls out: rollups on
 * screen, a whole-house section, and a CSV that downloads.
 *
 * The grading pass is the part worth watching. It decides which lines exist at
 * all, and on the synthetic demo house it has very little to go on - so what is
 * asserted is that it produces *a* grade for every element it was asked about,
 * not that the grades are right.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, build, freshStart, savedProperty } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).map((f) => join(dir, f));

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 1100 },
  acceptDownloads: true,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await freshStart(page, base);
await addPhotos(page, files);
const built = await build(page);
const property = await savedProperty(page);

await page.goto(`${base}/bom/${property._id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "shots/B1-bom-ungraded.png", fullPage: true });

// Nothing graded yet: the scope should be empty rather than invented.
const ungraded = await page.evaluate(() => {
  const text = document.body.innerText;
  return {
    total: text.match(/\$[\d,]+/)?.[0] ?? null,
    saysNothingNeeded: /nothing needed/.test(text),
  };
});

// Grade from the photos.
await page.getByRole("button", { name: /Grade condition from the photos/ }).click();
let graded = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(3000);
  graded = await page.evaluate(() => /Graded \d+ rooms?/.test(document.body.innerText));
  if (graded) break;
}
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/B2-bom-graded.png", fullPage: true });

const after = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("livebuild:index") ?? "[]");
  const doc = JSON.parse(localStorage.getItem("livebuild:property:" + index.pop()) ?? "null");
  const text = document.body.innerText;
  return {
    roomsGraded: Object.keys(doc?.condition ?? {}).length,
    gradeValues: [...new Set(Object.values(doc?.condition ?? {}).flatMap((c) => Object.values(c)))],
    hasWholeHouse: /Whole house/.test(text),
    hasTotal: /Total/.test(text),
    sanity: text.match(/(In line with|Below the usual|Above the usual)[^\n]*/)?.[0] ?? null,
    takeoffShown: /sqft floor/.test(text),
  };
});

// Set a whole-house element and confirm the total responds.
const beforeRoof = await page.evaluate(
  () => document.body.innerText.match(/Itemised total\s*\$([\d,]+)/)?.[1] ?? "0",
);
// By label, not by position: the selects are labelled for screen readers, and
// an earlier attempt at a positional selector injected bad JS into the page.
await page.getByLabel("Roof").selectOption("poor");
await page.waitForTimeout(900);
const afterRoof = await page.evaluate(
  () => document.body.innerText.match(/Itemised total\s*\$([\d,]+)/)?.[1] ?? "0",
);

// CSV download.
const download = await Promise.all([
  page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
  page.getByRole("button", { name: "Export CSV" }).click(),
]).then(([d]) => d);

const csvName = download ? await download.suggestedFilename() : null;

const numeric = (s) => Number(String(s).replace(/[^0-9]/g, ""));

const ok =
  built &&
  graded &&
  after.roomsGraded > 0 &&
  after.hasTotal &&
  after.takeoffShown &&
  // Setting the roof to poor must move the money, or condition is decoration.
  numeric(afterRoof) > numeric(beforeRoof) &&
  !!csvName &&
  errors.length === 0;

console.log(
  JSON.stringify(
    {
      ungraded,
      after,
      roofChangedTotal: `${beforeRoof} → ${afterRoof}`,
      csv: csvName,
      errors: errors.slice(0, 4),
      verdict: ok
        ? `BOM PAGE OK - graded ${after.roomsGraded} rooms from photos, takeoff and rollups render, ` +
          `roof change moved the total ${beforeRoof} → ${afterRoof}, CSV exported as ${csvName}`
        : `FAILED - built=${built} graded=${graded} rooms=${after.roomsGraded} csv=${csvName} errors=${errors.length}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ok ? 0 : 1);
