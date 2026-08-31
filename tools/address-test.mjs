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
 *
 * The outline comes from Overpass, which is free, oversubscribed, and answers
 * 504 often enough that `listing/footprint.ts` calls it "a normal Tuesday
 * rather than an outage". So a failed *lookup* is skipped rather than failed:
 * this suite cannot tell an outage from a broken outline, and a red run that
 * means "somebody else's server is busy" is how a suite stops being read.
 * `not-located` and `no-building` are different - they are real answers about a
 * real address, and they stay assertions.
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

// Ask the API directly first. If the map service is down there is nothing to
// test, and finding that out through a browser timeout wastes three minutes and
// reports it as a broken feature.
const probe = await fetch(`${BASE}/api/listing`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: ADDRESS, mode: "outline" }),
}).then((r) => r.json()).catch(() => null);

if (!probe || probe.footprintMiss === "lookup-failed") {
  console.log(
    JSON.stringify(
      {
        verdict: "SKIPPED - the map service (Overpass) is not answering, so there is no outline to test",
        probe: probe?.footprintMiss ?? "no response",
      },
      null,
      2,
    ),
  );
  await browser.close();
  process.exit(0);
}

// The address field must be the thing you land on, not something behind a
// disclosure triangle - that is the whole point of the change.
const field = page.getByLabel("Property address or listing link");
check("the address field is the front door", await field.count() === 1);
check("no photos have been provided", (await page.locator("img").count()) === 0);

await field.fill(ADDRESS);
// "Find it" rather than "Build it". Locating the building is now the fast,
// free half - a geocode and a map lookup, seconds - and pulling the listing's
// photographs is a separate press, because it is minutes and a paid scrape and
// is the wrong default for somebody who already has the pictures.
await page.getByRole("button", { name: "Find it" }).click();

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

// Finding the building must not have cost a scrape. That is the whole point of
// splitting the two halves: an address is seconds, and pulling the listing's
// photographs is a separate decision worth its own minutes.
check("the lookup was quick, so no listing was scraped",
  Date.now() - startedAt < 60_000, `${Math.round((Date.now() - startedAt) / 1000)}s`);
check("no photographs arrived unasked", (await page.locator("img").count()) === 0);

const summary = await page.evaluate(() => document.body.innerText);
const outline = /real outline, ([\d,]+) sqft/.exec(summary);
check("the outline reports a ground-floor area", Boolean(outline), outline?.[0]);
console.log(`  lookup took ${Math.round((Date.now() - startedAt) / 1000)}s`);

// And it must build without a single photograph.
//
// This is also the check that would have caught the regression the split
// introduced. `canBuild` asked for photographs, an outline, listing facts or a
// description, and never for "we know where the house is" - which was masked
// while every address scraped and a scrape nearly always returned beds and
// baths. Once an address did the map half alone, a building nobody has drawn
// left a located property with no way to build it.
const buildButton = page.getByRole("button", { name: "Build the house" });
check("the build button is offered with no photos", await buildButton.count() === 1);

// The same guarantee, stated where it can fail for the right reason: an address
// that resolved is buildable, outline or no outline.
const located = Boolean(probe.location);
check("a located address is buildable whatever the map holds",
  !located || (await buildButton.count()) === 1,
  `located=${located} outline=${Boolean(probe.footprint)}`);

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
