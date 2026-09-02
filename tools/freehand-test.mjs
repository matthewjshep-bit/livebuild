/**
 * A house drawn with a pen, read without a round trip.
 *
 * The drawing pad used to flatten its strokes to a JPEG and send them to a
 * vision model to be read back as rectangles. This drives the real surface with
 * a real pointer - badly, the way a hand does - and asserts that the rooms come
 * out of the browser, that a mistake is refused with somewhere to look, and
 * that no request is made to read the drawing at all.
 *
 * It is the main path now rather than a detour, so it also covers what made
 * naming possible: the spaces appear as the walls close, the one under the
 * cursor lights up, the card stands clear of it, and the names on offer are the
 * ones the house sheet says the house has.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chooseMode } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const files = readdirSync("public/properties/demo-house/photos").map((f) =>
  join("public/properties/demo-house/photos", f),
);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) { failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const calls = [];
// Method as well as path: `SketchImport` GETs /api/sketch on mount purely to
// find out whether a key is configured, and that is not the drawing being sent
// anywhere. Reading one would be a POST.
page.on("request", (r) => {
  if (r.url().includes("/api/")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
});

await page.goto(`${base}/new`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await chooseMode(page, "house");
await page.setInputFiles('input[type="file"]', files);
await page.waitForTimeout(2500);
await page.getByTestId("continue-from-photos").click();
await page.waitForTimeout(700);
// The sheet leads to the pen now, and the pen comes before the build - so this
// is reached in a moment rather than after a minute of classification.
await page.getByTestId("build-from-sheet").click();
await page.waitForTimeout(800);

const board = page.getByTestId("drawing-board");
check("the sheet leads straight to the board", (await board.count()) === 1);
if ((await board.count()) === 0) { console.log(JSON.stringify({ verdict: "FREEHAND BROKEN - never reached the board" })); await browser.close(); process.exit(1); }

// Nothing has been classified yet: the drawing is what the build is told.
check("and nothing has been sent away yet", !calls.some((c) => c.startsWith("POST /api/classify")), calls.join(", "));

const wanted = await page.$$eval(
  '[data-testid="wanted-missing"], [data-testid="wanted-drawn"]',
  (els) => els.map((e) => e.dataset.room),
);
check("the house sheet's rooms are listed to draw", wanted.includes("Kitchen") && wanted.length >= 6, wanted.join(", "));

const box = await board.boundingBox();
const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

/** A line drawn the way a hand draws one: in steps, with a wobble. */
async function line(from, to, steps = 16) {
  const [x0, y0] = at(...from);
  const [x1, y1] = at(...to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const jitter = i === steps ? 0 : (Math.sin(i * 2.1) * 1.8);
    await page.mouse.move(x0 + (x1 - x0) * t + jitter, y0 + (y1 - y0) * t + jitter);
  }
  await page.mouse.up();
  await page.waitForTimeout(60);
}

/** Name whichever space is under a point, by pressing the chip for it. */
async function nameByChip(fx, fy, text) {
  await page.getByRole("button", { name: "Name a room" }).click();
  const [x, y] = at(fx, fy);
  await page.mouse.click(x, y);
  await page.waitForTimeout(250);
  const chip = page.getByTestId("name-chip").filter({ hasText: text }).first();
  if ((await chip.count()) === 0) {
    await page.getByLabel("Room name").fill(text);
    await page.getByRole("button", { name: "Add" }).click();
  } else {
    await chip.click();
  }
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Draw walls" }).click();
}

// --- an outline, drawn badly ---
await line([0.15, 0.2], [0.85, 0.2]);
await line([0.85, 0.2], [0.85, 0.8]);
await line([0.85, 0.8], [0.15, 0.8]);
await line([0.15, 0.8], [0.15, 0.2]);
await page.waitForTimeout(400);
await page.screenshot({ path: "shots/F1-drawn-outline.png" });

// One closed space, and it is visible as one before anybody names anything.
check("a closed outline is one space", /of 1 named/.test(await page.getByTestId("drawing-status").innerText()), await page.getByTestId("drawing-status").innerText());

// --- a wall down the middle makes two ---
await line([0.5, 0.2], [0.5, 0.8]);
await page.waitForTimeout(400);
check("the wall makes a second space", /of 2 named/.test(await page.getByTestId("drawing-status").innerText()), await page.getByTestId("drawing-status").innerText());

// --- the card stands clear of the room it names ---
//
// The left-hand room, because it has a neighbour to its right for the card to
// stand in. Anywhere but on top of the lit room will do; seeing which space is
// being named is the whole reason this is better than the old pinned card.
await page.getByRole("button", { name: "Name a room" }).click();
await page.waitForTimeout(150);
const [cx, cy] = at(0.32, 0.5);
await page.mouse.click(cx, cy);
await page.waitForTimeout(250);
check("clicking a space opens a card", (await page.getByTestId("naming-card").count()) === 1);
const cardBox = await page.getByTestId("naming-card").boundingBox();
const wallX = at(0.5, 0)[0];
check(
  "the card stands clear of the room it names",
  cardBox && cardBox.x >= wallX - 2,
  `card at ${cardBox && Math.round(cardBox.x)}, room ends at ${Math.round(wallX)}`,
);
const chips = await page.$$eval('[data-testid="name-chip"]', (els) => els.map((e) => e.textContent));
check("and offers the rooms the house has", chips.includes("Kitchen"), chips.join(", "));
await page.screenshot({ path: "shots/F2-naming-card.png" });
await page.getByRole("button", { name: "Close" }).click();

// A click out in the margins names nothing, and says so rather than failing later.
await page.mouse.click(...at(0.04, 0.5));
await page.waitForTimeout(200);
const outside = await page.getByTestId("drawing-problem").count();
check("clicking outside every room is refused on the spot", outside === 1);
if (outside) {
  check("and says where to click", /inside a room/.test(await page.getByTestId("drawing-problem").innerText()));
}

// --- turning the drawing, for a house drawn facing the wrong way ---
//
// The plan is the thing that might be ninety degrees out; the building outline
// and the streets are survey data and must not move. Two quarter turns in
// opposite directions is the check that costs nothing and catches a sign error,
// which is the way this goes wrong and looks fine while doing it.
{
  const before = await page.getByTestId("drawing-status").innerText();
  await page.getByTestId("rotate-right").click();
  await page.waitForTimeout(350);
  const turned = await page.getByTestId("drawing-status").innerText();
  check("a turn keeps every space it had", turned === before, `${before} -> ${turned}`);

  await page.getByTestId("rotate-left").click();
  await page.waitForTimeout(350);
  check(
    "and turning back leaves it as it was",
    (await page.getByTestId("drawing-status").innerText()) === before,
  );

  // One entry on the timeline, not one per wall: a turn is a single thing
  // somebody did and undoing it a wall at a time would be absurd.
  await page.getByTestId("rotate-right").click();
  await page.waitForTimeout(350);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(350);
  check(
    "and one undo takes a whole turn back",
    (await page.getByTestId("drawing-status").innerText()) === before,
    await page.getByTestId("drawing-status").innerText(),
  );
}

// --- a wall gone over twice is one wall ---
//
// The report this was written for: going back over a line, which is how people
// draw, left a thin cavity between the two strokes and the reader called it a
// room. Six of those came out as "6 spaces have no name" and no way forward.
{
  await page.getByRole("button", { name: "Draw walls" }).click();
  await page.waitForTimeout(150);
  const spaces = () =>
    page.getByTestId("drawing-status").innerText().then((t) => Number(/of (\d+)/.exec(t)?.[1] ?? 0));
  const was = await spaces();
  // Along the middle wall again, a few pixels over - a redraw, not a new wall.
  await line([0.505, 0.2], [0.505, 0.8]);
  await page.waitForTimeout(450);
  check(
    "going over a wall again does not make a room",
    (await spaces()) === was,
    `${was} spaces before, ${await spaces()} after`,
  );
}

// --- name both halves off the chips ---

await nameByChip(0.32, 0.5, "Kitchen");
await nameByChip(0.68, 0.5, "Living Room");
check("both spaces are named", /2 of 2 named/.test(await page.getByTestId("drawing-status").innerText()), await page.getByTestId("drawing-status").innerText());
await page.screenshot({ path: "shots/F3-drawn-named.png" });

await page.getByTestId("read-drawing").click();

// The build runs from here, so this is the long wait rather than the drawing.
let after = null;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1500);
  after = await page.evaluate(() => ({
    stillDrawing: Boolean(document.querySelector('[data-testid="drawing-board"]')),
    summary: document.body.innerText.match(/(\d+) rooms, (\d+) doorways\./)?.[0] ?? null,
    fitted: /Does this look right/.test(document.body.innerText),
  }));
  if (after.fitted) break;
}
await page.screenshot({ path: "shots/F4-fitted.png" });
check("the drawing is accepted", after && !after.stillDrawing);
check("and lands on the fitted plan", Boolean(after?.fitted));
check("as rooms with doorways", /2 rooms, [1-9]/.test(after?.summary ?? ""), `${after?.summary}`);

// The point of doing it in the browser.
check("nothing was sent away to read the drawing",
  !calls.some((c) => c === "POST /api/sketch"),
  calls.filter((c) => c.includes("sketch")).join(", "));

console.log(JSON.stringify({
  summary: after?.summary,
  sketchCalls: calls.filter((c) => c.includes("sketch")),
  errors: errors.slice(0, 3),
  verdict: failures === 0
    ? `FREEHAND OK - a wobbly plan drawn with the pointer became ${after?.summary}, its spaces lit up as they closed, a wall gone over twice stayed one wall, the drawing turns and turns back, the names came off the house sheet, and it never left the browser`
    : `FREEHAND BROKEN - ${failures} failures`,
}, null, 2));
await browser.close();
process.exit(failures === 0 ? 0 : 1);
