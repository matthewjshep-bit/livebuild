/**
 * The tour you open is the one the photographs describe.
 *
 * The house is built, shown, and *then* its photographs are read - a minute or
 * two of work that repaints the rooms as it goes. "Walk through it" was a link
 * the whole time, and a same-tab link, so pressing it unmounted the page that
 * was doing the reading. Anyone who opened the tour within a couple of minutes
 * of building it saw the default scheme - "the default new-build look", in the
 * code's own words - and the rooms not yet read stayed that way for good.
 *
 * The invariant is simple to state and worth stating exactly: at no moment is
 * there both a reading bar on screen and a way to leave. The link exists only
 * once the reading does not.
 */
import { chromium } from "playwright";
import { addPhotos, build, freshStart } from "./lib/flow.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PHOTOS = [
  "public/properties/demo-house/photos/kitchen-01.jpg",
  "public/properties/demo-house/photos/living-01.jpg",
  "public/properties/demo-house/photos/bedroom-01.jpg",
  "public/properties/demo-house/photos/bath-01.jpg",
];

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
await addPhotos(page, PHOTOS);
const built = await build(page, { house: { beds: 2, baths: 1, floors: 1 } });
check("a house was built", built);

/**
 * Watch the two things together, every 200ms, until the reading is over.
 *
 * Checking once would race the read: on a fast day it can finish between the
 * house appearing and the first look. Watching the pair continuously is the
 * only way to assert "never both", and it also records whether the gate was
 * ever seen closed at all - which on a real key it should be.
 */
const state = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="walk-through"]');
    return {
      reading: /Reading what each room is made of/.test(document.body.innerText),
      link: el?.tagName === "A",
      gated: el?.tagName === "BUTTON" && el.hasAttribute("disabled"),
      label: el?.textContent?.trim() ?? "",
    };
  });

let sawGate = false;
let bothAtOnce = 0;
let unlabelled = 0;
let finished = false;
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  const s = await state();
  if (s.gated) {
    sawGate = true;
    if (!/Reading the photographs/.test(s.label)) unlabelled++;
  }
  if (s.reading && s.link) bothAtOnce++;
  if (!s.reading && s.link) {
    finished = true;
    break;
  }
  await page.waitForTimeout(200);
}

check("the way out is never offered while the photographs are being read", bothAtOnce === 0, `${bothAtOnce} tick(s)`);
check("the reading finished and the link appeared", finished);
if (sawGate) {
  check("the gate says what it is waiting for", unlabelled === 0, `${unlabelled} unlabelled tick(s)`);
} else {
  console.log("  (the read finished before the gate was ever observed — the invariant still held)");
}

// And what opens is the read house, not the guess. The demo kitchen photograph
// is a wooden floor; the room list's guess for a kitchen is tile.
if (finished) {
  const spec = await page.evaluate(() => {
    const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
    const doc = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
    const rooms = doc?.spec?.rooms ?? {};
    const kitchenId = (doc?.plan?.rooms ?? []).find((r) => /kitchen/i.test(r.label))?.id;
    return { read: doc?.spec ? Object.values(rooms).filter((r) => r.observed).length : 0, kitchen: kitchenId ? rooms[kitchenId] : null };
  });
  check("at least one room was actually read from its photographs", spec.read > 0, `${spec.read} observed`);
  if (spec.kitchen?.floor?.material) {
    check(
      "the kitchen's floor came from the photograph, not the room list",
      spec.kitchen.source?.["floor.material"] === "read",
      `${spec.kitchen.floor.material} via ${spec.kitchen.source?.["floor.material"]}`,
    );
  }
}

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? "READ GATE OK - the tour is held until the photographs are read, the gate says so, and what opens was read rather than guessed"
    : `READ GATE BROKEN - ${failures} failure(s)`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
