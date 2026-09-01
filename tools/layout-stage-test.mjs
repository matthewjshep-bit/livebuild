/**
 * The layout is drawn before the house is built, and the gate is real.
 *
 * Two things are being proved. First that the stage exists at all and stops the
 * build: the canvas opens empty, the rooms the house is known to have are
 * listed to place, and nothing is constructed until somebody says so. Second,
 * and the part that matters, that the gate is not decorative - a drawing with a
 * hole in it must refuse to build, because a piece of a house belonging to no
 * room is a room with no doorways into it, and that is invisible until somebody
 * walks the tour and hits a dead end.
 *
 * Driven from an address rather than photographs, because an address is what
 * produces a measured outline, and the outline is the whole point of drawing
 * inside it.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const ADDRESS = "902 23rd Avenue East, Seattle, WA 98112";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${base}/new`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
if (await page.getByRole("button", { name: "Start over" }).count()) {
  await page.getByRole("button", { name: "Start over" }).click();
  await page.waitForTimeout(400);
}

await page.getByLabel("Property address or listing link").fill(ADDRESS);
await page.getByRole("button", { name: "Find it" }).click();

let found = false;
for (let i = 0; i < 90 && !found; i++) {
  await page.waitForTimeout(2000);
  found = await page.evaluate(() => /ground floor/i.test(document.body.innerText));
}
if (!found) {
  console.log(JSON.stringify({ skipped: "the map lookup did not answer", errors }, null, 2));
  await browser.close();
  process.exit(0);
}

await page.getByRole("button", { name: "Build the house" }).click();

// --- the stage stops the build ---
let arrived = false;
for (let i = 0; i < 90 && !arrived; i++) {
  await page.waitForTimeout(1500);
  arrived = (await page.getByTestId("suggest-layout").count()) > 0;
}
check("the build stops to be drawn", arrived);
if (!arrived) {
  console.log(JSON.stringify({ verdict: "LAYOUT STAGE NEVER APPEARED", errors }, null, 2));
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(800);
await page.screenshot({ path: "shots/L1-layout-empty.png" });

const empty = await page.evaluate(() => ({
  text: document.body.innerText,
  // The measured outline, drawn beneath everything and never interactive.
  boundaries: document.querySelectorAll("svg polygon").length,
  unplaced: document.querySelectorAll('[data-testid="unplaced-room"]').length,
  canBuild: !document.querySelector('[data-testid="build-from-layout"]')?.disabled,
  rooms: (() => {
    const index = JSON.parse(localStorage.getItem("livebuild:index") ?? "[]");
    const doc = JSON.parse(localStorage.getItem("livebuild:property:" + index.pop()) ?? "null");
    return doc?.plan?.rooms?.length ?? null;
  })(),
}));

check("the canvas opens empty, as the user asked", !/\d+ rooms, \d+ doorways/.test(empty.text));
check("the measured outline is drawn to draw inside", empty.boundaries >= 1, `${empty.boundaries}`);
check("the rooms the house is known to have are listed", empty.unplaced > 0, `${empty.unplaced}`);
check("nothing can be built yet", !empty.canBuild);
check("and nothing has been saved yet", empty.rooms === null || empty.rooms === 0, `${empty.rooms}`);

// --- a suggestion fills it, and only when asked ---
await page.getByTestId("suggest-layout").click();
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await page.waitForTimeout(1500);
  ready = await page.getByTestId("build-from-layout").isEnabled().catch(() => false);
}
check("a suggestion can be asked for and fills the plan", ready);
await page.waitForTimeout(600);
await page.screenshot({ path: "shots/L2-layout-suggested.png" });

const suggested = await page.evaluate(() => ({
  text: document.body.innerText,
  faults: document.querySelectorAll('[data-testid="layout-fault"]').length,
}));
check("a suggested layout has no faults", suggested.faults === 0, suggested.text.slice(0, 200));
check("and reports what it drew", /\d+ rooms, \d+ doorways\./.test(suggested.text));

// --- the gate refuses a drawing with a hole in it ---
//
// Deleting a room leaves its floor belonging to nobody. That is the one fault a
// careful person still reaches, and the build must not proceed through it.
await page.locator("svg rect[style*='cursor: grab']").first().click();
await page.waitForTimeout(400);
const deleteButton = page.getByRole("button", { name: "Delete" });
check("a room can be selected and removed", await deleteButton.count() > 0);
if (await deleteButton.count()) {
  await deleteButton.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "shots/L3-layout-gap.png" });

  const holed = await page.evaluate(() => ({
    faults: document.querySelectorAll('[data-testid="layout-fault"]').length,
    why: document.querySelector('[data-testid="layout-fault"]')?.textContent ?? "",
    canBuild: !document.querySelector('[data-testid="build-from-layout"]')?.disabled,
    unplaced: document.querySelectorAll('[data-testid="unplaced-room"]').length,
  }));
  check("a hole in the house is reported", holed.faults === 1, JSON.stringify(holed));
  check("and says what is wrong", /belongs to no room/.test(holed.why), holed.why);
  check("and the house cannot be built through it", !holed.canBuild);
  check("the room it lost is offered back", holed.unplaced > 0, `${holed.unplaced}`);

  // Undo restores it, and the gate clears.
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(800);
  const mended = await page.evaluate(() => ({
    faults: document.querySelectorAll('[data-testid="layout-fault"]').length,
    canBuild: !document.querySelector('[data-testid="build-from-layout"]')?.disabled,
  }));
  check("mending it clears the fault", mended.faults === 0);
  check("and the house can be built again", mended.canBuild);
}

// --- and it builds what was drawn ---
const drawnRooms = await page.evaluate(
  () => document.body.innerText.match(/(\d+) rooms, (\d+) doorways\./)?.[1] ?? null,
);
await page.getByTestId("build-from-layout").click();

let built = false;
for (let i = 0; i < 90 && !built; i++) {
  await page.waitForTimeout(2500);
  built = await page.evaluate(() => /Here is your house/.test(document.body.innerText));
}
check("the drawn layout builds a house", built);
await page.screenshot({ path: "shots/L4-built.png" });

const doc = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("livebuild:index") ?? "[]");
  const d = JSON.parse(localStorage.getItem("livebuild:property:" + index.pop()) ?? "null");
  return d
    ? { rooms: d.plan.rooms.length, doorways: d.plan.openings.length, id: d.id }
    : null;
});
check("the house was saved", Boolean(doc));
check("with the rooms that were drawn", String(doc?.rooms ?? "") === String(drawnRooms ?? ""),
  `drew ${drawnRooms}, saved ${doc?.rooms}`);
check("and doorways between them", (doc?.doorways ?? 0) > 0, `${doc?.doorways}`);

console.log(
  JSON.stringify(
    {
      drawnRooms,
      saved: doc,
      errors: errors.slice(0, 3),
      verdict:
        failures === 0
          ? `LAYOUT STAGE OK - the build stops to be drawn inside the measured outline, a hole refuses to build and says where, and what was drawn is what got built (${doc?.rooms} rooms, ${doc?.doorways} doorways)`
          : `LAYOUT STAGE BROKEN - ${failures} failures`,
    },
    null,
    2,
  ),
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
