/**
 * A house from an address, with nothing uploaded.
 *
 * The flow used to open with a file picker, which asks for the one thing the
 * user has to go and find. This drives the replacement: type an address, press
 * one button, get a house of the right shape.
 *
 * Deliberately run with no scraper token, because that is the harder case and
 * the one that proves the point. Without it there are no listing photographs at
 * all, so anything that appears came from the building's outline on the map and
 * from nothing the user supplied.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ADDRESS = "902 23rd Avenue East, Seattle, WA 98112";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
if (await page.getByRole("button", { name: "Start over" }).count()) {
  await page.getByRole("button", { name: "Start over" }).click();
  await page.waitForTimeout(500);
}

// The address field must be the thing you land on, not something behind a
// disclosure triangle - that is the whole point of the change.
const field = page.getByLabel("Property address or listing link");
check("the address field is the front door", await field.count() === 1);
check("no photos have been provided", (await page.locator("img").count()) === 0);

await field.fill(ADDRESS);
await page.getByRole("button", { name: "Build it" }).click();

// Overpass and Nominatim are public and sometimes slow.
// "ground floor" rather than "outline": the page's own introduction talks
// about the building's outline, so matching that passed while the lookup was
// still spinning. A marker only the result can produce is the point.
let found = false;
const startedAt = Date.now();
for (let i = 0; i < 90 && !found; i++) {
  await page.waitForTimeout(2000);
  found = await page.evaluate(() => /ground floor/i.test(document.body.innerText));
}
check("the building was found on the map", found,
  (await page.evaluate(() => document.body.innerText)).slice(0, 300));

const summary = await page.evaluate(() => document.body.innerText);
const outline = /real outline, ([\d,]+) sqft/.exec(summary);
check("the outline reports a ground-floor area", Boolean(outline), outline?.[0]);
console.log(`  lookup took ${Math.round((Date.now() - startedAt) / 1000)}s`);

// And it must build without a single photograph.
const buildButton = page.getByRole("button", { name: "Build the house" });
check("the build button is offered with no photos", await buildButton.count() === 1);

if (await buildButton.count()) {
  await buildButton.click();
  let built = false;
  for (let i = 0; i < 40 && !built; i++) {
    await page.waitForTimeout(2000);
    built = await page.evaluate(() => /Here is your house/.test(document.body.innerText));
  }
  check("a house was built from the address alone", built);

  if (built) {
    const notes = await page.evaluate(() => document.body.innerText);
    const rooms = /(\d+) rooms, (\d+) doorways/.exec(notes);
    check("it has rooms and doorways", Boolean(rooms), notes.slice(0, 300));
    // A listing that said nothing about the house still has to produce a
    // plausible one. Three rooms is what a bare "house" used to parse to.
    check("an address with no facts still yields a whole house",
      Number(rooms?.[1] ?? 0) >= 6, `${rooms?.[1]} rooms`);
    check("the outline is credited, as the licence requires",
      /OpenStreetMap/.test(notes));
    console.log(`  ${rooms?.[0] ?? "?"} · outline ${outline?.[1] ?? "?"} sqft ground floor`);

    // "A house was built" must mean a model, not a document. The review screen
    // links to the tour, so following its own link is both the check and the
    // thing a user would actually do.
    const walk = page.getByRole("link", { name: "Walk through it" });
    check("the finished house links to its tour", await walk.count() === 1);
    if (await walk.count()) {
      await walk.click();
      await page.waitForTimeout(4000);
      const canvas = await page.locator("canvas").count();
      check("the model renders", canvas > 0, `${canvas} canvases`);
    }
  }
}

check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? `ADDRESS OK - "${ADDRESS}" became a house with nothing uploaded and no scraper`
    : `ADDRESS BROKEN - ${failures} failures`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
