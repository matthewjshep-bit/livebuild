/**
 * The outside of the house is read from its own photograph.
 *
 * Builds a house from the interior demo photographs and one photograph of an
 * exterior, and checks that the exterior photograph is kept rather than
 * "left out", that the read runs for it under the same gate as the rooms,
 * and that the tour opens with what it read: a "This house" scheme wearing
 * the photographed siding colour.
 *
 * There is no exterior photograph in the repository - every demo image is a
 * room - so this needs one placed at `public/properties/demo-house/exterior/
 * front-01.jpg`, outside the `photos/` folder that `oneclick-test` counts.
 * Without it, or without a key, the suite says so and passes.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { addPhotos, build, freshStart, waitForWalkThrough } from "./lib/flow.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EXTERIOR = "public/properties/demo-house/exterior/front-01.jpg";
const INTERIOR = ["kitchen-01", "living-01", "bedroom-01", "bath-01"].map((n) => `public/properties/demo-house/photos/${n}.jpg`);

if (!existsSync(EXTERIOR)) {
  console.log(`SKIPPED - no exterior photograph at ${EXTERIOR}; put one there to run this`);
  process.exit(0);
}
const key = await fetch(`${BASE}/api/exterior-read`).then((r) => r.json()).catch(() => ({ available: false }));
if (!key.available) {
  console.log("SKIPPED - no API key on the server, so nothing can be read");
  process.exit(0);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await freshStart(page, BASE);
await addPhotos(page, [...INTERIOR, EXTERIOR]);
const built = await build(page, { house: { beds: 2, baths: 1, floors: 1 } });
check("a house was built", built);

const kept = await page.evaluate(() => /photograph(s)? of the outside, kept/.test(document.body.innerText));
check("the review says the outside photograph was kept", kept);
check("and does not say it was left out", !(await page.evaluate(() => /left out/.test(document.body.innerText))));

check("the tour opens once the photographs, the outside included, are read", await waitForWalkThrough(page, { timeoutMs: 300_000 }));

const doc = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const d = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
  return { id: d?.id, nodes: d?.nodes?.length ?? 0, exteriorPhotos: d?.exteriorPhotos?.length ?? 0, exterior: d?.spec?.exterior ?? null };
});
check("the exterior photograph is kept apart from the rooms'", doc.exteriorPhotos === 1 && doc.nodes === INTERIOR.length, JSON.stringify({ nodes: doc.nodes, exteriorPhotos: doc.exteriorPhotos }));
check("the outside was read", doc.exterior?.observed === true, JSON.stringify(doc.exterior)?.slice(0, 200));
const readColour = doc.exterior?.siding?.colour ?? doc.exterior?.roof?.colour ?? null;
check("and something about it came back", readColour !== null || (doc.exterior?.features?.length ?? 0) > 0, JSON.stringify(doc.exterior)?.slice(0, 300));
if (doc.exterior?.siding?.colour) {
  check("the siding colour is marked as read", doc.exterior.source?.["siding.colour"] === "read");
}
console.log("  read:", JSON.stringify({ siding: doc.exterior?.siding, roof: doc.exterior?.roof, features: doc.exterior?.features?.map((f) => f.kind) }));

await page.goto(`${BASE}/tour/${doc.id}`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__scene && window.__scene.meshes > 0, { timeout: 45_000 });
await page.waitForTimeout(2500);
const scene = await page.evaluate(() => window.__scene);
check("the house is clad", (scene.bySurface?.siding ?? 0) > 0);
check("no photograph is on the model", scene.photoTextures === 0);
if (readColour) {
  const selected = await page.evaluate(() => document.querySelector("select[aria-label='Interior scheme']")?.value);
  check("the tour opens in this house's own colours", selected === "This house", `${selected}`);
}
check("the outside panel is there", (await page.locator("[data-exterior-spec]").count()) === 1);
await page.screenshot({ path: "shots/X1-exterior-read.png" });

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
console.log(failures === 0 ? "EXTERIOR PHOTO OK - the outside was kept, read under the gate, and the tour opened wearing it" : `EXTERIOR PHOTO BROKEN - ${failures} failure(s)`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
