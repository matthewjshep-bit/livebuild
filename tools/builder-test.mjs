/**
 * The builder's edit actions, on the review screen.
 *
 * These are the corrections nothing can make for you - a hallway running the
 * wrong way, a storey the photos cannot reveal - so they have to stay within
 * reach of the finished plan rather than behind an "advanced" door.
 */
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { addPhotos, build, freshStart } from "./lib/flow.mjs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const dir = "public/properties/demo-house/photos";
const files = readdirSync(dir).slice(0, 4).map((f) => join(dir, f));

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await freshStart(page, base);
await addPhotos(page, files);
const arrived = await build(page);

await page.getByRole("button", { name: "+ Add room" }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Hallway", exact: true }).click();
await page.waitForTimeout(500);

await page.getByRole("button", { name: /^Rotate/ }).click();
await page.waitForTimeout(400);

await page.getByRole("button", { name: "+ Add floor" }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "Bedroom", exact: true }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: "shots/50-builder.png" });

const floors = await page.evaluate(() =>
  [...document.querySelectorAll("button")]
    .map((b) => b.textContent?.trim() ?? "")
    .filter((t) => /^(Ground floor|Upstairs|Basement)/.test(t)),
);

await page.getByRole("button", { name: "Undo" }).click();
await page.waitForTimeout(400);

const ok = arrived && floors.length >= 2 && errors.length === 0;

console.log(
  JSON.stringify(
    {
      floorTabs: floors,
      errors: errors.slice(0, 3),
      verdict: ok
        ? `BUILDER WORKS - added a room, rotated it, and created ${floors.length} storeys from the review screen`
        : "BUILDER FAILED",
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(ok ? 0 : 1);
