/**
 * A tour downloads nothing from anyone else.
 *
 * The procedural textures were built to keep that promise, and the bundled
 * scans are allowed on the condition that they are shipped with the app.
 * This opens the showcase from the street and on foot, watches every request
 * the page makes, and fails on the first one that leaves this origin. It
 * also checks the scans actually arrived - a promise kept by loading nothing
 * would be no promise at all.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const origin = new URL(BASE).origin;
const foreign = [];
const textures = new Set();
page.on("request", (req) => {
  const url = req.url();
  if (url.startsWith("data:") || url.startsWith("blob:")) return;
  if (!url.startsWith(origin)) foreign.push(url);
  else if (url.includes("/textures/") || url.includes("/sky/")) textures.add(new URL(url).pathname);
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const settled = async () => {
  await page.waitForFunction(() => window.__scene && window.__scene.mode, { timeout: 90_000 });
  // The suites draw with a software renderer, which is given the bottom
  // tier and loads no scans. This suite is about the scans.
  await page.selectOption('select[aria-label="Render quality"]', "medium");
  // Until every set that was asked for has landed, and a moment more.
  await page.waitForFunction(() => window.__scene && window.__scene.pending === 0, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
};

await page.goto(`${BASE}/tour/showcase`, { waitUntil: "networkidle" });
await settled();
const street = await page.evaluate(() => window.__scene);
await page.goto(`${BASE}/tour/showcase?room=kitchen`, { waitUntil: "networkidle" });
await settled();
const kitchen = await page.evaluate(() => window.__scene);

check("nothing left this origin", foreign.length === 0, foreign.slice(0, 3).join(" | "));
check("the bundled scans were fetched from here", textures.size > 0, `${textures.size} files`);
check("and are on the model from the street", (street.bundledTextures ?? 0) > 0, `${street.bundledTextures}`);
check("and on foot", (kitchen.bundledTextures ?? 0) > 0, `${kitchen.bundledTextures}`);
check("no photograph of the house is on it", street.photoTextures === 0 && kitchen.photoTextures === 0, `${street.photoTextures}/${kitchen.photoTextures}`);
check("every set that was asked for arrived", street.pending === 0 && kitchen.pending === 0);
check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(
  failures === 0
    ? `OFFLINE OK - ${textures.size} bundled files, ${street.bundledTextures} scanned surfaces from the street, nothing from anyone else`
    : `OFFLINE BROKEN - ${failures} failure(s)`,
);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
