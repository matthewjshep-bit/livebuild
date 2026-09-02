/**
 * A house drawn with a pen, read without a round trip.
 *
 * The drawing pad used to flatten its strokes to a JPEG and send them to a
 * vision model to be read back as rectangles. This drives the real surface with
 * a real pointer - badly, the way a hand does - and asserts that the rooms come
 * out of the browser, that a mistake is refused with somewhere to look, and
 * that no request is made to read the drawing at all.
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
await page.getByTestId("build-from-sheet").click();

// Wait for the layout stage.
let there = false;
for (let i = 0; i < 80 && !there; i++) {
  await page.waitForTimeout(1500);
  there = (await page.getByTestId("draw-freehand").count()) > 0;
}
check("the layout stage offers drawing by hand", there);
if (!there) { console.log(JSON.stringify({ verdict: "FREEHAND BROKEN - never reached the stage" })); await browser.close(); process.exit(1); }

await page.getByTestId("draw-freehand").click();
await page.waitForTimeout(600);
const board = page.getByTestId("drawing-board");
check("the board is there", (await board.count()) === 1);

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

async function name(fx, fy, text) {
  await page.getByRole("button", { name: "Name a room" }).click();
  const [x, y] = at(fx, fy);
  await page.mouse.click(x, y);
  await page.waitForTimeout(250);
  await page.getByLabel("Room name").fill(text);
  await page.getByRole("button", { name: "Add" }).click();
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "Draw walls" }).click();
}

// --- an outline with one wall down the middle, drawn badly ---
await line([0.15, 0.2], [0.85, 0.2]);
await line([0.85, 0.2], [0.85, 0.8]);
await line([0.85, 0.8], [0.15, 0.8]);
await line([0.15, 0.8], [0.15, 0.2]);
await page.screenshot({ path: "shots/F1-drawn-outline.png" });

// Named before there is a wall between them: two names, one space.
await name(0.32, 0.5, "Kitchen");
await name(0.68, 0.5, "Living Room");
await page.getByTestId("read-drawing").click();
await page.waitForTimeout(700);

const complaint = await page.getByTestId("drawing-problem").count();
check("two names in one space is refused", complaint === 1);
if (complaint) {
  const why = await page.getByTestId("drawing-problem").innerText();
  check("and asks the right question", /same space/.test(why) && /wall missing/.test(why), why);
}
await page.screenshot({ path: "shots/F2-drawn-refused.png" });

// Put the wall in and try again.
await line([0.5, 0.2], [0.5, 0.8]);
await page.getByTestId("read-drawing").click();
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/F3-drawn-accepted.png" });

const after = await page.evaluate(() => ({
  stillDrawing: Boolean(document.querySelector('[data-testid="drawing-board"]')),
  summary: document.body.innerText.match(/(\d+) rooms, (\d+) doorways\./)?.[0] ?? null,
}));
check("the drawing is accepted", !after.stillDrawing);
check("and becomes rooms with doorways", /2 rooms, [1-9]/.test(after.summary ?? ""), `${after.summary}`);

// The point of doing it in the browser.
check("nothing was sent away to read the drawing",
  !calls.some((c) => c === "POST /api/sketch"),
  calls.filter((c) => c.includes("sketch")).join(", "));

console.log(JSON.stringify({
  summary: after.summary,
  sketchCalls: calls.filter((c) => c.includes("sketch")),
  errors: errors.slice(0, 3),
  verdict: failures === 0
    ? `FREEHAND OK - a wobbly plan drawn with the pointer became ${after.summary}, refused two names in one space first, and never left the browser`
    : `FREEHAND BROKEN - ${failures} failures`,
}, null, 2));
await browser.close();
process.exit(failures === 0 ? 0 : 1);
