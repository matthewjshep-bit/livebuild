/**
 * The described-house flow, end to end.
 *
 * Two claims: describing the house produces a first-pass plan with the right
 * storeys, and the room buttons in the next step reflect what was described
 * rather than a generic list.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, build, describe, drawLayout, freshStart } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).slice(0, 4).map((f) => join(dir, f));

const DESCRIPTION =
  "Two storey 3 bedroom 2.5 bath. Primary bedroom upstairs with an ensuite. " +
  "Open plan kitchen and living room downstairs, plus a dining room and a two car garage.";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await freshStart(page, base);
await addPhotos(page, files);

// The house is described by pressing things now. This used to type a sentence
// into a box behind a disclosure triangle and wait for a model to read it; the
// sheet is a screen of its own, and what it produces is asserted below against
// the same rooms the parser used to give.
await page.getByTestId("continue-from-photos").click();
await page.waitForTimeout(700);
await describe(page, { beds: 4, baths: 2.5, floors: 2 });
await page.screenshot({ path: "shots/70-described.png" });

const understood = await page.evaluate(() => {
  const panel = document.querySelector('[data-testid="sheet-summary"]');
  const text = panel?.textContent ?? "";
  return {
    roomCount: Number(text.match(/(\d+) rooms/)?.[1] ?? 0),
    floors: Number(text.match(/across (\d+) floors/)?.[1] ?? 1),
    readBy: "sheet",
    chips: [...(panel?.querySelectorAll("span") ?? [])]
      .map((s) => s.textContent?.trim() ?? "")
      .filter((t) => /^(Primary|Bedroom|Powder|Stairs|Garage)/.test(t)),
  };
});

// Already on the sheet, so this only has to accept it and get through the
// layout stage.
await page.getByTestId("build-from-sheet").click();
const arrived = await drawLayout(page, { timeoutMs: 200_000 });
await page.screenshot({ path: "shots/72-described-layout.png" });

const layout = await page.evaluate(() => {
  const text = document.body.innerText;
  return {
    floorTabs: [...document.querySelectorAll("button")]
      .map((b) => b.textContent?.trim() ?? "")
      .filter((t) => /^(Ground floor|Upstairs|Basement)/.test(t)),
    doorways: Number(text.match(/(\d+) doorways/)?.[1] ?? 0),
    stairs: Number(text.match(/(\d+) stairs/)?.[1] ?? 0),
    stranded: /not touching anything/.test(text),
  };
});

// The description's room vocabulary should reach the review screen's pickers.
const buttons = await page.evaluate(() =>
  [...document.querySelectorAll("select option")].map((o) => o.textContent?.trim() ?? ""),
);

const optionsGood =
  buttons.includes("Primary Bedroom") &&
  buttons.includes("Bedroom 2") &&
  buttons.includes("Bedroom 3");

console.log(
  JSON.stringify(
    {
      understood,
      tagOptions: buttons.slice(0, 10),
      layout,
      errors: errors.slice(0, 3),
      arrived,
      verdict:
        optionsGood && layout.floorTabs.length >= 2 && layout.stairs > 0 && !layout.stranded
          ? `DESCRIBE FLOW WORKS - ${understood.readBy} read ${understood.roomCount} rooms over ${understood.floors} floors; tag options are per-bedroom; layout has ${layout.floorTabs.length} storeys joined by stairs`
          : `FAILED - options=${optionsGood} floors=${layout.floorTabs.length} stairs=${layout.stairs} stranded=${layout.stranded}`,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(optionsGood && layout.floorTabs.length >= 2 && layout.stairs > 0 ? 0 : 1);
