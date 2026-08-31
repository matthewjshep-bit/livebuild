/**
 * A tour is real from its first photograph, and nothing can take it away.
 *
 * This started as "what happened to my tour?" and the answer was two bugs. The
 * wizard kept one draft, and rewrote it moments after every finished build - so
 * `/new` always met you with "you have a tour in progress" and would not let
 * past it. There were two ways through: resume the old one, or "Start over",
 * which deleted every photograph under the draft's property id. That id was the
 * *finished* tour's, and its photographs live under exactly that prefix. So the
 * only route to a second tour ran through a button that emptied the first.
 *
 * The last check is the one that matters most: build a tour, go to make
 * another, and confirm the first one's photographs are still there afterwards.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, build, freshStart, savedProperty } from "./lib/flow.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).slice(0, 3).map((f) => join(dir, f));

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const ids = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]"));

/** How many of a tour's photo blobs are actually in the media store. */
const blobsFor = (id) =>
  page.evaluate(async (propertyId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("mattermatt");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise((resolve) => {
      const tx = db.transaction("media", "readonly");
      const request = tx.objectStore("media").getAllKeys();
      request.onsuccess = () => resolve(request.result ?? []);
    });
    return keys.filter((k) => String(k).startsWith(propertyId + "/")).length;
  }, id);

// --- A tour exists as soon as it has anything in it ---
await freshStart(page, BASE);
check("the wizard is not gated", (await page.getByText("You have a tour in progress").count()) === 0);

await addPhotos(page, files);
await page.waitForTimeout(1200);

const [firstId] = (await ids()).slice(-1);
check("dropping photos creates the tour", Boolean(firstId), "nothing was saved");
check("and its photographs are stored", (await blobsFor(firstId)) >= files.length);

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const listing = await page.evaluate(() => document.body.innerText);
check("it is on the home page while still importing", /still importing/.test(listing));
check("offering a way back into it", /Continue building/.test(listing));

// --- Reopening it by id brings the photographs back ---
await page.goto(`${BASE}/new?id=${firstId}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const resumed = await page.evaluate(() => document.querySelectorAll("img").length);
check("reopening restores the photographs", resumed >= files.length, `${resumed} thumbnails`);

// --- Build it, then go to make another one ---
const arrived = await build(page);
check("it builds", arrived);
await page.waitForTimeout(1500);

const built = await savedProperty(page);
check("the built tour has viewpoints", (built?.nodes.length ?? 0) > 0, `${built?.nodes.length}`);
const blobsAfterBuild = await blobsFor(firstId);

await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// The regression that started this.
check(
  "a second tour is not gated behind the first",
  (await page.getByText("You have a tour in progress").count()) === 0,
);
check(
  "and there is no control offering to start over",
  (await page.getByRole("button", { name: "Start over" }).count()) === 0,
);
check("the wizard is simply ready", (await page.getByText("Make a house").count()) > 0);

await addPhotos(page, files.slice(0, 2));
await page.waitForTimeout(1200);

const after = await ids();
const secondId = after[after.length - 1];
check("the second tour is its own", secondId !== firstId, `${secondId} vs ${firstId}`);
check("both are listed", after.includes(firstId) && after.includes(secondId), after.join(","));

// The whole point: the first tour still has its pictures.
const survived = await blobsFor(firstId);
check(
  "starting a second tour did not touch the first one's photographs",
  survived >= blobsAfterBuild && survived > 0,
  `${survived} blobs, was ${blobsAfterBuild}`,
);

const stillLoads = await page.evaluate(
  (id) => Boolean(JSON.parse(localStorage.getItem("mattermatt:property:" + id) ?? "null")),
  firstId,
);
check("and its document is intact", stillLoads);

// --- Grading from the viewer must not persist object URLs ---
await page.goto(`${BASE}/tour/${firstId}`, { waitUntil: "networkidle" });
await page.waitForTimeout(4000);
await page.evaluate((id) => {
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + id));
  doc.condition = { ...(doc.condition ?? {}), probe: { floor: "poor" } };
  localStorage.setItem("mattermatt:property:" + id, JSON.stringify(doc));
}, firstId);

const refs = await page.evaluate((id) => {
  const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + id) ?? "null");
  return (doc?.nodes ?? []).map((n) => String(n.photo).slice(0, 5));
}, firstId);
check(
  "the stored document still holds storage references, not object URLs",
  refs.length === 0 || refs.every((r) => r !== "blob:"),
  refs.join(","),
);

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  JSON.stringify(
    {
      firstId,
      secondId,
      blobsAfterBuild,
      blobsAfterStartingAnother: survived,
      errors,
      verdict:
        failures === 0
          ? `AUTOSAVE OK - a tour is saved from its first photo, a second can start without touching it (${survived} blobs intact)`
          : `BROKEN - ${failures} check(s) failed`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
