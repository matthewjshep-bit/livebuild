/**
 * No photograph is ever drawn in the model.
 *
 * This is the one promise the whole direction of the project rests on: the
 * pictures are evidence the house was built from, not something hung inside
 * it. It is also exactly the kind of promise that comes back by accident - a
 * texture assigned from a node's `photo`, a shell component restored from
 * history - and when it does, the model still renders, so nothing fails.
 *
 * So it is checked mechanically rather than by looking. The scene readout
 * counts materials whose colour map has an image with a `src`, which is what a
 * photograph loaded from a blob or a URL has and what the procedural canvas
 * textures - generated in the page, never fetched - do not.
 *
 * Checked in every mode, because the shells used to be mounted by proximity
 * and by the scripted tour, not by the view alone.
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const readings = [];

async function check(label, route, after) {
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  await page.waitForSelector("canvas", { timeout: 20_000 });
  await page.waitForFunction(() => window.__scene !== undefined, { timeout: 20_000 });
  if (after) await after();
  await page.waitForTimeout(2500);
  const scene = await page.evaluate(() => window.__scene);
  readings.push({
    label,
    mode: scene.mode,
    photoTextures: scene.photoTextures,
    meshes: scene.meshes,
    triangles: scene.triangles,
  });
}

await check("dollhouse", "/tour/demo-house");
await check("walk", "/tour/demo-house?room=kitchen");
await check("two-storey", "/tour/two-storey");
// The scripted tour used to be the one path that deliberately parked the
// camera inside a photograph, so it is the most likely place for one to return.
await check("scripted tour", "/tour/demo-house", async () => {
  await page.locator("[data-tour-toggle]").click();
  await page.waitForTimeout(4000);
});

const offenders = readings.filter((r) => r.photoTextures !== 0);
const rendered = readings.every((r) => r.meshes > 0 && r.triangles > 0);
const ok = offenders.length === 0 && rendered && errors.length === 0;

console.log(JSON.stringify({
  readings,
  errors,
  verdict: ok
    ? `NO PHOTOS IN THE MODEL - ${readings.length} views checked, all built geometry`
    : offenders.length
      ? `PHOTOS ARE BACK - ${offenders.map((o) => `${o.label}: ${o.photoTextures}`).join(", ")}`
      : "FAILED - a view rendered nothing at all",
}, null, 2));

await browser.close();
process.exit(ok ? 0 : 1);
