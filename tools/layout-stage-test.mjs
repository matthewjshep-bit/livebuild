/**
 * The layout is drawn before the house is built, and the gate is real.
 *
 * Two things are being proved. First that the drawing reaches this stage
 * already fitted to the building: the canvas used to open empty and ask for
 * nine rectangles to be dragged into an irregular outline, which is not a thing
 * a person can do - so what lands here now is the plan somebody drew, with only
 * its dimensions given up to the outline the map measured. Second, and the part
 * that matters, that the gate is not decorative - a drawing with a hole in it
 * must refuse to build, because a piece of a house belonging to no room is a
 * room with no doorways into it, and that is invisible until somebody walks the
 * tour and hits a dead end.
 *
 * Driven from an address rather than photographs, because an address is what
 * produces a measured outline, and the outline is the whole point of fitting to
 * it.
 */
import { chromium } from "playwright";
import { chooseMode, drawRooms } from "./lib/flow.mjs";

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
await page.waitForTimeout(900);
// The wizard opens on a choice now - a room or a whole house - so every suite
// that drives it has to answer that before it reaches the photo screen.
await chooseMode(page);
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

// The address lands on the photo screen with the listing's facts read; the
// sheet is the next step whether or not any photographs were dropped.
await page.getByTestId("continue-from-photos").click();
await page.waitForTimeout(800);

// --- the sheet leads to the pen, and the pen comes before the build ---
await page.getByTestId("build-from-sheet").click();
await page.waitForTimeout(900);
check("the sheet leads straight to the board", (await page.getByTestId("drawing-board").count()) === 1);
await page.screenshot({ path: "shots/L1-drawing.png" });

const drew = await drawRooms(page);
check("a house can be drawn", drew);
if (!drew) {
  console.log(JSON.stringify({ verdict: "THE DRAWING WAS REFUSED", errors }, null, 2));
  await browser.close();
  process.exit(1);
}

// --- and arrives fitted to the building the map measured ---
let arrived = false;
for (let i = 0; i < 120 && !arrived; i++) {
  await page.waitForTimeout(1500);
  arrived = (await page.getByTestId("build-from-layout").count()) > 0;
}
check("the build stops to be confirmed", arrived);
if (!arrived) {
  console.log(JSON.stringify({ verdict: "LAYOUT STAGE NEVER APPEARED", errors }, null, 2));
  await browser.close();
  process.exit(1);
}

await page.waitForTimeout(800);
await page.screenshot({ path: "shots/L2-layout-fitted.png" });

const fittedIn = await page.evaluate(() => ({
  text: document.body.innerText,
  // The measured outline, drawn beneath everything and never interactive.
  boundaries: document.querySelectorAll("svg polygon").length,
  faults: document.querySelectorAll('[data-testid="layout-fault"]').length,
  canBuild: !document.querySelector('[data-testid="build-from-layout"]')?.disabled,
}));

check("the drawing arrives already placed", /\d+ rooms, \d+ doorways\./.test(fittedIn.text), fittedIn.text.slice(0, 200));
check("inside the measured outline", fittedIn.boundaries >= 1, `${fittedIn.boundaries}`);
check("with nothing wrong with it", fittedIn.faults === 0, fittedIn.text.slice(0, 200));
check("and can be built without dragging anything", fittedIn.canBuild);

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

  // Fitting is the way out of a gate that dragging cannot satisfy: keep the
  // arrangement, give up the sizes, let the packer produce the exact tiling.
  await page.getByTestId("fit-layout").click();
  await page.waitForTimeout(1200);
  const fitted = await page.evaluate(() => ({
    faults: document.querySelectorAll('[data-testid="layout-fault"]').length,
    canBuild: !document.querySelector('[data-testid="build-from-layout"]')?.disabled,
    summary: document.body.innerText.match(/(\d+) rooms, (\d+) doorways\./)?.[0] ?? null,
  }));
  check("fitting clears the fault in one press", fitted.faults === 0, JSON.stringify(fitted));
  check("and the house can be built", fitted.canBuild);
  check("with doorways between the rooms", /[1-9]\d* doorways/.test(fitted.summary ?? ""),
    `${fitted.summary}`);
  await page.screenshot({ path: "shots/L3b-fitted.png" });

  // Undo restores it, and the gate clears.
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(800);
  const mended = await page.evaluate(() => ({
    faults: document.querySelectorAll('[data-testid="layout-fault"]').length,
    canBuild: !document.querySelector('[data-testid="build-from-layout"]')?.disabled,
  }));
  check("undo leaves a buildable plan", mended.faults === 0 && mended.canBuild,
    JSON.stringify(mended));
}

// --- a drawing survives the tab being reloaded ---
//
// The one thing on the import record that cannot be recovered by asking again.
// The photographs are in the media store, the listing can be re-scraped, the
// classifier can be re-run; a hand-drawn house cannot be got back from
// anything, so losing it to a refresh would be the worst failure here.
const before = await page.evaluate(() => {
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  return {
    id: index[index.length - 1],
    summary: document.body.innerText.match(/(\d+) rooms, (\d+) doorways\./)?.[0] ?? null,
  };
});
check("there is a property to resume", Boolean(before.id));

if (before.id) {
  await page.goto(`${base}/new?id=${before.id}`, { waitUntil: "domcontentloaded" });
  let back = false;
  for (let i = 0; i < 30 && !back; i++) {
    await page.waitForTimeout(1000);
    back = (await page.getByTestId("build-from-layout").count()) > 0;
  }
  check("a reload comes back to the drawing, not to the start", back);
  await page.screenshot({ path: "shots/L4-reloaded.png" });

  const after = await page.evaluate(() => ({
    summary: document.body.innerText.match(/(\d+) rooms, (\d+) doorways\./)?.[0] ?? null,
    canBuild: !document.querySelector('[data-testid="build-from-layout"]')?.disabled,
    boundaries: document.querySelectorAll("svg polygon").length,
  }));
  check("with the same layout intact", after.summary === before.summary,
    `${before.summary} -> ${after.summary}`);
  check("and the measured outline still there", after.boundaries >= 1);
  check("and still buildable", after.canBuild);
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
  const index = JSON.parse(localStorage.getItem("mattermatt:index") ?? "[]");
  const d = JSON.parse(localStorage.getItem("mattermatt:property:" + index.pop()) ?? "null");
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
